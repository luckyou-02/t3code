import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { m as resolveMessage } from "~/i18n/messages";
import { SessionPermissions } from "./SessionPermissions";
import { useSearch } from "@tanstack/react-router";
import { ChevronRightIcon, EllipsisIcon } from "lucide-react";
import { useAtomValue } from "@effect/atom-react";
import { type ReactNode, useState } from "react";
import { T, useGT, useMessages, Var } from "gt-react";
import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  AuthEnvironmentMaintainScope,
  type AuthClientSession,
  type AuthPairingLink,
  type DesktopWslState,
  EnvironmentId,
  resolveEnvironmentMachineKind,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";

import { isLocalEnvironmentDisabled } from "../../localEnvironment";
import {
  applyWslEnableSelection,
  isWslSettingsRowVisible,
  resolveLocalVersionStatusLabel,
} from "./ConnectionsSettings.logic";
import { settingsScopeEnvironmentLabel } from "./settingsScopeAxis";
import { useAccessEnvironment } from "./useAccessEnvironment";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { ManagedByOrganization } from "../ManagedPolicy";
import { useSearchableSetting } from "./settingsSearch";
import { EnvironmentIconMenu } from "./EnvironmentIconPicker";
import { FoldedSettingsSection } from "./FoldedSettingsSection";
import { LoadBalancingSettings } from "./LoadBalancingSettings";
import { PullRequestRoutingSettings } from "./PullRequestRoutingSettings";
import { ScrollArea } from "../ui/scroll-area";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Spinner } from "../ui/spinner";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Menu, MenuPopup, MenuTrigger } from "../ui/menu";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Button } from "../ui/button";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { type ServerClientSessionRecord } from "~/environments/primary";
import { isDesktopLocalConnectionTarget } from "~/connection/desktopLocal";
import {
  resolveServerConfigVersionMismatch,
  resolveServerSelfUpdateCapability,
  supportsDesktopAppUpdate,
} from "~/versionSkew";
import { authEnvironment } from "~/state/auth";
import { readEnvironmentScope, useEnvironmentScope } from "~/state/session";
import { useEnvironmentQuery } from "~/state/query";
import { desktopWslAccessStateAtom, refreshDesktopWslState } from "~/state/desktopWslState";
import { useDesktopUpdateState } from "~/state/desktopUpdate";
import { useEnvironment, useEnvironments, usePrimaryEnvironment } from "~/state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { serverEnvironment } from "~/state/server";
import { ServerUpdateAction, ServerUpdateProgress } from "../ServerUpdateAction";
import {
  sortDesktopPairingLinks,
  summarizeAuthorizedClients,
  sortDesktopClientSessions,
  toDesktopPairingLinkRecord,
  toDesktopClientSessionRecord,
} from "./ConnectionsSettings.logic";
import { AuthorizedClientsHeaderAction, PairingClientsList } from "./AuthorizedClientsSettings";
import { ITEM_ROW_CLASSNAME } from "./itemRows";

// Colons are invalid in distro names, keeping picker sentinels collision-free.
const BACKEND_VALUE_DEFAULT_WSL = "backend:default-wsl";
const BACKEND_VALUE_WSL_OFF = "backend:wsl-off";

// Subscribes on its own so desktop download progress does not re-render the page.
function LocalVersionStatusLabel() {
  const m = useMessages();
  const updateState = useDesktopUpdateState();
  return (
    <span className="text-xs text-muted-foreground">
      {resolveLocalVersionStatusLabel(updateState, m)}
    </span>
  );
}

/** Environments lists the machines this app connects to; access covers who may reach one of them. */
export function ConnectionsSettings({ view }: { readonly view: "environments" | "access" }) {
  return view === "access" ? (
    <AccessSettings />
  ) : (
    <ConnectionsSettingsContent view="environments" accessEnvironmentId={null} />
  );
}

function AccessSettings() {
  const gt = useGT();
  // A link that names an environment, such as the MCP wizard's, opens the page on it. The
  // settings layout remounts this page when the link changes.
  const linkedEnvironmentId = useSearch({
    strict: false,
    select: (search) =>
      typeof search.machine === "string" ? EnvironmentId.make(search.machine) : null,
  });
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState(linkedEnvironmentId);
  const { candidates, environment: accessEnvironment } =
    useAccessEnvironment(selectedEnvironmentId);
  const accessEnvironmentId = accessEnvironment?.environmentId ?? null;
  const picker =
    candidates.length > 1 && accessEnvironmentId !== null ? (
      <div className="flex min-w-0 items-center gap-1.5 px-3 text-sm text-muted-foreground sm:px-4">
        <span className="shrink-0">
          <T>Showing access for</T>
        </span>
        <Select
          value={accessEnvironmentId}
          onValueChange={(next) => {
            if (next !== null) setSelectedEnvironmentId(next);
          }}
        >
          <SelectTrigger size="sm" className="w-auto max-w-72" aria-label={gt("Environment")}>
            <SelectValue>
              {(value: EnvironmentId) => {
                const environment = candidates.find(
                  (candidate) => candidate.environmentId === value,
                );
                return environment ? settingsScopeEnvironmentLabel(environment, candidates) : null;
              }}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup alignItemWithTrigger={false}>
            {candidates.map((environment) => (
              <SelectItem
                hideIndicator
                key={environment.environmentId}
                value={environment.environmentId}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <EnvironmentMachineIcon
                    aria-hidden
                    kind={resolveEnvironmentMachineKind(environment.serverConfig)}
                    className="size-3.5 shrink-0"
                  />
                  <span className="min-w-0 truncate">
                    {settingsScopeEnvironmentLabel(environment, candidates)}
                  </span>
                  {environment.connection.phase !== "connected" ? (
                    <span className="shrink-0 text-xs text-muted-foreground">
                      <T>Offline</T>
                    </span>
                  ) : null}
                </span>
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>
    ) : null;
  // Keyed so pairing credentials and pending work never carry over to another environment.
  return (
    <ConnectionsSettingsContent
      key={accessEnvironmentId ?? "none"}
      view="access"
      accessEnvironmentId={accessEnvironmentId}
      accessEnvironmentPicker={picker}
    />
  );
}

function ConnectionsSettingsContent({
  view,
  accessEnvironmentId,
  accessEnvironmentPicker = null,
}: {
  readonly view: "environments" | "access";
  readonly accessEnvironmentId: EnvironmentId | null;
  readonly accessEnvironmentPicker?: ReactNode;
}) {
  const searchableSetting = useSearchableSetting();
  const gt = useGT();
  const m = useMessages();
  const desktopBridge = window.desktopBridge;
  const { environments } = useEnvironments();
  const primaryEnvironment = usePrimaryEnvironment();
  const primaryEnvironmentId = primaryEnvironment?.environmentId ?? null;
  const accessEnvironment = useEnvironment(accessEnvironmentId);
  const isPrimaryAccess =
    accessEnvironmentId !== null && accessEnvironmentId === primaryEnvironmentId;
  const loadBalancingEnvironments = environments.filter(
    (environment) => environment.entry.enabled && environment.connection.phase !== "unsupported",
  );
  const [desktopAccessManagementMutationError, setDesktopAccessManagementMutationError] = useState<
    string | null
  >(null);
  const [revokingDesktopPairingLinkId, setRevokingDesktopPairingLinkId] = useState<string | null>(
    null,
  );
  const [revokingDesktopClientSessionId, setRevokingDesktopClientSessionId] = useState<
    string | null
  >(null);
  const [isRevokingOtherDesktopClients, setIsRevokingOtherDesktopClients] = useState(false);
  const [isUpdatingWslBackend, setIsUpdatingWslBackend] = useState(false);
  const [desktopWslMutationError, setDesktopWslMutationError] = useState<string | null>(null);
  type PendingWslChange =
    | { readonly kind: "disable"; readonly wasWslOnly: boolean }
    | { readonly kind: "distro"; readonly nextDistro: string | null }
    | { readonly kind: "enable"; readonly nextDistro: string | null }
    | { readonly kind: "wsl-only"; readonly nextValue: boolean };
  const [pendingWslChange, setPendingWslChange] = useState<PendingWslChange | null>(null);
  const isWslConfirmDialogOpen = pendingWslChange !== null;
  const primaryServerConfig = primaryEnvironment?.serverConfig ?? null;
  const primaryVersionMismatch = resolveServerConfigVersionMismatch(primaryServerConfig, m);
  const primaryServerUpdateState = useAtomValue(
    serverEnvironment.updateStateAtom(primaryEnvironmentId),
  );
  const canReadAccess = useEnvironmentScope(accessEnvironmentId, AuthAccessReadScope);
  const canWriteAccess = useEnvironmentScope(accessEnvironmentId, AuthAccessWriteScope);
  const canMaintain = useEnvironmentScope(accessEnvironmentId, AuthEnvironmentMaintainScope);
  const canManageLocalBackend = isPrimaryAccess && !isLocalEnvironmentDisabled() && canMaintain;
  const showsAccess = view === "access";
  const authAccessChanges = useEnvironmentQuery(
    showsAccess && canReadAccess && accessEnvironmentId !== null
      ? authEnvironment.accessChanges({
          environmentId: accessEnvironmentId,
          input: null,
        })
      : null,
    m,
  );
  const revokePairingLink = useAtomCommand(authEnvironment.revokePairingLink, {
    reportFailure: false,
  });
  const revokeClient = useAtomCommand(authEnvironment.revokeClient, { reportFailure: false });
  const revokeOtherClients = useAtomCommand(authEnvironment.revokeOtherClients, {
    reportFailure: false,
  });
  const desktopWsl = useEnvironmentQuery(
    showsAccess && canManageLocalBackend && desktopBridge ? desktopWslAccessStateAtom : null,
    m,
  );
  const desktopWslState = desktopWsl.data;
  const desktopWslError = desktopWslMutationError ?? desktopWsl.error;
  const isLoadingWslState = desktopWsl.isPending && desktopWsl.data === null;
  const desktopAccessManagementError =
    desktopAccessManagementMutationError ?? authAccessChanges.error;
  const isLoadingDesktopAccessManagement =
    authAccessChanges.isPending && authAccessChanges.data === null;
  const desktopPairingLinks = (() => {
    const event = authAccessChanges.data;
    if (event?.type !== "snapshot") return [];
    return sortDesktopPairingLinks(
      event.payload.pairingLinks.map((pairingLink: AuthPairingLink) =>
        toDesktopPairingLinkRecord(pairingLink),
      ),
    );
  })();
  const desktopClientSessions = (() => {
    const event = authAccessChanges.data;
    if (event?.type !== "snapshot") return [];
    return sortDesktopClientSessions(
      event.payload.clientSessions.map((clientSession: AuthClientSession) =>
        toDesktopClientSessionRecord(clientSession),
      ),
    );
  })();
  const handleRevokeDesktopPairingLink = async (id: string) => {
    if (
      accessEnvironmentId === null ||
      !readEnvironmentScope(accessEnvironmentId, AuthAccessWriteScope)
    )
      return;
    setRevokingDesktopPairingLinkId(id);
    setDesktopAccessManagementMutationError(null);
    const result = await revokePairingLink({ environmentId: accessEnvironmentId, input: { id } });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      const message =
        error instanceof Error
          ? (thrownErrorMessage(error, resolveMessage) ?? error.message)
          : gt("Failed to revoke pairing link.");
      setDesktopAccessManagementMutationError(message);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: gt("Could not revoke pairing link"),
          description: message,
        }),
      );
    }
    setRevokingDesktopPairingLinkId(null);
  };

  const handleRevokeDesktopClientSession = async (
    sessionId: ServerClientSessionRecord["sessionId"],
  ) => {
    if (
      accessEnvironmentId === null ||
      !readEnvironmentScope(accessEnvironmentId, AuthAccessWriteScope)
    )
      return;
    setRevokingDesktopClientSessionId(sessionId);
    setDesktopAccessManagementMutationError(null);
    const result = await revokeClient({ environmentId: accessEnvironmentId, input: { sessionId } });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      const message =
        error instanceof Error
          ? (thrownErrorMessage(error, resolveMessage) ?? error.message)
          : gt("Failed to revoke client access.");
      setDesktopAccessManagementMutationError(message);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: gt("Could not revoke client access"),
          description: message,
        }),
      );
    }
    setRevokingDesktopClientSessionId(null);
  };

  const handleRevokeOtherDesktopClients = async () => {
    if (
      accessEnvironmentId === null ||
      !readEnvironmentScope(accessEnvironmentId, AuthAccessWriteScope)
    )
      return;
    setIsRevokingOtherDesktopClients(true);
    setDesktopAccessManagementMutationError(null);
    const result = await revokeOtherClients({ environmentId: accessEnvironmentId, input: null });
    if (result._tag === "Success") {
      toastManager.add({
        type: "success",
        title:
          result.value === 1
            ? gt("Revoked 1 other client")
            : gt("{count, plural, other {Revoked {count} clients}}", { count: result.value }),
        description: gt("Other paired clients will need a new pairing link before reconnecting."),
      });
    } else if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      const message =
        error instanceof Error
          ? (thrownErrorMessage(error, resolveMessage) ?? error.message)
          : gt("Failed to revoke other clients.");
      setDesktopAccessManagementMutationError(message);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: gt("Could not revoke other clients"),
          description: message,
        }),
      );
    }
    setIsRevokingOtherDesktopClients(false);
  };

  const requestRevokeClientSession = (sessionId: ServerClientSessionRecord["sessionId"]) =>
    void handleRevokeDesktopClientSession(sessionId);
  const requestRevokeOtherClients = () => void handleRevokeOtherDesktopClients();
  const applyWslSettingChange = async (apply: () => Promise<DesktopWslState>) => {
    if (
      !desktopBridge ||
      primaryEnvironmentId === null ||
      !readEnvironmentScope(primaryEnvironmentId, AuthEnvironmentMaintainScope)
    )
      return;
    setIsUpdatingWslBackend(true);
    setDesktopWslMutationError(null);
    const settled = await settlePromise(async () => {
      await apply();
      refreshDesktopWslState();
    });
    if (settled._tag === "Failure") {
      const error = Cause.squash(settled.cause);
      const message =
        error instanceof Error
          ? (thrownErrorMessage(error, resolveMessage) ?? error.message)
          : gt("Failed to update WSL backend.");
      setDesktopWslMutationError(message);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: gt("Could not change WSL backend"),
          description: message,
        }),
      );
      refreshDesktopWslState();
    }
    setIsUpdatingWslBackend(false);
  };

  const loadWslState = () => {
    setDesktopWslMutationError(null);
    refreshDesktopWslState();
  };

  const hasWslRegistrationToLose = environments.some((environment) =>
    isDesktopLocalConnectionTarget(environment.entry.target),
  );

  const handleSelectWslMode = (value: string) => {
    if (!desktopBridge || !desktopWslState) return;
    const defaultDistroName =
      desktopWslState.distros.find((distro) => distro.isDefault)?.name ?? null;
    if (value === BACKEND_VALUE_WSL_OFF) {
      // Unavailable WSL can remain wslOnly while disabled; switching to Windows must clear both.
      if (!desktopWslState.enabled && !desktopWslState.wslOnly) return;
      const wasWslOnly = desktopWslState.wslOnly;
      if (hasWslRegistrationToLose || wasWslOnly) {
        setPendingWslChange({ kind: "disable", wasWslOnly });
        return;
      }
      void applyWslSettingChange(() => desktopBridge.setWslBackendEnabled(false));
      return;
    }
    const nextDistro = value === BACKEND_VALUE_DEFAULT_WSL ? null : value;
    const resolvedNext = nextDistro ?? defaultDistroName;
    if (!desktopWslState.enabled) {
      setPendingWslChange({ kind: "enable", nextDistro });
      return;
    }
    const resolvedCurrent = desktopWslState.distro ?? defaultDistroName;
    if (resolvedCurrent === resolvedNext) return;
    if (hasWslRegistrationToLose || desktopWslState.wslOnly) {
      setPendingWslChange({ kind: "distro", nextDistro });
      return;
    }
    void applyWslSettingChange(() => desktopBridge.setWslDistro(nextDistro));
  };

  const handleConfirmEnableWsl = (mode: "both" | "wsl-only") => {
    if (!desktopBridge || !pendingWslChange || pendingWslChange.kind !== "enable") return;
    const nextDistro = pendingWslChange.nextDistro;
    setPendingWslChange(null);
    const persistedDistro = desktopWslState?.distro ?? null;
    void applyWslSettingChange(() =>
      applyWslEnableSelection({
        bridge: desktopBridge,
        mode,
        nextDistro,
        persistedDistro,
      }),
    );
  };

  const handleToggleWslOnly = (enabled: boolean) => {
    if (!desktopBridge || !desktopWslState || desktopWslState.wslOnly === enabled) return;
    setPendingWslChange({ kind: "wsl-only", nextValue: enabled });
  };

  const handleConfirmWslChange = () => {
    if (!desktopBridge || !pendingWslChange) return;
    const change = pendingWslChange;
    if (change.kind === "enable") return;
    setPendingWslChange(null);
    if (change.kind === "disable") {
      void applyWslSettingChange(async () => {
        const next = await desktopBridge.setWslBackendEnabled(false);
        if (change.wasWslOnly) {
          return await desktopBridge.setWslOnly(false);
        }
        return next;
      });
      return;
    }
    if (change.kind === "distro") {
      void applyWslSettingChange(() => desktopBridge.setWslDistro(change.nextDistro));
      return;
    }
    void applyWslSettingChange(() => desktopBridge.setWslOnly(change.nextValue));
  };

  const renderWslRow = () => {
    if (!desktopWslState) {
      if (
        isWslSettingsRowVisible({ state: null, error: desktopWslError }) &&
        canManageLocalBackend
      ) {
        return (
          <SettingsRow
            {...searchableSetting("wsl-backend")}
            description={gt("Couldn't load the WSL backend state.")}
            status={<span className="block text-destructive">{desktopWslError}</span>}
            control={
              <Button
                size="sm"
                variant="outline"
                onClick={loadWslState}
                disabled={isLoadingWslState}
              >
                {isLoadingWslState ? gt("Retrying…") : gt("Retry")}
              </Button>
            }
          />
        );
      }
      return null;
    }
    if (!isWslSettingsRowVisible({ state: desktopWslState, error: desktopWslError })) {
      return null;
    }
    if (!desktopWslState.available) {
      return (
        <SettingsRow
          {...searchableSetting("wsl-backend")}
          description={gt(
            "WSL is unavailable, so Windows is running instead. Turn WSL off to clear this preference.",
          )}
          status={
            desktopWslError ? (
              <span className="block text-destructive">{desktopWslError}</span>
            ) : null
          }
          control={
            <Button
              size="sm"
              variant="outline"
              disabled={isUpdatingWslBackend}
              onClick={() => handleSelectWslMode(BACKEND_VALUE_WSL_OFF)}
            >
              <T>Switch to Windows</T>
            </Button>
          }
        />
      );
    }
    const defaultDistroName =
      desktopWslState.distros.find((distro) => distro.isDefault)?.name ?? null;
    const selectValue = !desktopWslState.enabled
      ? BACKEND_VALUE_WSL_OFF
      : (desktopWslState.distro ?? defaultDistroName ?? BACKEND_VALUE_DEFAULT_WSL);
    const selectLabel =
      selectValue === BACKEND_VALUE_WSL_OFF
        ? gt("Off", { $context: "WSL backend is off" })
        : selectValue === BACKEND_VALUE_DEFAULT_WSL
          ? gt("Default distro")
          : selectValue;
    return (
      <>
        <SettingsRow
          {...searchableSetting("wsl-backend")}
          description={gt(
            "Run the selected WSL distro alongside Windows. Projects remain on their current filesystem.",
          )}
          status={
            desktopWslError ? (
              <span className="block text-destructive">{desktopWslError}</span>
            ) : desktopWslState.preflightError ? (
              <span className="block text-destructive">
                <T>
                  WSL backend couldn't start: <Var>{desktopWslState.preflightError}</Var>
                </T>
              </span>
            ) : null
          }
          control={
            <Select
              value={selectValue}
              onValueChange={(value) => {
                if (typeof value !== "string") return;
                handleSelectWslMode(value);
              }}
            >
              <SelectTrigger
                size="sm"
                className="w-full sm:w-56"
                aria-label={gt("WSL backend")}
                disabled={isUpdatingWslBackend}
              >
                <SelectValue>{selectLabel}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value={BACKEND_VALUE_WSL_OFF}>
                  {gt("Off", { $context: "WSL backend is off" })}
                </SelectItem>
                {desktopWslState.distros.length === 0 ? (
                  <SelectItem hideIndicator value={BACKEND_VALUE_DEFAULT_WSL}>
                    <T>Default distro</T>
                  </SelectItem>
                ) : (
                  desktopWslState.distros.map((distro) => (
                    <SelectItem hideIndicator key={distro.name} value={distro.name}>
                      {distro.name}
                      {distro.isDefault ? ` ${gt("(default)")}` : ""}
                    </SelectItem>
                  ))
                )}
              </SelectPopup>
            </Select>
          }
        />
        {desktopWslState.enabled ? (
          <SettingsRow
            title={gt("WSL only")}
            description={gt("Run only the WSL backend. yl code restarts when this changes.")}
            className="bg-muted/20 pl-7 sm:pl-8"
            control={
              <Switch
                checked={desktopWslState.wslOnly}
                disabled={isUpdatingWslBackend}
                onCheckedChange={(checked) => handleToggleWslOnly(checked)}
                aria-label={gt("Run WSL only")}
              />
            }
          />
        ) : null}
      </>
    );
  };

  const renderPairingClientsList = (
    pairingLinks: typeof desktopPairingLinks,
    clientSessions: typeof desktopClientSessions,
  ) => (
    <PairingClientsList
      isLoading={isLoadingDesktopAccessManagement}
      pairingLinks={pairingLinks}
      clientSessions={clientSessions}
      revokingPairingLinkId={revokingDesktopPairingLinkId}
      revokingClientSessionId={revokingDesktopClientSessionId}
      onRevokePairingLink={handleRevokeDesktopPairingLink}
      onRevokeClientSession={requestRevokeClientSession}
      canRevoke={canWriteAccess}
    />
  );
  const renderAuthorizedClients = () => (
    <>
      {desktopAccessManagementError ? (
        <div className={ITEM_ROW_CLASSNAME}>
          <p className="text-xs text-destructive">{desktopAccessManagementError}</p>
        </div>
      ) : null}
      {renderPairingClientsList(desktopPairingLinks, desktopClientSessions)}
    </>
  );
  const accessServerConfig = accessEnvironment?.serverConfig ?? null;
  const primarySettings = (
    <>
      {accessEnvironmentPicker}
      {accessEnvironmentId !== null ? (
        <>
          <SettingsSection
            {...searchableSetting("connections-environment")}
            title={
              accessEnvironment?.label ??
              (desktopBridge ? gt("This machine") : gt("Primary environment"))
            }
            icon={
              <EnvironmentMachineIcon
                aria-hidden
                kind={
                  accessServerConfig ? resolveEnvironmentMachineKind(accessServerConfig) : "desktop"
                }
                className="size-4"
              />
            }
            headerAction={
              accessEnvironmentId !== null ? (
                <Menu>
                  <MenuTrigger
                    render={
                      <Button
                        type="button"
                        variant="ghost-muted"
                        size="icon-xs"
                        aria-label={gt("More actions for this machine")}
                      />
                    }
                  >
                    <EllipsisIcon className="size-3.5" />
                  </MenuTrigger>
                  <MenuPopup align="end">
                    <EnvironmentIconMenu
                      environmentId={accessEnvironmentId}
                      serverConfig={accessServerConfig}
                    />
                  </MenuPopup>
                </Menu>
              ) : null
            }
          >
            {accessServerConfig?.managedPolicy ? (
              <div className="px-3 py-2 sm:px-4">
                <ManagedByOrganization policy={accessServerConfig.managedPolicy} />
              </div>
            ) : null}
            {canManageLocalBackend ? (
              <SettingsRow
                title={gt("Version")}
                description={
                  primaryServerUpdateState.status !== "idle" ? (
                    <ServerUpdateProgress state={primaryServerUpdateState} />
                  ) : (
                    [
                      primaryServerConfig?.environment.serverVersion ?? null,
                      primaryEnvironment?.displayUrl ?? null,
                    ]
                      .filter((value): value is string => value !== null)
                      .join(" · ") || gt("Loading…")
                  )
                }
                control={
                  primaryVersionMismatch &&
                  primaryEnvironmentId !== null &&
                  primaryServerUpdateState.status !== "running" ? (
                    <ServerUpdateAction
                      size="sm"
                      environmentId={primaryEnvironmentId}
                      serverLabel={
                        primaryEnvironment
                          ? gt("{environment} server", { environment: primaryEnvironment.label })
                          : gt("server")
                      }
                      selfUpdate={resolveServerSelfUpdateCapability(primaryServerConfig)}
                      installation={
                        primaryServerConfig?.environment.capabilities.serverInstallation
                      }
                      desktopAppUpdate={supportsDesktopAppUpdate(primaryServerConfig)}
                      targetVersion={primaryVersionMismatch.clientVersion}
                      label={
                        primaryServerUpdateState.status === "failed"
                          ? gt("Retry update")
                          : gt("Update to {version}", {
                              version: primaryVersionMismatch.clientVersion,
                            })
                      }
                    />
                  ) : primaryServerUpdateState.status === "idle" && primaryServerConfig ? (
                    <LocalVersionStatusLabel />
                  ) : undefined
                }
              />
            ) : null}
            {canManageLocalBackend && desktopBridge ? renderWslRow() : null}
            {accessEnvironment ? (
              <details className="group px-3 sm:px-4">
                <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-md text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                  <T>Permissions</T>
                  <ChevronRightIcon
                    aria-hidden
                    className="size-3 text-muted-foreground group-open:rotate-90"
                  />
                </summary>
                <SessionPermissions
                  environmentId={accessEnvironment.environmentId}
                  connected={accessEnvironment.connection.phase === "connected"}
                />
              </details>
            ) : null}
          </SettingsSection>

          {canReadAccess ? (
            <FoldedSettingsSection
              id="authorized-clients"
              title={gt("Authorized clients")}
              summary={summarizeAuthorizedClients(desktopClientSessions, desktopPairingLinks, m)}
              control={
                canWriteAccess ? (
                  <AuthorizedClientsHeaderAction
                    clientSessions={
                      canReadAccess &&
                      authAccessChanges.error === null &&
                      authAccessChanges.data?.type === "snapshot"
                        ? desktopClientSessions
                        : null
                    }
                    isRevokingOtherClients={isRevokingOtherDesktopClients}
                    onRevokeOtherClients={requestRevokeOtherClients}
                  />
                ) : undefined
              }
            >
              <ScrollArea
                scrollFade
                chainVerticalScroll
                className="max-h-[22.5rem]"
                data-testid="authorized-clients-scroll-area"
              >
                {renderAuthorizedClients()}
              </ScrollArea>
            </FoldedSettingsSection>
          ) : null}
          <AlertDialog
            open={isWslConfirmDialogOpen && canManageLocalBackend}
            onOpenChange={(open) => {
              if (isUpdatingWslBackend) return;
              if (!open) setPendingWslChange(null);
            }}
          >
            <AlertDialogPopup>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {pendingWslChange?.kind === "disable"
                    ? pendingWslChange.wasWslOnly
                      ? gt("Turn off WSL and switch back to Windows?")
                      : gt("Disable WSL backend?")
                    : pendingWslChange?.kind === "distro"
                      ? gt("Switch WSL distro?")
                      : pendingWslChange?.kind === "enable"
                        ? gt("Start the WSL backend")
                        : pendingWslChange?.nextValue
                          ? gt("Run only the WSL backend?")
                          : gt("Re-enable the Windows backend?")}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {pendingWslChange?.kind === "disable"
                    ? pendingWslChange.wasWslOnly
                      ? gt(
                          "yl code will restart on the Windows backend. Threads and projects opened against WSL stay safe inside the distro and become available again when you re-enable WSL.",
                        )
                      : gt(
                          "The WSL backend will stop. Threads and projects opened against WSL stay safe inside the distro, but they'll be unavailable in yl code until you re-enable WSL.",
                        )
                    : pendingWslChange?.kind === "distro"
                      ? gt(
                          "yl code will restart the WSL backend on the new distro. Sessions still running on the current distro will be interrupted.",
                        )
                      : pendingWslChange?.kind === "enable"
                        ? gt(
                            "Run the WSL backend alongside the Windows one, or stop the Windows backend and use only WSL? You can change this later from Settings.",
                          )
                        : pendingWslChange?.nextValue
                          ? gt(
                              "yl code will restart and start only the WSL backend. Your Windows-side projects won't be accessible until you turn this off again.",
                            )
                          : gt(
                              "yl code will restart and bring the Windows backend back up alongside WSL.",
                            )}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogClose
                  disabled={isUpdatingWslBackend}
                  render={<Button variant="outline" disabled={isUpdatingWslBackend} />}
                >
                  <T>Cancel</T>
                </AlertDialogClose>
                {pendingWslChange?.kind === "enable" ? (
                  <>
                    <Button
                      variant="outline"
                      onClick={() => handleConfirmEnableWsl("wsl-only")}
                      disabled={isUpdatingWslBackend || !canManageLocalBackend}
                    >
                      {isUpdatingWslBackend ? (
                        <>
                          <Spinner size="sm" />
                          <T>Applying…</T>
                        </>
                      ) : (
                        gt("Use only WSL")
                      )}
                    </Button>
                    <Button
                      variant="default"
                      onClick={() => handleConfirmEnableWsl("both")}
                      disabled={isUpdatingWslBackend || !canManageLocalBackend}
                    >
                      {isUpdatingWslBackend ? (
                        <>
                          <Spinner size="sm" />
                          <T>Applying…</T>
                        </>
                      ) : (
                        gt("Run both backends")
                      )}
                    </Button>
                  </>
                ) : (
                  <Button
                    variant={
                      pendingWslChange?.kind === "disable" ||
                      (pendingWslChange?.kind === "wsl-only" && pendingWslChange.nextValue)
                        ? "destructive"
                        : "default"
                    }
                    onClick={handleConfirmWslChange}
                    disabled={isUpdatingWslBackend || !canManageLocalBackend}
                  >
                    {isUpdatingWslBackend ? (
                      <>
                        <Spinner size="sm" />
                        <T>Applying…</T>
                      </>
                    ) : pendingWslChange?.kind === "disable" ? (
                      pendingWslChange.wasWslOnly ? (
                        gt("Switch to Windows")
                      ) : (
                        gt("Disable WSL")
                      )
                    ) : pendingWslChange?.kind === "distro" ? (
                      gt("Switch distro")
                    ) : pendingWslChange?.nextValue ? (
                      gt("Restart and enable")
                    ) : (
                      gt("Restart and disable")
                    )}
                  </Button>
                )}
              </AlertDialogFooter>
            </AlertDialogPopup>
          </AlertDialog>
        </>
      ) : (
        <SettingsSection {...searchableSetting("connections-environment")}>
          <SettingsRow
            title={gt("No environment selected")}
            description={gt("Connect an environment to view its settings and access.")}
          />
        </SettingsSection>
      )}
    </>
  );

  if (showsAccess) return <SettingsPageContainer>{primarySettings}</SettingsPageContainer>;

  return (
    <SettingsPageContainer>
      <SettingsSection title={gt("Environments")} hideTitle>
        {environments.map((environment) => (
          <SettingsRow
            key={environment.environmentId}
            title={environment.label}
            description={environment.displayUrl ?? undefined}
          />
        ))}
      </SettingsSection>
      <LoadBalancingSettings environments={loadBalancingEnvironments} />
      <PullRequestRoutingSettings environments={loadBalancingEnvironments} />
    </SettingsPageContainer>
  );
}
