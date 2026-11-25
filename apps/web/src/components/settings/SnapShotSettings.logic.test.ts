import { assert, expect, it } from "vite-plus/test";
import { DEFAULT_CLIENT_SETTINGS, type DesktopSnapShotState } from "@t3tools/contracts";

import {
  createRecordingRequestTracker,
  snapShotStatus,
  snapShotShortcutStatus,
} from "./SnapShotSettings.logic";

it("ignores a stale request after a newer request starts", () => {
  const requests = createRecordingRequestTracker();
  const firstRequest = requests.tryBegin();
  assert(firstRequest);

  requests.clear();
  const secondRequest = requests.tryBegin();
  assert(secondRequest);

  expect(requests.owns(firstRequest)).toBe(false);
  expect(requests.owns(secondRequest)).toBe(true);
  expect(requests.tryBegin()).toBeNull();
});

it("reports Windows direct capture status across opt-in, saved, and verified states", () => {
  const base: DesktopSnapShotState = {
    mode: "direct",
    shortcut: DEFAULT_CLIENT_SETTINGS.snapShotShortcut,
    shortcutRegistered: true,
    shortcutMessage: null,
    message: null,
  };

  expect(DEFAULT_CLIENT_SETTINGS.snapShotEnabled).toBe(false);
  expect(snapShotStatus(base, false)).toBe("Turn this on to set up snapshots.");
  expect(snapShotStatus(base, true)).toBe("Shortcut saved");
  expect(snapShotStatus({ ...base, shortcutVerified: true }, true)).toBe("Ready to capture");
  expect(snapShotStatus({ ...base, shortcutRegistered: false }, true)).toBe(
    "Finish shortcut setup",
  );
  expect(snapShotStatus({ ...base, message: "Could not capture the active window." }, true)).toBe(
    "Capture needs attention",
  );
  expect(snapShotShortcutStatus(base)).toBe("Shortcut saved.");
  expect(
    snapShotShortcutStatus({
      ...base,
      shortcutRegistered: false,
      shortcutMessage: "This shortcut is already used by the system or another app.",
    }),
  ).toBe("This shortcut is already used by the system or another app.");
});
