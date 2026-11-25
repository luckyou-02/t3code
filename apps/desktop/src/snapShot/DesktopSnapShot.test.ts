import { assert, it } from "@effect/vitest";
import {
  DEFAULT_CLIENT_SETTINGS,
  DesktopPendingSnapShot,
  type ClientSettings,
  type DesktopSnapShotEvent,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import type * as Electron from "electron";
import { beforeEach, vi } from "vite-plus/test";

beforeEach(() => {
  transitionCapturePageMock.mockReset().mockResolvedValue(undefined);
  transitionSnapshotMock.mockReset().mockResolvedValue(undefined);
  prepareCaptureRevealMock.mockReset();
});

const {
  activeWindowMock,
  animationSettingsMock,
  accessibilityProcessWarmMock,
  accessibilityProcessCloseMock,
  accessibilityProcessCoolMock,
  accessibilityProcessReadMock,
  accessibilityForegroundMock,
  allWindowsMock,
  flashWindows,
  focusedWindowMock,
  getFileIconMock,
  registerShortcutMock,
  unregisterShortcutMock,
  prepareCaptureRevealMock,
  regionCaptureMock,
  screenToDipRectMock,
  shortcutForkArgs,
  shortcutForkOptions,
  shortcutProcesses,
  transitionCapturePageMock,
  transitionScriptState,
  transitionShowMock,
  transitionSnapshotMock,
} = vi.hoisted(() => ({
  activeWindowMock: vi.fn(),
  animationSettingsMock: vi.fn(() => ({
    prefersReducedMotion: true,
    shouldRenderRichAnimation: false,
  })),
  accessibilityProcessWarmMock: vi.fn(),
  accessibilityProcessCloseMock: vi.fn(),
  accessibilityProcessCoolMock: vi.fn(),
  accessibilityProcessReadMock: vi.fn<
    (request: import("./SnapShotAccessibility.ts").SnapShotAccessibilityRequest) => {
      started: Promise<void>;
      result: Promise<
        import("./SnapShotAccessibility.ts").CapturedWindowAccessibilityContext | undefined
      >;
    }
  >(),
  accessibilityForegroundMock: vi.fn(),
  allWindowsMock: vi.fn(
    () =>
      [] as Array<{
        getBounds: () => Electron.Rectangle;
        isDestroyed: () => boolean;
      }>,
  ),
  flashWindows: [] as Array<{
    bounds: Electron.Rectangle | null;
    destroyed: boolean;
    kind: "base" | "browser";
    loadCount: number;
    loadedUrls: Array<string>;
    opacities: Array<number>;
    options: Electron.BrowserWindowConstructorOptions;
    scripts: Array<string>;
    capturedRegions: Array<Electron.Rectangle>;
    showCount: number;
    resizeCount: number;
    alwaysOnTopCalls: Array<[boolean, string | undefined]>;
  }>,
  focusedWindowMock: vi.fn(),
  getFileIconMock: vi.fn(),
  registerShortcutMock: vi.fn(),
  unregisterShortcutMock: vi.fn(),
  prepareCaptureRevealMock: vi.fn(),
  regionCaptureMock:
    vi.fn<
      (region: Electron.Rectangle) => Promise<{ width: number; height: number; png: Buffer }>
    >(),
  screenToDipRectMock: vi.fn((_window: unknown, bounds: Electron.Rectangle) => bounds),
  shortcutForkArgs: [] as Array<ReadonlyArray<string>>,
  shortcutForkOptions: [] as Array<{ env?: NodeJS.ProcessEnv }>,
  shortcutProcesses: [] as Array<{
    emit: (event: string, value?: unknown) => void;
    kill: ReturnType<typeof vi.fn>;
    on: (event: string, listener: (value: unknown) => void) => unknown;
    once: (event: string, listener: (value: unknown) => void) => unknown;
  }>,
  transitionCapturePageMock: vi.fn<() => Promise<void>>(),
  transitionScriptState: {
    rejectFlight: false,
    heldFlights: null as Array<() => void> | null,
  },
  transitionShowMock: vi.fn(),
  transitionSnapshotMock: vi.fn<() => Promise<void>>(),
}));

vi.mock("./SnapShotAccessibilityProcess.ts", () => ({
  makeSnapShotAccessibilityProcessPool: () => ({
    warm: accessibilityProcessWarmMock,
    cool: accessibilityProcessCoolMock,
    read: accessibilityProcessReadMock,
    close: accessibilityProcessCloseMock,
  }),
}));
vi.mock("./ActiveWindow.ts", () => ({ activeWindow: activeWindowMock }));
vi.mock("./RegionSnapShot.ts", async (original) => ({
  ...(await original<typeof import("./RegionSnapShot.ts")>()),
  makeRegionSnapShotPool: () => ({
    warm: vi.fn(),
    cool: vi.fn(),
    close: vi.fn(),
    capture: regionCaptureMock,
  }),
}));
vi.mock("./WindowsCaptureFeedback.ts", () => ({
  showWindowsCaptureOverlay: (window: Electron.BaseWindow) => window.showInactive(),
}));
vi.mock("node:child_process", () => ({
  fork: (_path: string, args: ReadonlyArray<string>, options: { env?: NodeJS.ProcessEnv }) => {
    const listeners = new Map<string, Array<(value: unknown) => void>>();
    const process = {
      emit: (event: string, value?: unknown) => {
        for (const listener of listeners.get(event) ?? []) listener(value);
      },
      kill: vi.fn(() => true),
      on: (event: string, listener: (value: unknown) => void) => {
        listeners.set(event, [...(listeners.get(event) ?? []), listener]);
        return process;
      },
      once: (event: string, listener: (value: unknown) => void) => {
        const wrapped = (value: unknown) => {
          listeners.set(
            event,
            (listeners.get(event) ?? []).filter((candidate) => candidate !== wrapped),
          );
          listener(value);
        };
        listeners.set(event, [...(listeners.get(event) ?? []), wrapped]);
        return process;
      },
    };
    shortcutForkArgs.push(args);
    shortcutForkOptions.push(options);
    shortcutProcesses.push(process);
    queueMicrotask(() => process.emit("message", "ready"));
    return process;
  },
}));
vi.mock("electron", () => {
  class BaseWindow {
    protected readonly state: (typeof flashWindows)[number];

    constructor(options: Electron.BrowserWindowConstructorOptions) {
      this.state = {
        bounds:
          options.x === undefined ||
          options.y === undefined ||
          options.width === undefined ||
          options.height === undefined
            ? null
            : { x: options.x, y: options.y, width: options.width, height: options.height },
        destroyed: false,
        kind: "base",
        loadCount: 0,
        loadedUrls: [],
        opacities: options.opacity === undefined ? [] : [options.opacity],
        options,
        scripts: [],
        capturedRegions: [],
        showCount: 0,
        resizeCount: 0,
        alwaysOnTopCalls: [],
      };
      flashWindows.push(this.state);
    }

    destroy() {
      this.state.destroyed = true;
    }

    getBounds() {
      return this.state.bounds;
    }

    isDestroyed() {
      return this.state.destroyed;
    }

    setBounds(bounds: Electron.Rectangle) {
      this.state.resizeCount++;
      this.state.bounds = bounds;
    }

    setIgnoreMouseEvents() {}

    setOpacity(opacity: number) {
      this.state.opacities.push(opacity);
    }

    setAlwaysOnTop(flag: boolean, level?: string) {
      this.state.alwaysOnTopCalls.push([flag, level]);
    }

    showInactive() {
      const shownBounds = transitionShowMock(this.state.bounds);
      if (shownBounds !== undefined) this.state.bounds = shownBounds;
      this.state.showCount += 1;
    }
  }

  class BrowserWindow extends BaseWindow {
    static getFocusedWindow() {
      return focusedWindowMock();
    }

    static getAllWindows() {
      return allWindowsMock();
    }

    readonly webContents;

    constructor(options: Electron.BrowserWindowConstructorOptions) {
      super(options);
      this.state.kind = "browser";
      this.webContents = {
        executeJavaScript: async (script: string) => {
          this.state.scripts.push(script);
          if (script.startsWith("window.setCaptureSnapshot")) {
            await transitionSnapshotMock();
          }
          if (script !== "window.playCaptureTransition()") return;
          if (transitionScriptState.rejectFlight) {
            transitionScriptState.rejectFlight = false;
            throw new Error("transition failed");
          }
          const held = transitionScriptState.heldFlights;
          if (held) await new Promise<void>((resolve) => held.push(resolve));
        },
        capturePage: async (bounds: Electron.Rectangle) => {
          this.state.capturedRegions.push(bounds);
          await transitionCapturePageMock();
        },
      };
    }

    loadURL(url: string) {
      this.state.loadCount += 1;
      this.state.loadedUrls.push(url);
      return Promise.resolve();
    }
  }

  return {
    BaseWindow,
    BrowserWindow,
    app: { getFileIcon: getFileIconMock },
    globalShortcut: { register: registerShortcutMock, unregister: unregisterShortcutMock },
    screen: {
      getDisplayMatching: (bounds: Electron.Rectangle) =>
        bounds.x < 0
          ? { id: 1, bounds: { x: -1_920, y: 0, width: 1_920, height: 1_080 } }
          : { id: 2, bounds: { x: 0, y: -200, width: 1_440, height: 900 } },
      getAllDisplays: () => [
        { id: 1, bounds: { x: -1_920, y: 0, width: 1_920, height: 1_080 } },
        { id: 2, bounds: { x: 0, y: -200, width: 1_440, height: 900 } },
      ],
      getCursorScreenPoint: () => ({ x: 500, y: 500 }),
      getDisplayNearestPoint: () => ({
        bounds: { x: 100, y: 100, width: 800, height: 600 },
      }),
      getPrimaryDisplay: () => ({ bounds: { x: 0, y: 0, width: 1_440, height: 900 } }),
      screenToDipRect: screenToDipRectMock,
    },
    systemPreferences: {
      getAnimationSettings: () => animationSettingsMock(),
    },
  };
});

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as DesktopSnapShot from "./DesktopSnapShot.ts";
import * as SnapShotAccessibility from "./SnapShotAccessibility.ts";
import { SnapShotTransition, snapShotAnimationDisplayBounds } from "./SnapShotTransition.ts";

const accessibilityApp = {
  foreground: accessibilityForegroundMock,
} as unknown as Parameters<typeof SnapShotAccessibility.readAccessibleWindowContextWithApp>[0];
const readAccessibleWindowContext = (
  active: SnapShotAccessibility.AccessibleWindowIdentity,
  sourceTitle: string,
  imageSize: Electron.Size = {
    width: Math.max(1, Math.round(active.bounds.width)),
    height: Math.max(1, Math.round(active.bounds.height)),
  },
) =>
  SnapShotAccessibility.readAccessibleWindowContextWithApp(accessibilityApp, {
    active,
    sourceTitle,
    imageSize,
  });
const readAccessibleWindowText = async (
  active: SnapShotAccessibility.AccessibleWindowIdentity,
  sourceTitle: string,
) => (await readAccessibleWindowContext(active, sourceTitle))?.accessibleText;
accessibilityProcessReadMock.mockImplementation((request) => ({
  started: Promise.resolve(),
  result: readAccessibleWindowContext(request.active, request.sourceTitle, request.imageSize),
}));

const decodePendingMetadata = Schema.decodeUnknownEffect(
  Schema.fromJsonString(DesktopPendingSnapShot),
);

const layerTest = (
  platform: NodeJS.Platform,
  fileSystemOverrides: Parameters<typeof FileSystem.layerNoop>[0] = {},
  initialSettings: Option.Option<ClientSettings> = Option.none(),
  settingsGet: Effect.Effect<
    Option.Option<ClientSettings>,
    DesktopClientSettings.DesktopClientSettingsReadError
  > = Effect.succeed(initialSettings),
) =>
  Layer.mergeAll(
    Layer.succeed(
      DesktopEnvironment.DesktopEnvironment,
      DesktopEnvironment.DesktopEnvironment.of({
        platform,
        displayName: "T3 Code (Dev)",
        stateDir: "/state",
        appRoot: "/repo",
      } as DesktopEnvironment.DesktopEnvironment["Service"]),
    ),
    Layer.succeed(
      DesktopClientSettings.DesktopClientSettings,
      DesktopClientSettings.DesktopClientSettings.of({
        get: settingsGet,
        set: () => Effect.void,
      }),
    ),
    Layer.succeed(
      DesktopWindow.DesktopWindow,
      DesktopWindow.DesktopWindow.of({
        activate: Effect.void,
        prepareCaptureReveal: Effect.sync(prepareCaptureRevealMock),
        dispatchMenuAction: () => Effect.void,
        dispatchSnapShotEvent: () => Effect.void,
      } as unknown as DesktopWindow.DesktopWindow["Service"]),
    ),
    FileSystem.layerNoop(fileSystemOverrides),
    Path.layer,
    Layer.succeed(
      SecureRandom.SecureRandom,
      SecureRandom.make((size) => new Uint8Array(size)),
    ),
  );

const enabledSettings = (overrides: Partial<ClientSettings> = {}): ClientSettings => ({
  ...DEFAULT_CLIENT_SETTINGS,
  snapShotEnabled: true,
  ...overrides,
});

function concurrentCaptureFixture(animations: boolean) {
  focusedWindowMock.mockReturnValue(undefined);
  allWindowsMock.mockReturnValue([]);
  registerShortcutMock.mockReset().mockReturnValue(true);
  animationSettingsMock.mockReturnValue({
    prefersReducedMotion: false,
    shouldRenderRichAnimation: true,
  });
  flashWindows.length = 0;
  const captures = ["Discord", "File Explorer", "Terminal"].map((title, index) => ({
    title,
    id: index + 42,
    processId: index + 100,
    png: Buffer.from([index, index + 1, index + 2]),
    started: Promise.withResolvers<void>(),
    pixels: Promise.withResolvers<void>(),
    handoff: Promise.withResolvers<void>(),
    context: Promise.withResolvers<SnapShotAccessibility.CapturedWindowAccessibilityContext>(),
    oldOverlaysCleared: false,
  }));
  const [first, second, extra] = captures;
  extra!.pixels.resolve();
  extra!.context.resolve({ accessibleText: extra!.title });
  const state = {
    snapshots: 0,
    handoffs: 0,
    preparations: 0,
    preparedWithoutOverlay: true,
    failFirstPersistence: false,
  };
  const images = new Map<string, Uint8Array>();
  const metadata = new Map<string, string>();
  const readyIds: string[] = [];
  const requestedIds: string[] = [];
  const bounds = { x: 10, y: 20, width: 800, height: 600 };
  const takeSnapshot = async () => {
    const index = state.snapshots++;
    const capture = captures[Math.min(index, captures.length - 1)]!;
    capture.oldOverlaysCleared = flashWindows.every((window) => window.destroyed);
    capture.started.resolve();
    await capture.pixels.promise;
    return capture;
  };
  activeWindowMock.mockReset().mockImplementation(async () => {
    const capture = captures[Math.min(state.snapshots, captures.length - 1)]!;
    return {
      platform: "windows",
      id: capture.id,
      title: capture.title,
      owner: { name: capture.title, processId: capture.processId, path: "" },
      bounds,
    };
  });
  regionCaptureMock.mockReset().mockImplementation(async () => {
    const capture = await takeSnapshot();
    return { width: bounds.width, height: bounds.height, png: capture.png };
  });
  const readAccessibility = accessibilityProcessReadMock.getMockImplementation()!;
  accessibilityProcessReadMock.mockImplementation(({ active }) => ({
    started: Promise.resolve(),
    result: captures.find((capture) => capture.processId === active.owner.processId)!.context
      .promise,
  }));
  const handoff = Effect.sync(() => captures[state.handoffs++]!.handoff.resolve());
  let randomByte = 0;
  const layer = Layer.mergeAll(
    layerTest("win32", {
      makeDirectory: () => Effect.void,
      writeFile: (path, bytes) =>
        Effect.sync(() => {
          images.set(path, bytes);
        }),
      writeFileString: (path, text) => {
        const pending = JSON.parse(text) as { source: { windowTitle: string } };
        return state.failFirstPersistence && pending.source.windowTitle === first!.title
          ? Effect.fail(
              PlatformError.systemError({
                _tag: "PermissionDenied",
                module: "FileSystem",
                method: "writeFileString",
              }),
            )
          : Effect.sync(() => {
              metadata.set(path, text);
            });
      },
      rename: (from, to) =>
        Effect.sync(() => {
          const image = images.get(from);
          if (image) {
            images.set(to, image);
            images.delete(from);
          }
          const text = metadata.get(from);
          if (text) {
            metadata.set(to, text);
            metadata.delete(from);
          }
        }),
      remove: (path) =>
        Effect.sync(() => {
          images.delete(path);
          metadata.delete(path);
        }),
      readFile: (path) => Effect.sync(() => images.get(path)!),
      readFileString: (path) => Effect.sync(() => metadata.get(path)!),
    }),
    Layer.succeed(
      SecureRandom.SecureRandom,
      SecureRandom.make((size) => new Uint8Array(size).fill(++randomByte)),
    ),
    Layer.succeed(
      DesktopWindow.DesktopWindow,
      DesktopWindow.DesktopWindow.of({
        activate: handoff,
        prepareCaptureReveal: Effect.sync(() => {
          state.preparations++;
          state.preparedWithoutOverlay &&= flashWindows.every((window) => window.destroyed);
        }),
        dispatchMenuAction: () => Effect.void,
        dispatchSnapShotEvent: (event: DesktopSnapShotEvent) => {
          switch (event.type) {
            case "requested":
              return Effect.sync(() => {
                requestedIds.push(event.id);
              });
            case "started":
              return handoff;
            case "ready":
              return Effect.sync(() => {
                readyIds.push(event.id);
              });
            default:
              return Effect.void;
          }
        },
      } as unknown as DesktopWindow.DesktopWindow["Service"]),
    ),
  );
  return {
    first: first!,
    second: second!,
    state,
    readyIds,
    requestedIds,
    layer,
    settings: {
      ...DEFAULT_CLIENT_SETTINGS,
      snapShotEnabled: true,
      snapShotIncludeAccessibility: true,
      snapShotAnimations: animations,
      snapShotFlash: true,
      snapShotShortcut: {
        key: "2",
        ctrlKey: true,
        shiftKey: true,
        altKey: false,
        metaKey: false,
        modKey: false,
      },
    },
    trigger: () => (registerShortcutMock.mock.calls.at(-1)![1] as () => Promise<void>)(),
    releaseAll: () => {
      for (const capture of captures) {
        capture.pixels.resolve();
        capture.context.resolve({ accessibleText: capture.title });
      }
    },
    reset: () => {
      focusedWindowMock.mockReset();
      accessibilityProcessReadMock.mockReset().mockImplementation(readAccessibility);
      animationSettingsMock.mockReturnValue({
        prefersReducedMotion: true,
        shouldRenderRichAnimation: false,
      });
    },
  };
}

it.effect("drops shortcut bursts during flight and accepts a fresh capture after landing", () => {
  const fixture = concurrentCaptureFixture(true);
  fixture.releaseAll();
  const flying = Promise.withResolvers<void>();
  const heldFlights: Array<() => void> = [];
  const push = heldFlights.push.bind(heldFlights);
  vi.spyOn(heldFlights, "push").mockImplementation((...resolvers) => {
    const count = push(...resolvers);
    flying.resolve();
    return count;
  });
  transitionScriptState.heldFlights = heldFlights;
  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopSnapShot.make;
      yield* service.configure(fixture.settings);
      yield* Effect.promise(fixture.trigger);
      const firstId = fixture.readyIds[0]!;
      const landing = yield* service
        .setAnimationDestination(firstId, {
          frame: { x: 100, y: 400, width: 208, height: 112 },
          backgroundColor: "#fff",
          borderColor: "#ccc",
          borderWidth: 1,
          cornerRadius: 8,
          scaleFactor: 1,
        })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Effect.promise(() => flying.promise);
      const overlayCount = flashWindows.length;

      for (let repeat = 0; repeat < 20; repeat++) {
        yield* TestClock.adjust("200 millis");
        yield* Effect.promise(fixture.trigger);
      }
      assert.equal(fixture.state.snapshots, 1);
      assert.lengthOf(fixture.readyIds, 1);
      assert.lengthOf(flashWindows, overlayCount);
      assert.isTrue(flashWindows.every((window) => !window.destroyed));

      for (const finish of heldFlights) finish();
      yield* Fiber.join(landing);
      yield* Effect.promise(fixture.trigger);
      assert.equal(fixture.state.snapshots, 2);
      assert.lengthOf(fixture.readyIds, 2);
      assert.isTrue(fixture.second.oldOverlaysCleared);
    }),
  ).pipe(
    Effect.provide(fixture.layer),
    Effect.ensuring(
      Effect.sync(() => {
        for (const finish of heldFlights) finish();
        transitionScriptState.heldFlights = null;
        fixture.reset();
      }),
    ),
  );
});

it.effect.each([
  { length: 1_000, suffix: "", expectedLength: 1_000 },
  { length: 1_001, suffix: "", expectedLength: 1_000 },
  { length: 999, suffix: "😀", expectedLength: 999 },
])(
  "preserves captures with native metadata of length $length and suffix $suffix",
  ({ length, suffix, expectedLength }) => {
    const png = Buffer.from([1, 2, 3]);
    const title = "t".repeat(length) + suffix;
    const appName = "a".repeat(254) + "😀";
    activeWindowMock.mockReset().mockResolvedValue({
      platform: "windows",
      id: 42,
      title,
      owner: { name: appName, processId: 123, path: "" },
      bounds: { x: 10, y: 20, width: 800, height: 600 },
    });
    focusedWindowMock.mockReturnValue(undefined);
    allWindowsMock.mockReturnValue([]);
    regionCaptureMock.mockReset().mockResolvedValue({ width: 800, height: 600, png });
    accessibilityProcessReadMock.mockReturnValueOnce({
      started: Promise.resolve(),
      result: Promise.resolve(undefined),
    });
    let metadata = "";
    const layer = layerTest("win32", {
      makeDirectory: () => Effect.void,
      rename: () => Effect.void,
      writeFile: () => Effect.void,
      writeFileString: (_, text) =>
        Effect.sync(() => {
          metadata = text;
        }),
      readDirectory: () => Effect.succeed(["capture.json"]),
      readFileString: () => Effect.succeed(metadata),
      readFile: () => Effect.succeed(png),
    });
    return Effect.scoped(
      Effect.gen(function* () {
        const service = yield* DesktopSnapShot.make;
        yield* service.configure(enabledSettings());
        yield* service.capture;
        const pending = yield* service.listPending;
        assert.lengthOf(pending, 1);
        const capture = yield* service.read(pending[0]!.id);
        assert.equal(capture.dataUrl, "data:image/png;base64,AQID");
        assert.equal(capture.source.windowTitle, "t".repeat(expectedLength));
        assert.equal(capture.source.appName, "a".repeat(254));
      }),
    ).pipe(Effect.provide(layer));
  },
);

it.effect.each([true, false] as const)(
  "captures again while accessibility is pending (animations: %s)",
  (animations) => {
    const fixture = concurrentCaptureFixture(animations);
    return Effect.scoped(
      Effect.gen(function* () {
        const service = yield* DesktopSnapShot.make;
        yield* service.configure(fixture.settings);
        const first = yield* Effect.promise(fixture.trigger).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Effect.promise(() => fixture.first.started.promise);
        assert.lengthOf(fixture.requestedIds, 1);
        assert.lengthOf(fixture.readyIds, 0);
        fixture.first.pixels.resolve();
        yield* Effect.promise(() => fixture.first.handoff.promise);
        assert.lengthOf(fixture.readyIds, 0);

        yield* TestClock.adjust("200 millis");
        fixture.second.pixels.resolve();
        const second = yield* Effect.promise(fixture.trigger).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Effect.promise(() => fixture.second.handoff.promise);
        assert.equal(fixture.state.snapshots, 2);
        assert.isTrue(fixture.second.oldOverlaysCleared);
        assert.equal(fixture.state.preparations, 2);
        assert.isTrue(fixture.state.preparedWithoutOverlay);
        const secondOverlays = flashWindows.filter((window) => !window.destroyed);
        assert.isNotEmpty(secondOverlays);

        fixture.second.context.resolve({ accessibleText: "Explorer accessibility" });
        yield* Fiber.join(second);
        assert.lengthOf(fixture.readyIds, 1);
        fixture.first.context.resolve({ accessibleText: "Discord accessibility" });
        yield* Fiber.join(first);
        assert.lengthOf(fixture.readyIds, 2);
        assert.equal(new Set(fixture.readyIds).size, 2);
        assert.deepEqual(fixture.readyIds, fixture.requestedIds.toReversed());
        const newer = yield* service.read(fixture.readyIds[0]!);
        const older = yield* service.read(fixture.readyIds[1]!);
        assert.equal(newer.source.windowTitle, fixture.second.title);
        assert.equal(newer.source.accessibleText, "Explorer accessibility");
        assert.equal(
          newer.dataUrl,
          `data:image/png;base64,${fixture.second.png.toString("base64")}`,
        );
        assert.equal(older.source.windowTitle, fixture.first.title);
        assert.equal(older.source.accessibleText, "Discord accessibility");
        assert.equal(
          older.dataUrl,
          `data:image/png;base64,${fixture.first.png.toString("base64")}`,
        );

        yield* service.acknowledge(fixture.readyIds[1]!);
        assert.isTrue(secondOverlays.every((window) => !window.destroyed));
      }).pipe(Effect.ensuring(Effect.sync(fixture.releaseAll))),
    ).pipe(Effect.provide(fixture.layer), Effect.ensuring(Effect.sync(fixture.reset)));
  },
);

it.effect.each(["succeeds", "fails"] as const)(
  "keeps the newer snapshot exclusive when older persistence %s",
  (outcome) => {
    const fixture = concurrentCaptureFixture(true);
    fixture.state.failFirstPersistence = outcome === "fails";
    return Effect.scoped(
      Effect.gen(function* () {
        const service = yield* DesktopSnapShot.make;
        yield* service.configure(fixture.settings);
        fixture.first.pixels.resolve();
        const first = yield* Effect.promise(fixture.trigger).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Effect.promise(() => fixture.first.handoff.promise);
        yield* TestClock.adjust("200 millis");
        const second = yield* Effect.promise(fixture.trigger).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Effect.promise(() => fixture.second.started.promise);

        yield* TestClock.adjust("200 millis");
        yield* Effect.promise(fixture.trigger);
        assert.equal(fixture.state.snapshots, 2);
        fixture.first.context.resolve({ accessibleText: "Discord accessibility" });
        yield* Fiber.join(first);
        assert.lengthOf(fixture.readyIds, outcome === "succeeds" ? 1 : 0);
        yield* TestClock.adjust("200 millis");
        yield* Effect.promise(fixture.trigger);
        assert.equal(fixture.state.snapshots, 2);

        fixture.second.pixels.resolve();
        yield* Effect.promise(() => fixture.second.handoff.promise);
        fixture.second.context.resolve({ accessibleText: "Explorer accessibility" });
        yield* Fiber.join(second);
        assert.equal(fixture.state.handoffs, 2);
        const newer = yield* service.read(fixture.readyIds.at(-1)!);
        assert.equal(newer.source.windowTitle, fixture.second.title);
        assert.equal(newer.source.accessibleText, "Explorer accessibility");
      }).pipe(Effect.ensuring(Effect.sync(fixture.releaseAll))),
    ).pipe(Effect.provide(fixture.layer), Effect.ensuring(Effect.sync(fixture.reset)));
  },
);

it.effect("captures and reads Windows windows in physical pixels on a scaled display", () => {
  const png = Buffer.from([1, 2, 3]);
  const active = {
    platform: "windows",
    id: 42,
    title: "Editor",
    owner: { name: "Editor", processId: 123, path: "" },
    bounds: { x: 10, y: 20, width: 800, height: 600 },
  } as const;
  const window = (name: string, value: string) => ({
    role: "window",
    name,
    bounds: active.bounds,
    children: async () => [
      {
        role: "button",
        name: "Save",
        bounds: { x: 210, y: 220, width: 200, height: 100 },
        children: async () => [],
      },
    ],
    tree: async () => ({ name, value, children: [] }),
  });
  activeWindowMock.mockReset().mockResolvedValue(active);
  screenToDipRectMock.mockImplementation(() => ({ x: 5, y: 10, width: 400, height: 300 }));
  regionCaptureMock.mockReset().mockResolvedValue({ width: 800, height: 600, png });
  accessibilityForegroundMock.mockReset().mockResolvedValue({
    pid: 123,
    children: async () => [window("Settings", "Wrong window"), window("Editor", "Scaled text")],
  });
  let metadata = "";
  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopSnapShot.make;
      yield* service.configure(enabledSettings());
      yield* service.capture;
      const saved = yield* decodePendingMetadata(metadata);
      assert.deepEqual(regionCaptureMock.mock.calls[0]?.[0], active.bounds);
      assert.include(saved.source.accessibleText, "Scaled text");
      assert.deepEqual(
        saved.source.accessibility?.format === "element-tree"
          ? saved.source.accessibility.root.children[0]?.bounds
          : undefined,
        { x: 200, y: 200, width: 200, height: 100 },
      );
    }),
  ).pipe(
    Effect.provide(
      layerTest("win32", {
        makeDirectory: () => Effect.void,
        rename: () => Effect.void,
        writeFile: () => Effect.void,
        writeFileString: (_, text) =>
          Effect.sync(() => {
            metadata = text;
          }),
      }),
    ),
    Effect.ensuring(
      Effect.sync(() => {
        screenToDipRectMock.mockImplementation((_window, bounds) => bounds);
      }),
    ),
  );
});

it("covers straddling captures and intervening monitors without spanning unrelated displays", () => {
  const displays = [
    { bounds: { x: -1_920, y: 0, width: 1_920, height: 1_080 } },
    { bounds: { x: 0, y: 0, width: 1_440, height: 900 } },
    { bounds: { x: 1_440, y: 0, width: 1_280, height: 720 } },
    { bounds: { x: 0, y: -1_080, width: 1_920, height: 1_080 } },
  ];
  const source = { x: -200, y: 100, width: 800, height: 600 };
  assert.deepEqual(
    snapShotAnimationDisplayBounds(displays, source, source),
    displays.slice(0, 2).map((display) => display.bounds),
  );
  assert.deepEqual(
    snapShotAnimationDisplayBounds(
      displays,
      { x: -1_800, y: 100, width: 800, height: 600 },
      { x: 1_600, y: 200, width: 200, height: 112 },
    ),
    displays.slice(0, 3).map((display) => display.bounds),
  );
});

it("cancels a late display while its snapshot is still decoding", async () => {
  flashWindows.length = 0;
  const transition = new SnapShotTransition({ boundOverlayToCaptureDisplays: true });
  const decoding = Promise.withResolvers<void>();
  const decoded = Promise.withResolvers<void>();

  try {
    await transition.begin(
      "capture-1",
      { x: -1_800, y: 50, width: 900, height: 600 },
      "data:image/png;base64,",
      false,
    );
    transitionSnapshotMock.mockImplementationOnce(() => {
      decoding.resolve();
      return decoded.promise;
    });
    transition.animateTo("capture-1", {
      frame: { x: 600, y: 400, width: 208, height: 112 },
      backgroundColor: "#fff",
      borderColor: "#ccc",
      borderWidth: 1,
      cornerRadius: 8,
      scaleFactor: 1,
    });
    const landing = transition.waitForLanding("capture-1");
    await decoding.promise;

    transition.dismiss("capture-1");
    decoded.resolve();
    await landing;

    assert.lengthOf(flashWindows, 2);
    assert.strictEqual(flashWindows[1]?.showCount, 0);
    for (const window of flashWindows) {
      assert.isTrue(window.destroyed);
    }
  } finally {
    decoded.resolve();
    transition.dispose();
  }
});

it("does not flash a dismissed overlay after its initial compositor receipt arrives", async () => {
  flashWindows.length = 0;
  const transition = new SnapShotTransition({ waitForCompositorFrame: true });
  const readingFrame = Promise.withResolvers<void>();
  const frame = Promise.withResolvers<void>();
  transitionCapturePageMock.mockImplementation(() => {
    readingFrame.resolve();
    return frame.promise;
  });

  try {
    const begin = transition.begin(
      "capture-1",
      { x: 100, y: 50, width: 900, height: 600 },
      "data:image/png;base64,",
      true,
    );
    await readingFrame.promise;
    assert.isFalse(transition.isAnimating);
    transition.dismiss("capture-1");
    assert.isFalse(transition.isAnimating);
    frame.resolve();
    await begin;

    for (const window of flashWindows) {
      assert.isTrue(window.destroyed);
    }
  } finally {
    frame.resolve();
    transition.dispose();
  }
});

it("does not start a dismissed transition after its compositor receipt arrives", async () => {
  flashWindows.length = 0;
  const transition = new SnapShotTransition({ waitForCompositorFrame: true });
  const readingFrame = Promise.withResolvers<void>();
  const frame = Promise.withResolvers<void>();
  try {
    await transition.begin(
      "capture-1",
      { x: 100, y: 50, width: 900, height: 600 },
      "data:image/png;base64,",
      false,
    );
    transitionCapturePageMock.mockImplementation(() => {
      readingFrame.resolve();
      return frame.promise;
    });
    transition.animateTo("capture-1", {
      frame: { x: 600, y: 400, width: 208, height: 112 },
      backgroundColor: "#fff",
      borderColor: "#ccc",
      borderWidth: 1,
      cornerRadius: 8,
      scaleFactor: 1,
    });
    const landing = transition.waitForLanding("capture-1");
    await readingFrame.promise;
    assert.isTrue(transition.isAnimating);
    transition.dismiss("capture-1");
    assert.isFalse(transition.isAnimating);
    frame.resolve();
    await landing;

    assert.isTrue(flashWindows[0]?.destroyed);
  } finally {
    frame.resolve();
    transition.dispose();
  }
});

it("does not let a failed transition fail landing or capture completion", async () => {
  flashWindows.length = 0;
  transitionScriptState.rejectFlight = true;
  const transition = new SnapShotTransition();

  try {
    await transition.begin(
      "capture-1",
      { x: 100, y: 50, width: 900, height: 600 },
      "data:image/png;base64,",
      false,
    );
    transition.animateTo("capture-1", {
      frame: { x: 20, y: 20, width: 208, height: 112 },
      backgroundColor: "#fff",
      borderColor: "#ccc",
      borderWidth: 1,
      cornerRadius: 8,
      scaleFactor: 1,
    });

    await transition.waitForLanding("capture-1");
    assert.isFalse(transition.isAnimating);
    await transition.complete("capture-1");

    assert.isTrue(flashWindows[0]?.destroyed);
  } finally {
    transitionScriptState.rejectFlight = false;
    transition.dispose();
  }
});

it("extracts the structured accessibility tree on Windows", async () => {
  const bounds = { x: 100, y: 200, width: 800, height: 600 };
  const window = {
    role: "window",
    name: "Editor",
    bounds,
    tree: async () => ({
      name: "Editor",
      children: [
        { name: "Save", children: [] },
        { name: "Below scroll view", children: [] },
      ],
    }),
    children: async () => [
      {
        role: "button",
        name: "Save",
        bounds: { x: 300, y: 350, width: 100, height: 50 },
        children: async () => [],
      },
      {
        role: "static_text",
        name: "Below scroll view",
        bounds: { x: 300, y: 1_000, width: 100, height: 50 },
        visible: false,
        children: async () => [],
      },
    ],
  };
  accessibilityForegroundMock
    .mockReset()
    .mockResolvedValue({ pid: 123, children: async () => [window] });

  const result = await readAccessibleWindowContext(
    { title: "Editor", bounds, owner: { processId: 123 } },
    "Editor",
    { width: 1_600, height: 1_200 },
  );

  assert.equal(result?.accessibility?.format, "element-tree");
  assert.equal(
    result?.accessibility?.format === "element-tree"
      ? result.accessibility.root.children[0]?.name
      : undefined,
    "Save",
  );
  assert.deepInclude(
    result?.accessibility?.format === "element-tree"
      ? result.accessibility.root.children[1]
      : undefined,
    { name: "Below scroll view", bounds: null, state: { visible: false } },
  );
  assert.lengthOf(accessibilityForegroundMock.mock.calls, 1);
});

it("still requires matching accessibility screen positions on Windows", async () => {
  const tree = vi.fn(async () => ({ value: "Wrong window", children: [] }));
  const window = {
    name: "Editor",
    bounds: { x: 0, y: 0, width: 700, height: 520 },
    tree,
  };
  accessibilityForegroundMock
    .mockReset()
    .mockResolvedValue({ pid: 123, children: async () => [window] });
  assert.isUndefined(
    await readAccessibleWindowText(
      {
        title: "Editor",
        bounds: { x: 479, y: 342, width: 700, height: 520 },
        owner: { processId: 123 },
      },
      "Editor",
    ),
  );
  assert.lengthOf(tree.mock.calls, 0);
});

it.each([
  ["value", 650],
  ["name", 100],
] as const)("preserves long text outside the scroll view (%s)", async (field, lines) => {
  const text = `${"Document line\n".repeat(lines)}End of document`;
  const bounds = { x: 0, y: 0, width: 800, height: 600 };
  const window = {
    role: "window",
    name: "Editor",
    bounds,
    tree: async () => ({ name: "Editor", children: [{ [field]: text, children: [] }] }),
    children: async () => [{ role: "text_area", [field]: text, bounds, children: async () => [] }],
  };
  accessibilityForegroundMock
    .mockReset()
    .mockResolvedValue({ pid: 123, children: async () => [window] });
  const result = await readAccessibleWindowContext(
    { title: "Editor", bounds, owner: { processId: 123 } },
    "Editor",
  );
  assert.deepEqual(result?.accessibility, {
    format: "flat-text",
    text: `Editor\n${text}`,
    truncated: false,
  });
});

it("keeps a truncated element tree when the flat text read fails", async () => {
  const bounds = { x: 0, y: 0, width: 800, height: 600 };
  accessibilityForegroundMock.mockReset().mockResolvedValue({
    pid: 123,
    children: async () => [
      {
        role: "window",
        name: "Editor",
        bounds,
        tree: async () => {
          throw new Error("Text read failed");
        },
        children: async () => [
          {
            role: "text_area",
            value: "x".repeat(8_001),
            bounds: { x: 10, y: 50, width: 700, height: 500 },
            children: async () => [],
          },
        ],
      },
    ],
  });

  const result = await readAccessibleWindowContext(
    { title: "Editor", bounds, owner: { processId: 123 } },
    "Editor",
  );
  assert.equal(result?.accessibility?.format, "element-tree");
  assert.isTrue(result?.accessibility?.truncated);
  assert.deepEqual(
    result?.accessibility?.format === "element-tree"
      ? result.accessibility.root.children[0]?.bounds
      : undefined,
    { x: 10, y: 50, width: 700, height: 500 },
  );
});

it.effect("an unrelated client-setting change keeps the registered shortcut", () => {
  registerShortcutMock.mockReset().mockReturnValue(true);
  unregisterShortcutMock.mockReset();
  const settings = enabledSettings({
    snapShotShortcut: {
      key: "k",
      metaKey: false,
      ctrlKey: true,
      shiftKey: false,
      altKey: true,
      modKey: false,
    },
  });

  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopSnapShot.make;
      yield* service.configure(settings);
      assert.deepEqual(
        registerShortcutMock.mock.calls.map(([accelerator]) => accelerator),
        ["Control+Alt+K"],
      );

      yield* service.configure({ ...settings, wordWrap: !settings.wordWrap });
      assert.lengthOf(unregisterShortcutMock.mock.calls, 0);
      assert.lengthOf(registerShortcutMock.mock.calls, 1);
      assert.isTrue((yield* service.state).shortcutRegistered);

      yield* service.configure({
        ...settings,
        snapShotShortcut: { ...settings.snapShotShortcut, key: "j" },
      });
      assert.deepEqual(unregisterShortcutMock.mock.calls, [["Control+Alt+K"]]);
      assert.deepEqual(
        registerShortcutMock.mock.calls.map(([accelerator]) => accelerator),
        ["Control+Alt+K", "Control+Alt+J"],
      );
    }),
  ).pipe(Effect.provide(layerTest("win32")));
});

it.effect("capture fails closed while snapshots are disabled", () => {
  activeWindowMock.mockClear();
  regionCaptureMock.mockClear();

  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopSnapShot.make;
      yield* service.configure({ ...DEFAULT_CLIENT_SETTINGS, snapShotEnabled: false });
      const failure = yield* Effect.flip(service.capture);
      assert.equal(failure.operation, "disabled");
      assert.lengthOf(activeWindowMock.mock.calls, 0);
      assert.lengthOf(regionCaptureMock.mock.calls, 0);
    }),
  ).pipe(Effect.provide(layerTest("win32")));
});

it.effect("verifies only native shortcut delivery and captures normally", () => {
  registerShortcutMock.mockReset().mockReturnValue(true);
  activeWindowMock.mockReset().mockResolvedValue({
    platform: "windows",
    id: 42,
    title: "Shortcut capture",
    owner: { name: "Editor.exe", processId: 123, path: "" },
    bounds: { x: 0, y: 0, width: 700, height: 520 },
  });
  regionCaptureMock.mockReset().mockResolvedValue({
    width: 700,
    height: 520,
    png: Buffer.from([1, 2, 3]),
  });
  const settings = {
    ...DEFAULT_CLIENT_SETTINGS,
    snapShotEnabled: true,
    snapShotIncludeAccessibility: false,
    snapShotShortcut: {
      key: "2",
      ctrlKey: true,
      shiftKey: true,
      altKey: false,
      metaKey: false,
      modKey: false,
    },
  };
  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopSnapShot.make;
      yield* service.configure(settings);
      assert.isFalse((yield* service.state).shortcutVerified);
      yield* service.capture;
      assert.isFalse((yield* service.state).shortcutVerified);
      regionCaptureMock.mockClear();
      const trigger = registerShortcutMock.mock.calls.at(-1)![1] as () => Promise<void>;
      yield* service.setShortcutSuppressed(true);
      yield* Effect.promise(trigger);
      assert.isFalse((yield* service.state).shortcutVerified);
      assert.lengthOf(regionCaptureMock.mock.calls, 0);
      yield* service.setShortcutSuppressed(false);
      yield* Effect.promise(trigger);
      assert.isTrue((yield* service.state).shortcutVerified);
      assert.lengthOf(regionCaptureMock.mock.calls, 1);
      yield* service.configure({ ...settings, snapShotEnabled: false });
      assert.isFalse((yield* service.state).shortcutVerified);
    }),
  ).pipe(
    Effect.provide(
      layerTest("win32", {
        makeDirectory: () => Effect.void,
        rename: () => Effect.void,
        writeFile: () => Effect.void,
        writeFileString: () => Effect.void,
      }),
    ),
  );
});
