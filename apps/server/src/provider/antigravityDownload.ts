// @effect-diagnostics nodeBuiltinImport:off - Effect has no incremental digest or atomic empty-directory removal.
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import * as Predicate from "effect/Predicate";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import { lock } from "proper-lockfile";

export interface AntigravityDownloadSettings {
  readonly segmentBytes: number;
  readonly concurrency: number;
  /** Backoff between attempts of one segment; each retry resumes from the bytes already written. */
  readonly retrySchedule: Schedule.Schedule<unknown>;
}

// Google's storage throttles each connection; 16 x 4 MiB segments measured 6-10x one stream.
export const DEFAULT_DOWNLOAD_SETTINGS: AntigravityDownloadSettings = {
  segmentBytes: 4 * 1024 * 1024,
  concurrency: 16,
  retrySchedule: Schedule.exponential("1 second"),
};

const STALL_TIMEOUT = "60 seconds";
const SEGMENT_RETRIES = 5;
const CONTENT_RANGE = /^bytes (\d+)-(\d+)\/(\d+)$/u;
const LOCK_SUFFIX = ".lock";

export class AntigravityDownloadError extends Schema.TaggedError<AntigravityDownloadError>()(
  "AntigravityDownloadError",
  {
    detail: Schema.String,
    retryable: Schema.Boolean,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return this.detail;
  }
}

const downloadError = (detail: string, retryable = false, cause?: unknown) =>
  new AntigravityDownloadError({
    detail,
    retryable,
    ...(cause === undefined ? {} : { cause }),
  });

const tooLarge = () => downloadError("The Antigravity download exceeded its allowed size.");

const isTransient = (
  error:
    | AntigravityDownloadError
    | HttpClientError.HttpClientError
    | Cause.TimeoutError
    | PlatformError,
) => {
  if (error._tag === "TimeoutError") return true;
  if (error._tag === "AntigravityDownloadError") return error.retryable;
  if (error._tag === "PlatformError") return false;
  // Body bytes are read raw, so a DecodeError is a body that failed after the host answered.
  if (error.reason._tag === "DecodeError" || error.reason._tag === "TransportError") return true;
  const status = error.response?.status;
  return status !== undefined && (status >= 500 || status === 429 || status === 408);
};

const parseContentRange = (header: string | undefined) => {
  const match = CONTENT_RANGE.exec(header ?? "");
  if (match === null) return null;
  return { start: Number(match[1]), end: Number(match[2]), total: Number(match[3]) };
};

const contentLength = (response: HttpClientResponse.HttpClientResponse) => {
  const length = Number(response.headers["content-length"]);
  return Number.isSafeInteger(length) && length > 0 ? length : null;
};

const stalls = <A, E, R>(stream: Stream.Stream<A, E, R>) =>
  stream.pipe(
    Stream.timeoutOrElse({
      duration: STALL_TIMEOUT,
      orElse: () => Stream.fail(new Cause.TimeoutError()),
    }),
  );

const lockCache = (cacheDirectory: string) =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: () =>
        lock(cacheDirectory, {
          realpath: false,
          stale: 30_000,
          update: 10_000,
          onCompromised: () => {},
        }),
      catch: (cause) =>
        downloadError(
          Predicate.isObject(cause) &&
            Predicate.hasProperty(cause, "code") &&
            cause.code === "ELOCKED"
            ? "Another Antigravity download is already in progress. Try again."
            : "Could not lock the Antigravity download cache. Try again.",
          false,
          cause,
        ),
    }),
    (release) => Effect.promise(() => release().catch(() => undefined)),
  );

/** Links are removed rather than followed, so cache cleanup can never reach outside the cache. */
const isLink = (fs: FileSystem.FileSystem, target: string) =>
  fs.readLink(target).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );

const ensureRealDirectory = Effect.fn("AntigravityDownload.ensureRealDirectory")(function* (
  directory: string,
) {
  const fs = yield* FileSystem.FileSystem;
  if (yield* isLink(fs, directory)) yield* fs.remove(directory, { force: true });
  const info = yield* fs.stat(directory).pipe(Effect.option);
  if (Option.isSome(info) && info.value.type !== "Directory") {
    yield* fs.remove(directory, { recursive: true, force: true });
  }
  yield* fs.makeDirectory(directory, { recursive: true });
});

// A cancel must not release the cache lock while an issued `rm` can still delete another holder's files.
const removeHeld = (
  fs: FileSystem.FileSystem,
  target: string,
  options: { readonly recursive?: boolean; readonly force?: boolean },
) => fs.remove(target, options).pipe(Effect.uninterruptible);

const removeIfEmpty = (directory: string) =>
  Effect.promise(() => NodeFSP.rmdir(directory).catch(() => undefined));

/**
 * Deletes one release's cached segments unless another download holds them. `rm` does not follow
 * links, so a planted link loses only itself.
 */
export const removeDownloadCache = Effect.fn("AntigravityDownload.removeCache")(
  function* (cacheDirectory: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const locked = yield* lockCache(cacheDirectory).pipe(Effect.option);
        if (Option.isSome(locked)) {
          yield* removeHeld(fs, cacheDirectory, { recursive: true, force: true });
        }
      }),
    );
    // The lock directory sits beside the cache, so the parent can only empty once it is released.
    yield* removeIfEmpty(path.dirname(cacheDirectory));
  },
  (effect) => Effect.ignore(effect),
);

/** Only one release is ever wanted, so segments cached for any other release are dead weight. */
export const pruneDownloadCaches = Effect.fn("AntigravityDownload.pruneCaches")(
  function* (downloadsDirectory: string, keep: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (yield* isLink(fs, downloadsDirectory)) {
      return yield* fs.remove(downloadsDirectory, { force: true });
    }
    // Locks are reclaimed only through the lock protocol: taking a stale lock and releasing it
    // removes the lock directory, while a live holder's lock stays.
    const caches = new Set(
      (yield* fs.readDirectory(downloadsDirectory)).map((entry) =>
        entry.endsWith(LOCK_SUFFIX) ? entry.slice(0, -LOCK_SUFFIX.length) : entry,
      ),
    );
    caches.delete(keep);
    for (const cache of caches) {
      yield* removeDownloadCache(path.join(downloadsDirectory, cache));
    }
    yield* removeIfEmpty(downloadsDirectory);
  },
  (effect) => Effect.ignore(effect),
);

interface Segment {
  readonly start: number;
  readonly end: number;
  readonly file: string;
  held: number;
}

export interface AntigravityDownloadInput {
  readonly url: string;
  readonly expectedSha512: string;
  /** One directory per platform and asset digest; segments there survive cancels and restarts. */
  readonly cacheDirectory: string;
  readonly destination: string;
  readonly maxBytes: number;
  readonly settings: AntigravityDownloadSettings;
  readonly onProgress: (downloadedBytes: number, totalBytes: number | null) => Effect.Effect<void>;
}

/**
 * Downloads into `destination` and returns its SHA-512. Servers that honour Range get bounded
 * parallel segments cached in `cacheDirectory`; servers that ignore it get one uncached stream.
 * Cached segments that merge to the wrong digest are discarded before the cache lock is released.
 */
export const downloadAntigravityAsset = Effect.fn("AntigravityDownload.download")(function* (
  input: AntigravityDownloadInput,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const http = yield* HttpClient.HttpClient;
  // Responses close with their owning scope, including those rejected before their body is read.
  const client = HttpClient.withScope(http);
  const request = HttpClientRequest.get(input.url);
  const probe = yield* client
    .execute(HttpClientRequest.setHeader(request, "range", "bytes=0-0"))
    .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk), Effect.timeout(STALL_TIMEOUT));

  if (probe.status !== 206) {
    const hash = NodeCrypto.createHash("sha512");
    const totalBytes = contentLength(probe);
    if (totalBytes !== null && totalBytes > input.maxBytes) return yield* tooLarge();
    let downloadedBytes = 0;
    yield* input.onProgress(0, totalBytes);
    yield* probe.stream.pipe(
      Stream.tap((chunk) =>
        Effect.gen(function* () {
          downloadedBytes += chunk.byteLength;
          if (downloadedBytes > input.maxBytes) return yield* tooLarge();
          hash.update(chunk);
          yield* input.onProgress(downloadedBytes, totalBytes);
        }),
      ),
      Stream.run(fs.sink(input.destination, { flag: "wx", mode: 0o600 })),
    );
    return hash.digest("hex");
  }

  const probed = parseContentRange(probe.headers["content-range"]);
  if (probed === null || probed.start !== 0 || probed.end !== 0 || probed.total <= 0) {
    return yield* downloadError("Google answered the Antigravity download with an invalid range.");
  }
  const total = probed.total;
  if (total > input.maxBytes) return yield* tooLarge();
  let probeBytes = 0;
  yield* stalls(probe.stream).pipe(
    Stream.runForEach((chunk) => {
      probeBytes += chunk.byteLength;
      return probeBytes > 1
        ? downloadError("Google answered the Antigravity download with an invalid range.")
        : Effect.void;
    }),
  );

  yield* ensureRealDirectory(path.dirname(input.cacheDirectory));
  yield* ensureRealDirectory(input.cacheDirectory);
  // Two servers sharing a base directory must not append to the same segment files.
  yield* lockCache(input.cacheDirectory);

  const segments: Array<Segment> = [];
  for (let start = 0; start < total; start += input.settings.segmentBytes) {
    const end = Math.min(start + input.settings.segmentBytes, total) - 1;
    segments.push({
      start,
      end,
      file: path.join(input.cacheDirectory, `${start}-${end}.part`),
      held: 0,
    });
  }
  // Segment names carry their byte range, so files from another size or split are stale.
  const expected = new Set(segments.map((segment) => path.basename(segment.file)));
  for (const entry of yield* fs.readDirectory(input.cacheDirectory)) {
    if (!expected.has(entry)) {
      yield* removeHeld(fs, path.join(input.cacheDirectory, entry), {
        recursive: true,
        force: true,
      });
    }
  }

  // Only unshared regular files resume. A link, hard link, or special file in their place is
  // unlinked from the cache and never opened, so appends cannot reach a file outside it.
  const heldBytes = Effect.fn("AntigravityDownload.heldBytes")(function* (segment: Segment) {
    if (yield* isLink(fs, segment.file)) {
      yield* removeHeld(fs, segment.file, { force: true });
      return 0;
    }
    const info = yield* fs.stat(segment.file).pipe(Effect.option);
    if (Option.isNone(info)) return 0;
    const size = Number(info.value.size);
    const links = Option.getOrElse(info.value.nlink, () => 1n);
    if (info.value.type === "File" && links === 1n && size <= segment.end - segment.start + 1) {
      return size;
    }
    yield* removeHeld(fs, segment.file, { recursive: true, force: true });
    return 0;
  });

  let downloadedBytes = 0;
  for (const segment of segments) {
    segment.held = yield* heldBytes(segment);
    downloadedBytes += segment.held;
  }
  yield* input.onProgress(downloadedBytes, total);

  const fetchSegment = Effect.fn("AntigravityDownload.fetchSegment")(
    function* (segment: Segment) {
      // Re-read the file each attempt so progress follows the bytes actually written.
      const held = yield* heldBytes(segment);
      downloadedBytes += held - segment.held;
      segment.held = held;
      const length = segment.end - segment.start + 1;
      if (held === length) return;
      const from = segment.start + held;
      const response = yield* client
        .execute(HttpClientRequest.setHeader(request, "range", `bytes=${from}-${segment.end}`))
        .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk), Effect.timeout(STALL_TIMEOUT));
      const range = parseContentRange(response.headers["content-range"]);
      if (
        response.status !== 206 ||
        range === null ||
        range.start !== from ||
        range.end !== segment.end ||
        range.total !== total
      ) {
        return yield* downloadError(
          "Google answered an Antigravity download segment with the wrong range.",
        );
      }
      const file = yield* fs.open(segment.file, { flag: "a", mode: 0o600 });
      yield* stalls(response.stream).pipe(
        Stream.runForEach((chunk) =>
          Effect.gen(function* () {
            if (segment.held + chunk.byteLength > length) {
              return yield* downloadError(
                "Google sent more bytes than an Antigravity download segment holds.",
              );
            }
            // A cancel must not close the file or release the cache lock under an issued write,
            // or a later install could resume from a length that is about to grow.
            yield* file.writeAll(chunk).pipe(Effect.uninterruptible);
            segment.held += chunk.byteLength;
            downloadedBytes += chunk.byteLength;
            yield* input.onProgress(downloadedBytes, total);
          }),
        ),
      );
      if (segment.held < length) {
        return yield* downloadError("An Antigravity download segment ended early.", true);
      }
    },
    Effect.scoped,
    Effect.retry({
      times: SEGMENT_RETRIES,
      schedule: input.settings.retrySchedule,
      while: isTransient,
    }),
  );

  yield* Effect.forEach(segments, fetchSegment, {
    concurrency: input.settings.concurrency,
    discard: true,
  });

  const hash = NodeCrypto.createHash("sha512");
  yield* Stream.fromIterable(segments).pipe(
    Stream.flatMap((segment) => fs.stream(segment.file)),
    Stream.tap((chunk) => Effect.sync(() => hash.update(chunk))),
    Stream.run(fs.sink(input.destination, { flag: "wx", mode: 0o600 })),
  );
  const digest = hash.digest("hex");
  if (digest !== input.expectedSha512) {
    yield* removeHeld(fs, input.cacheDirectory, { recursive: true, force: true });
  }
  return digest;
}, Effect.scoped);
