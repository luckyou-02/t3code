import * as HostProcess from "@t3tools/shared/HostProcess";

import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

export const ChromiumKeyFailure = Schema.Literals([
  "keychainUnavailable",
  "unsupportedPlatform",
  "readFailed",
]);
export type ChromiumKeyFailure = typeof ChromiumKeyFailure.Type;

export class ChromiumKeyError extends Schema.TaggedError<ChromiumKeyError>()("ChromiumKeyError", {
  reason: ChromiumKeyFailure,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Could not obtain the Chromium cookie key: ${this.reason}.`;
  }
}

export interface ChromiumKeyMaterial {
  readonly gcmV10?: Buffer;
}

const WindowsLocalState = Schema.Struct({
  os_crypt: Schema.Struct({
    encrypted_key: Schema.String,
    app_bound_encrypted_key: Schema.optional(Schema.String),
  }),
});
const decodeWindowsLocalState = Schema.decodeUnknownEffect(
  Schema.fromJsonString(WindowsLocalState),
);
const DPAPI_PREFIX = Buffer.from("DPAPI");
const WINDOWS_KEY_LENGTH = 32;
const WINDOWS_DPAPI_SCRIPT =
  "Add-Type -AssemblyName System.Security;" +
  "$value=[Console]::In.ReadToEnd();" +
  "$encrypted=[Convert]::FromBase64String($value);" +
  "$plain=[Security.Cryptography.ProtectedData]::Unprotect($encrypted,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);" +
  "[Console]::Out.Write([Convert]::ToBase64String($plain))";

export const decodeWindowsWrappedKey = Effect.fn("ChromiumKeys.decodeWindowsWrappedKey")(function* (
  contents: string,
) {
  const state = yield* decodeWindowsLocalState(contents).pipe(
    Effect.mapError((cause) => new ChromiumKeyError({ reason: "readFailed", cause })),
  );
  if (state.os_crypt.app_bound_encrypted_key !== undefined) {
    return yield* new ChromiumKeyError({ reason: "unsupportedPlatform" });
  }
  const wrapped = yield* Effect.fromResult(Base64.decode(state.os_crypt.encrypted_key)).pipe(
    Effect.mapError((cause) => new ChromiumKeyError({ reason: "readFailed", cause })),
  );
  const wrappedBuffer = Buffer.from(wrapped);
  if (!wrappedBuffer.subarray(0, DPAPI_PREFIX.length).equals(DPAPI_PREFIX)) {
    return yield* new ChromiumKeyError({ reason: "readFailed" });
  }
  return wrappedBuffer.subarray(DPAPI_PREFIX.length);
});

export const unwrapWindowsDpapiKey = Effect.fn("ChromiumKeys.unwrapWindowsDpapiKey")(function* (
  wrapped: Buffer,
) {
  const environment = yield* HostProcess.Environment;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const windowsRoot = environment.SystemRoot ?? environment.WINDIR;
      const powershell = windowsRoot
        ? `${windowsRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
        : "powershell.exe";
      const handle = yield* spawner
        .spawn(
          ChildProcess.make(
            powershell,
            [
              "-NoLogo",
              "-NoProfile",
              "-NonInteractive",
              "-WindowStyle",
              "Hidden",
              "-Command",
              WINDOWS_DPAPI_SCRIPT,
            ],
            {
              env: environment,
              stdin: Stream.encodeText(Stream.make(wrapped.toString("base64"))),
            },
          ),
        )
        .pipe(
          Effect.mapError(
            (cause) => new ChromiumKeyError({ reason: "keychainUnavailable", cause }),
          ),
        );
      const [plainEncoded, , exitCode] = yield* Effect.all(
        [
          handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
          handle.stderr.pipe(Stream.runDrain),
          handle.exitCode,
        ],
        { concurrency: "unbounded" },
      ).pipe(Effect.mapError((cause) => new ChromiumKeyError({ reason: "readFailed", cause })));
      if (Number(exitCode) !== 0) {
        return yield* new ChromiumKeyError({ reason: "readFailed" });
      }
      const plain = yield* Effect.fromResult(Base64.decode(plainEncoded)).pipe(
        Effect.mapError((cause) => new ChromiumKeyError({ reason: "readFailed", cause })),
      );
      if (plain.length !== WINDOWS_KEY_LENGTH) {
        return yield* new ChromiumKeyError({ reason: "readFailed" });
      }
      return Buffer.from(plain);
    }),
  );
});

export const readWindowsKey = Effect.fn("ChromiumKeys.readWindowsKey")(function* (
  localStatePath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const contents = yield* fileSystem
    .readFileString(localStatePath)
    .pipe(Effect.mapError((cause) => new ChromiumKeyError({ reason: "readFailed", cause })));
  return yield* unwrapWindowsDpapiKey(yield* decodeWindowsWrappedKey(contents));
});
