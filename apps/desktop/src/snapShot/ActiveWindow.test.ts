import { assert, beforeEach, it, vi } from "vite-plus/test";

const { loadWindowsForegroundApiMock } = vi.hoisted(() => ({
  loadWindowsForegroundApiMock: vi.fn(),
}));

vi.mock("../electron/WindowsForeground.ts", () => ({
  loadWindowsForegroundApi: loadWindowsForegroundApiMock,
}));

import { activeWindow } from "./ActiveWindow.ts";

beforeEach(() => {
  loadWindowsForegroundApiMock.mockReset();
});

it("resolves the foreground Windows window with owner metadata", async () => {
  loadWindowsForegroundApiMock.mockResolvedValue({
    getForegroundWindow: () => 42n,
    getWindowRect: () => ({ x: 10, y: 20, width: 800, height: 600 }),
    getWindowThreadAndProcessId: () => ({ threadId: 1, processId: 123 }),
    getProcessImagePath: () => "C:\\Program Files\\Editor\\Editor.exe",
    getWindowText: () => "main.ts",
  });

  const window = await activeWindow("win32");

  assert.deepEqual(window, {
    platform: "windows",
    id: 42,
    title: "main.ts",
    bounds: { x: 10, y: 20, width: 800, height: 600 },
    owner: {
      name: "Editor.exe",
      processId: 123,
      path: "C:\\Program Files\\Editor\\Editor.exe",
    },
  });
});

it("returns undefined on non-Windows platforms or when no foreground window exists", async () => {
  assert.isUndefined(await activeWindow("linux"));
  loadWindowsForegroundApiMock.mockResolvedValue({
    getForegroundWindow: () => 0n,
  });
  assert.isUndefined(await activeWindow("win32"));
});
