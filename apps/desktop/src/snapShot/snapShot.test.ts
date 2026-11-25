import { parseKeybindingShortcut } from "@t3tools/shared/keybindings";
import { describe, expect, it } from "vite-plus/test";

import {
  accessibleWindowElementTree,
  accessibleWindowText,
  compactAccessibilityTree,
  findAccessibleWindow,
  toElectronAccelerator,
} from "./snapShot.ts";

describe("accessibleWindowText", () => {
  it("caps large text without splitting a surrogate pair", () => {
    expect(
      accessibleWindowText(
        {
          value: "abc😀def",
          children: [],
        },
        5,
      ),
    ).toBe("abc😀");
  });

  it("stops traversing very large trees", () => {
    expect(
      accessibleWindowText(
        {
          children: [
            ...Array.from({ length: 10_000 }, () => ({ children: [] })),
            { value: "past node limit", children: [] },
          ],
        },
        100,
      ),
    ).not.toContain("past node limit");
  });
});

describe("accessibleWindowElementTree", () => {
  it("maps element bounds into captured-image pixels and keeps semantic state", async () => {
    const tree = await accessibleWindowElementTree(
      {
        role: "window",
        name: "Editor",
        bounds: { x: 100, y: 200, width: 800, height: 600 },
        active: true,
        children: async () => [
          {
            role: "button",
            name: "Save",
            description: "Save the document",
            bounds: { x: 300, y: 350, width: 100, height: 50 },
            focused: true,
            actions: ["press", "press"],
            children: async () => [],
          },
        ],
      },
      { x: 100, y: 200, width: 800, height: 600 },
      { width: 1_600, height: 1_200 },
    );

    expect(tree).toEqual({
      truncated: false,
      root: {
        role: "window",
        name: "Editor",
        bounds: { x: 0, y: 0, width: 1_600, height: 1_200 },
        state: { active: true },
        children: [
          {
            role: "button",
            name: "Save",
            description: "Save the document",
            bounds: { x: 400, y: 300, width: 200, height: 100 },
            state: { focused: true },
            actions: ["press"],
            children: [],
          },
        ],
      },
    });
  });

  it("collapses anonymous wrapper chains and removes duplicate text fields", async () => {
    const tree = await accessibleWindowElementTree(
      {
        role: "window",
        name: "Editor",
        bounds: { x: 0, y: 0, width: 800, height: 600 },
        children: async () => [
          {
            role: "group",
            bounds: { x: 0, y: 0, width: 800, height: 600 },
            children: async () => [
              {
                role: "group",
                bounds: { x: 0, y: 0, width: 800, height: 600 },
                children: async () => [
                  {
                    role: "button",
                    name: "Save",
                    value: "Save",
                    description: "Save",
                    bounds: { x: 20, y: 30, width: 80, height: 24 },
                    actions: ["press"],
                    children: async () => [],
                  },
                  {
                    role: "group",
                    bounds: null,
                    children: async () => [],
                  },
                ],
              },
            ],
          },
        ],
      },
      { x: 0, y: 0, width: 800, height: 600 },
      { width: 800, height: 600 },
    );

    expect(tree?.root.children).toEqual([
      {
        role: "button",
        name: "Save",
        bounds: { x: 20, y: 30, width: 80, height: 24 },
        actions: ["press"],
        children: [],
      },
    ]);
  });

  it("marks trees truncated before their serialized payload grows without bound", async () => {
    const tree = await accessibleWindowElementTree(
      {
        role: "window",
        bounds: { x: 0, y: 0, width: 800, height: 600 },
        children: async () =>
          Array.from({ length: 10 }, (_, index) => ({
            role: "text",
            value: `${index}${"x".repeat(8_000)}`,
            bounds: null,
            children: async () => [],
          })),
      },
      { x: 0, y: 0, width: 800, height: 600 },
      { width: 800, height: 600 },
    );

    expect(tree?.truncated).toBe(true);
    expect(tree?.root.children.length).toBeLessThan(10);
    expect(JSON.stringify(tree).length).toBeLessThanOrEqual(32_000);
  });

  it("stops descending a cyclic tree", async () => {
    const group = {
      role: "group",
      name: "Loop",
      bounds: null,
      children: async () => [group],
    };
    const tree = await accessibleWindowElementTree(
      { role: "window", name: "Inbox", bounds: null, children: async () => [group] },
      { x: 0, y: 0, width: 800, height: 600 },
      { width: 800, height: 600 },
    );

    expect(tree?.truncated).toBe(true);
    expect(tree?.root.name).toBe("Inbox");
  });
});

describe("compactAccessibilityTree", () => {
  it("keeps anonymous groups that organize multiple semantic children", () => {
    const compacted = compactAccessibilityTree({
      role: "window",
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      children: [
        {
          role: "group",
          bounds: { x: 0, y: 0, width: 800, height: 100 },
          children: [
            { role: "button", name: "Back", bounds: null, children: [] },
            { role: "button", name: "Forward", bounds: null, children: [] },
          ],
        },
      ],
    });

    expect(compacted.root.children[0]?.role).toBe("group");
    expect(compacted.root.children[0]?.children).toHaveLength(2);
  });
});

describe("findAccessibleWindow", () => {
  const captured = {
    title: "Editor",
    bounds: { x: 100, y: 200, width: 800, height: 600 },
  };

  it("matches one window by its captured bounds", () => {
    const windows = [
      { name: "Private", bounds: { x: 0, y: 0, width: 400, height: 300 } },
      { name: "Editor", bounds: { x: 101, y: 199, width: 800, height: 601 } },
    ];

    expect(findAccessibleWindow(windows, captured)).toBe(windows[1]);
  });

  it("uses the captured source title when the active title changed", () => {
    const windows = [{ name: "Editor — saved", bounds: captured.bounds }];

    expect(
      findAccessibleWindow(windows, {
        ...captured,
        title: "Editor — saving",
        sourceTitle: "Editor — saved",
      }),
    ).toBe(windows[0]);
  });

  it("uses the active match to disambiguate equal windows", () => {
    const windows = [
      { name: "Editor", bounds: captured.bounds, active: false },
      { name: "Editor", bounds: captured.bounds, active: true },
    ];

    expect(findAccessibleWindow(windows, captured)).toBe(windows[1]);
  });

  it("does not match equal bounds with a different title", () => {
    expect(
      findAccessibleWindow(
        [{ name: "Private", bounds: { x: 100, y: 200, width: 800, height: 600 } }],
        captured,
      ),
    ).toBeUndefined();
  });
});

describe("toElectronAccelerator", () => {
  // The settings recorder stores shortcuts through parseKeybindingShortcut, which lowercases keys.
  it.each([
    ["mod+shift+arrowup", "CommandOrControl+Shift+Up"],
    ["mod+shift+arrowdown", "CommandOrControl+Shift+Down"],
    ["ctrl+alt+arrowleft", "Control+Alt+Left"],
    ["ctrl+alt+arrowright", "Control+Alt+Right"],
    ["mod+shift+esc", "CommandOrControl+Shift+Esc"],
    ["mod+shift+space", "CommandOrControl+Shift+Space"],
    ["mod+shift+2", "CommandOrControl+Shift+2"],
  ])("maps a recorded %s to an Electron accelerator", (recorded, accelerator) => {
    expect(toElectronAccelerator(parseKeybindingShortcut(recorded)!)).toBe(accelerator);
  });
});
