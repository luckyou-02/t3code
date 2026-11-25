import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { beforeEach, vi } from "vite-plus/test";

const { electron } = vi.hoisted(() => ({
  electron: {
    showMessageBox: vi.fn(),
  },
}));

vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: () => null },
  dialog: { showMessageBox: electron.showMessageBox },
  webContents: { fromFrame: () => undefined },
}));

import * as PreviewPasskeys from "./Passkeys.ts";

describe("PreviewPasskeys", () => {
  beforeEach(() => {
    electron.showMessageBox.mockReset();
  });

  it.effect("asks which passkey to use only when a site has several", () =>
    Effect.gen(function* () {
      const passkeys = yield* PreviewPasskeys.PreviewPasskeys;
      const listeners: Array<(...args: ReadonlyArray<unknown>) => void> = [];
      const session = {
        on: (_event: string, listener: (...args: ReadonlyArray<unknown>) => void) =>
          listeners.push(listener),
      } as unknown as Electron.Session;
      passkeys.installSessionHandlers(session);
      passkeys.installSessionHandlers(session);
      assert.strictEqual(listeners.length, 1);

      const select = (accounts: ReadonlyArray<Electron.WebAuthnAccount>) =>
        Effect.promise(
          () =>
            new Promise<unknown>((resolve) =>
              listeners[0]?.(
                {},
                { relyingPartyId: "example.com", accounts, frame: null },
                (credentialId?: string) => resolve(credentialId),
              ),
            ),
        );
      const alice = { credentialId: "alice", name: "alice@example.com" };
      const bob = { credentialId: "bob", displayName: "Bob", name: "bob@example.com" };

      assert.strictEqual(yield* select([alice]), "alice");
      assert.strictEqual(electron.showMessageBox.mock.calls.length, 0);

      electron.showMessageBox.mockResolvedValueOnce({ response: 1 });
      assert.strictEqual(yield* select([alice, bob]), "bob");
      assert.deepStrictEqual(electron.showMessageBox.mock.calls[0]?.[0]?.buttons, [
        "alice@example.com",
        "Bob (bob@example.com)",
        "Cancel",
      ]);

      electron.showMessageBox.mockResolvedValueOnce({ response: 2 });
      assert.isUndefined(yield* select([alice, bob]));
    }).pipe(Effect.provide(PreviewPasskeys.layer)),
  );
});
