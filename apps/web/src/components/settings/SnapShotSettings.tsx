import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { m } from "~/i18n/messages";
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  type ClientSettingsPatch,
  type DesktopSnapShotShortcutAvailability,
  type SnapShotShortcut,
} from "@t3tools/contracts";
import { PlayIcon } from "lucide-react";
import { useContext, useRef, useState } from "react";
import { T, useGT, useMessages } from "gt-react";

import { useClientSettings, updateClientSettings } from "../../hooks/useSettings";
import { getDesktopSnapShotBridge } from "../../lib/desktopSnapShot";
import { sameSnapShotShortcut, snapShotKeybindingConflict } from "../../lib/snapShotShortcut";
import { playSnapShotSound } from "../../lib/snapShotSound";
import {
  desktopSnapShotAtom,
  refreshDesktopSnapShotState,
  snapShotSetupError,
} from "../../state/desktopSnapShot";
import { toastManager } from "../ui/toast";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { commandLabel } from "./KeybindingsSettings.logic";
import {
  snapShotStatus,
  snapShotShortcutStatus,
  snapShotUnavailableMessage,
  snapShotSoundPatch,
  type SnapShotSoundSelection,
} from "./SnapShotSettings.logic";
import {
  SettingsUnavailableGroup,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";
import { SelectButton } from "../ui/select";
import { Switch } from "../ui/switch";
import { useSnapShotShortcutRecorder } from "./useSnapShotShortcutRecorder";

const soundOptionRowClassName = "grid grid-cols-[1fr_auto]";

type ShortcutCheck =
  | { readonly status: "idle"; readonly availability: null }
  | {
      readonly status: "checking";
      readonly availability: null;
      readonly shortcut: SnapShotShortcut;
      readonly savedShortcut: SnapShotShortcut;
    }
  | {
      readonly status: "checked";
      readonly shortcut: SnapShotShortcut;
      readonly savedShortcut: SnapShotShortcut;
      readonly availability: DesktopSnapShotShortcutAvailability;
    };

export function SnapShotSettings() {
  const messages = useMessages();
  const setting = useSearchableSetting();
  const gt = useGT();
  const settings = useClientSettings((current) => ({
    snapShotAnimations: current.snapShotAnimations,
    snapShotEnabled: current.snapShotEnabled,
    snapShotFlash: current.snapShotFlash,
    snapShotIncludeAccessibility: current.snapShotIncludeAccessibility,
    snapShotPlaySound: current.snapShotPlaySound,
    snapShotShortcut: current.snapShotShortcut,
    snapShotSound: current.snapShotSound,
  }));
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const bridge = getDesktopSnapShotBridge();
  const registry = useContext(RegistryContext);
  const { state, refreshError } = useAtomValue(desktopSnapShotAtom);
  const [setupBusy, setSetupBusy] = useState(false);

  const reportSetupError = (title: string, error: unknown) => {
    const report = snapShotSetupError(title, error);
    toastManager.add({ type: "error", title: report.title, description: report.message });
  };
  const refreshState = () =>
    refreshDesktopSnapShotState(registry, (error) =>
      reportSetupError(gt("Couldn't check capture setup"), error),
    );
  const [candidate, setCandidate] = useState<SnapShotShortcut>(settings.snapShotShortcut);
  const [latestShortcutCheck, setShortcutCheck] = useState<ShortcutCheck>({
    status: "idle",
    availability: null,
  });
  // A check answers for one candidate against one saved shortcut. Once either moves on (an edit,
  // or hydration saving a new shortcut) a late answer no longer shows, so a check for the
  // shortcut that just got saved can't claim it is ready to save.
  const savedShortcut = settings.snapShotShortcut;
  const shortcutCheck: ShortcutCheck =
    latestShortcutCheck.status === "idle" ||
    (sameSnapShotShortcut(latestShortcutCheck.shortcut, candidate) &&
      sameSnapShotShortcut(latestShortcutCheck.savedShortcut, savedShortcut))
      ? latestShortcutCheck
      : { status: "idle", availability: null };
  const shortcutCheckIdRef = useRef(0);
  const unavailableMessage = snapShotUnavailableMessage(Boolean(bridge), messages);
  const captureAvailable = Boolean(bridge) && state !== null && state.mode !== "unavailable";
  const shortcutChanged = !sameSnapShotShortcut(candidate, savedShortcut);
  const displayShortcut = shortcutChanged ? candidate : (state?.shortcut ?? savedShortcut);
  const candidateConflict = shortcutChanged
    ? snapShotKeybindingConflict(candidate, keybindings)
    : null;
  const canSaveShortcut =
    shortcutChanged && candidateConflict === null && shortcutCheck.availability?.available === true;
  const soundSelection = settings.snapShotPlaySound ? settings.snapShotSound : "off";
  const soundLabel =
    soundSelection === "off"
      ? gt("Off", { $context: "snapshot sound turned off" })
      : soundSelection === "soft-pop"
        ? gt("Whoosh (Default)")
        : gt("Click", { $context: "name of a camera-shutter sound" });

  // Hydration can hand back an equal shortcut object; only a different shortcut resets the edit.
  const [renderedSavedShortcut, setRenderedSavedShortcut] = useState(savedShortcut);
  if (!sameSnapShotShortcut(renderedSavedShortcut, savedShortcut)) {
    setRenderedSavedShortcut(savedShortcut);
    setCandidate(savedShortcut);
    setShortcutCheck({ status: "idle", availability: null });
  }

  const save = async (patch: ClientSettingsPatch) => {
    try {
      await updateClientSettings(patch);
      return await refreshState();
    } catch (error) {
      reportSetupError(gt("Couldn't save capture settings"), error);
    }
  };

  const checkShortcut = async (shortcut: SnapShotShortcut) => {
    const checkId = ++shortcutCheckIdRef.current;
    setCandidate(shortcut);
    const conflict = snapShotKeybindingConflict(shortcut, keybindings);
    if (conflict || !bridge) return;
    setShortcutCheck({ status: "checking", availability: null, shortcut, savedShortcut });
    try {
      const availability = await bridge.checkSnapShotShortcut(shortcut);
      if (checkId === shortcutCheckIdRef.current) {
        setShortcutCheck({ status: "checked", availability, shortcut, savedShortcut });
      }
    } catch (error) {
      if (checkId !== shortcutCheckIdRef.current) return;
      setShortcutCheck({
        status: "checked",
        shortcut,
        savedShortcut,
        availability: {
          available: false,
          message:
            error instanceof Error
              ? (thrownErrorMessage(error, m) ?? error.message)
              : gt("Could not check this shortcut."),
        },
      });
    }
  };

  const {
    recording,
    stopRecording,
    input: shortcutInput,
  } = useSnapShotShortcutRecorder({
    shortcut: displayShortcut,
    disabled: setupBusy,
    onRecord: (shortcut) => void checkShortcut(shortcut),
    onStart: () => {
      shortcutCheckIdRef.current++;
      setShortcutCheck({ status: "idle", availability: null });
    },
    onError: (message) =>
      setShortcutCheck({
        status: "checked",
        shortcut: candidate,
        savedShortcut,
        availability: { available: false, message },
      }),
  });

  const shortcutStatus = recording
    ? gt("Press your shortcut. Esc cancels.")
    : candidateConflict
      ? gt('T3 Code already uses this for "{command}".', {
          command: commandLabel(candidateConflict, messages),
        })
      : shortcutCheck.status === "checking"
        ? gt("Checking shortcut…")
        : shortcutCheck.availability
          ? shortcutCheck.availability.available
            ? gt("Ready to save.")
            : shortcutCheck.availability.message
          : snapShotShortcutStatus(state, messages);

  const saveShortcut = async () => {
    if (!canSaveShortcut || setupBusy) return false;
    setSetupBusy(true);
    const saved = await save({ snapShotShortcut: candidate }).finally(() => setSetupBusy(false));
    return Boolean(saved?.shortcutRegistered);
  };

  return (
    <SettingsPageContainer>
      <SettingsSection id="snap-shot" title={gt("SnapShots")}>
        <SettingsUnavailableGroup message={unavailableMessage}>
          <SettingsRow
            {...setting("snap-shot-enabled")}
            description={gt("Capture a window and attach it to your current draft.")}
            status={
              bridge
                ? setupBusy
                  ? gt("Updating capture settings…")
                  : refreshError
                    ? `${refreshError.title}. ${refreshError.message}`
                    : snapShotStatus(state, settings.snapShotEnabled, messages)
                : undefined
            }
            control={
              <Switch
                checked={settings.snapShotEnabled}
                disabled={!captureAvailable || setupBusy}
                aria-label={gt("Enable snapshots")}
                onCheckedChange={(checked) => void save({ snapShotEnabled: checked })}
              />
            }
          />
          {settings.snapShotEnabled && captureAvailable ? (
            <>
              <SettingsRow
                {...setting("snap-shot-accessibility")}
                description={gt("Include text and controls when the app makes them available.")}
                control={
                  <Switch
                    checked={settings.snapShotIncludeAccessibility}
                    disabled={!captureAvailable}
                    aria-label={gt("Include app text in snapshots")}
                    onCheckedChange={(checked) =>
                      void save({ snapShotIncludeAccessibility: checked })
                    }
                  />
                }
              />
              <SettingsRow
                {...setting("snap-shot-shortcut")}
                description={gt("Capture the window you're using without switching apps.")}
                status={shortcutStatus}
                control={
                  <>
                    {shortcutInput}
                    {shortcutChanged ? (
                      <>
                        <Button
                          size="xs"
                          disabled={!canSaveShortcut || setupBusy}
                          onClick={() => void saveShortcut()}
                        >
                          {setupBusy ? gt("Saving…") : gt("Save")}
                        </Button>
                        <Button
                          size="xs"
                          variant="ghost"
                          disabled={setupBusy}
                          onClick={() => {
                            stopRecording();
                            shortcutCheckIdRef.current++;
                            setCandidate(savedShortcut);
                            setShortcutCheck({ status: "idle", availability: null });
                          }}
                        >
                          <T>Cancel</T>
                        </Button>
                      </>
                    ) : null}
                  </>
                }
              />
              <SettingsRow
                {...setting("snap-shot-sound")}
                description={gt("Choose the sound played when capture starts.")}
                control={
                  <Menu>
                    <MenuTrigger
                      aria-label={gt("Snapshot sound: {sound}", { sound: soundLabel })}
                      render={<SelectButton size="sm" />}
                      className="w-auto min-w-0"
                      disabled={!captureAvailable}
                    >
                      {soundSelection === "off" ? (
                        gt("Off", { $context: "snapshot sound turned off" })
                      ) : soundSelection === "soft-pop" ? (
                        <T>
                          Whoosh <span className="text-muted-foreground">(Default)</span>
                        </T>
                      ) : (
                        gt("Click", { $context: "name of a camera-shutter sound" })
                      )}
                    </MenuTrigger>
                    <MenuPopup align="end">
                      <MenuRadioGroup
                        onValueChange={(value) =>
                          void save(snapShotSoundPatch(value as SnapShotSoundSelection))
                        }
                        value={soundSelection}
                      >
                        <MenuRadioItem closeOnClick value="off">
                          {gt("Off", { $context: "snapshot sound turned off" })}
                        </MenuRadioItem>
                        <div className={soundOptionRowClassName}>
                          <MenuRadioItem closeOnClick value="soft-pop">
                            <T>
                              Whoosh <span className="text-muted-foreground">(Default)</span>
                            </T>
                          </MenuRadioItem>
                          <MenuItem
                            aria-label={gt("Play Whoosh")}
                            closeOnClick={false}
                            onClick={() => playSnapShotSound("soft-pop")}
                          >
                            <PlayIcon />
                          </MenuItem>
                        </div>
                        <div className={soundOptionRowClassName}>
                          <MenuRadioItem closeOnClick value="camera-shutter">
                            {gt("Click", { $context: "name of a camera-shutter sound" })}
                          </MenuRadioItem>
                          <MenuItem
                            aria-label={gt("Play Click")}
                            closeOnClick={false}
                            onClick={() => playSnapShotSound("camera-shutter")}
                          >
                            <PlayIcon />
                          </MenuItem>
                        </div>
                      </MenuRadioGroup>
                    </MenuPopup>
                  </Menu>
                }
              />
              <SettingsRow
                {...setting("snap-shot-flash")}
                description={gt("Show a gentle cue on the captured window.")}
                control={
                  <Switch
                    checked={settings.snapShotFlash}
                    disabled={!captureAvailable}
                    aria-label={gt("Flash captured window")}
                    onCheckedChange={(checked) => void save({ snapShotFlash: checked })}
                  />
                }
              />
              <SettingsRow
                {...setting("snap-shot-animations")}
                description={gt("Animate captured windows into your draft.")}
                control={
                  <Switch
                    checked={settings.snapShotAnimations}
                    disabled={!captureAvailable}
                    aria-label={gt("Animate snapshots")}
                    onCheckedChange={(checked) => void save({ snapShotAnimations: checked })}
                  />
                }
              />
            </>
          ) : null}
        </SettingsUnavailableGroup>
      </SettingsSection>
    </SettingsPageContainer>
  );
}
