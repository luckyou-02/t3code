import type { ClientSettingsPatch, DesktopSnapShotState, SnapShotSound } from "@t3tools/contracts";
import { msg } from "gt-react";

import { m, type MessageResolver } from "../../i18n/messages";

export function snapShotStatus(
  state: DesktopSnapShotState | null,
  enabled: boolean,
  resolve: MessageResolver = m,
): string {
  if (!state) return resolve(msg("Checking snapshots…"));
  if (state.mode === "unavailable")
    return state.message ?? resolve(msg("Not supported on this platform."));
  if (!enabled) return resolve(msg("Turn this on to set up snapshots."));
  if (state.message) return resolve(msg("Capture needs attention"));
  if (state.shortcutVerified) return resolve(msg("Ready to capture"));
  if (state.shortcutRegistered) return resolve(msg("Shortcut saved"));
  return resolve(msg("Finish shortcut setup"));
}

export function snapShotShortcutStatus(
  state: DesktopSnapShotState | null,
  resolve: MessageResolver = m,
): string | null {
  if (!state) return null;
  if (state.shortcutRegistered) return resolve(msg("Shortcut saved."));
  return state.shortcutMessage;
}

export type SnapShotSoundSelection = SnapShotSound | "off";

export function snapShotUnavailableMessage(
  hasBridge: boolean,
  resolve: MessageResolver = m,
): string | undefined {
  if (hasBridge) return undefined;
  return typeof window !== "undefined" && window.desktopBridge
    ? resolve(msg("Update the desktop app to use snapshots."))
    : resolve(msg("Only available in the desktop app."));
}

export function snapShotSoundPatch(sound: SnapShotSoundSelection): ClientSettingsPatch {
  return sound === "off"
    ? { snapShotPlaySound: false }
    : { snapShotPlaySound: true, snapShotSound: sound };
}

export function createRecordingRequestTracker() {
  let currentRequest: symbol | null = null;

  return {
    tryBegin() {
      if (currentRequest) return null;
      currentRequest = Symbol();
      return currentRequest;
    },
    clear() {
      currentRequest = null;
    },
    owns(request: symbol) {
      return currentRequest === request;
    },
  };
}
