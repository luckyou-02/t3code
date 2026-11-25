import { assert, describe, it } from "@effect/vitest";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopSnapShot from "../../snapShot/DesktopSnapShot.ts";
import { checkSnapShotShortcut, setSnapShotShortcutSuppressed } from "./snapShot.ts";

describe("window capture IPC", () => {
  it.effect("allows shortcut checks and suppression only from the trusted main renderer", () => {
    const calls: string[] = [];
    return Effect.gen(function* () {
      const untrustedCheck = yield* Effect.exit(
        checkSnapShotShortcut.handler(DEFAULT_CLIENT_SETTINGS.snapShotShortcut, {
          sender: { id: 8 },
        }),
      );
      const untrustedSuppress = yield* Effect.exit(
        setSnapShotShortcutSuppressed.handler(true, { sender: { id: 8 } }),
      );
      assert(Exit.isFailure(untrustedCheck));
      assert(Exit.isFailure(untrustedSuppress));
      assert.deepEqual(calls, []);

      yield* checkSnapShotShortcut.handler(DEFAULT_CLIENT_SETTINGS.snapShotShortcut, {
        sender: { id: 7 },
      });
      yield* setSnapShotShortcutSuppressed.handler(true, { sender: { id: 7 } });
      assert.deepEqual(calls, ["check", "suppress:true"]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(ElectronWindow.ElectronWindow, {
            main: Effect.succeedSome({ webContents: { id: 7 } }),
          } as ElectronWindow.ElectronWindow["Service"]),
          Layer.succeed(DesktopSnapShot.DesktopSnapShot, {
            checkShortcut: () =>
              Effect.sync(() => {
                calls.push("check");
                return { available: true, message: null };
              }),
            setShortcutSuppressed: (suppressed: boolean) =>
              Effect.sync(() => {
                calls.push(`suppress:${String(suppressed)}`);
              }),
          } as unknown as DesktopSnapShot.DesktopSnapShot["Service"]),
        ),
      ),
    );
  });
});
