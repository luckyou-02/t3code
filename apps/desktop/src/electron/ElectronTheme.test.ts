import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { vi } from "vite-plus/test";

const { nativeTheme } = vi.hoisted(() => ({
  nativeTheme: {
    themeSource: "system" as "system" | "light" | "dark",
    shouldUseDarkColors: false,
    on: vi.fn(),
    removeListener: vi.fn(),
  },
}));

vi.mock("electron", () => ({ nativeTheme }));

import * as ElectronTheme from "./ElectronTheme.ts";

describe("ElectronTheme", () => {
  it.effect("updates Electron nativeTheme.themeSource", () =>
    Effect.gen(function* () {
      nativeTheme.themeSource = "system";
      const theme = yield* ElectronTheme.make;

      yield* theme.setSource("dark");
      assert.equal(nativeTheme.themeSource, "dark");

      yield* theme.setSource("light");
      assert.equal(nativeTheme.themeSource, "light");

      yield* theme.setSource("system");
      assert.equal(nativeTheme.themeSource, "system");
    }),
  );

  it.effect("registers and removes the updated listener with the scope", () =>
    Effect.gen(function* () {
      nativeTheme.on.mockReset();
      nativeTheme.removeListener.mockReset();
      const listener = () => undefined;
      const theme = yield* ElectronTheme.make;

      yield* theme.onUpdated(listener).pipe(Effect.scoped);

      assert.deepEqual(nativeTheme.on.mock.calls, [["updated", listener]]);
      assert.deepEqual(nativeTheme.removeListener.mock.calls, [["updated", listener]]);
    }),
  );
});
