import * as DateTime from "effect/DateTime";
import { msg } from "gt-react";

import { m, type MessageResolver } from "../../i18n/messages";
import {
  type ServerClientSessionRecord,
  type ServerPairingLinkRecord,
} from "~/environments/primary";
import {
  type AuthClientSession,
  type AuthPairingLink,
  type DesktopBridge,
  type DesktopUpdateState,
  type DesktopWslState,
  type EnvironmentId,
} from "@t3tools/contracts";
import {
  getDesktopUpdateDownloadedVersion,
  resolveDesktopUpdateButtonAction,
} from "../desktopUpdate.logic";

/** Keep terminal:read with terminal:operate to avoid creating unseen shells on every script run. */
export function canRevokeOtherClients(
  clientSessions: ReadonlyArray<{ readonly current: boolean }> | null,
): boolean {
  return clientSessions === null || clientSessions.some((session) => !session.current);
}

type WslEnableBridge = Pick<DesktopBridge, "setWslBackendEnabled" | "setWslDistro" | "setWslOnly">;

/** Never offer loopback URLs as QR targets; scanning devices would connect to themselves. */
export function isWslSettingsRowVisible(input: {
  readonly state: DesktopWslState | null;
  readonly error: string | null;
}): boolean {
  const { state, error } = input;
  return state ? state.available || state.enabled || state.wslOnly : error !== null;
}

/**
 * Once client/server versions match, this passive Version label follows the sidebar update action,
 * including retryable failures. Rechecks retain downloaded-update labels; `state` is null outside desktop.
 */
export function resolveLocalVersionStatusLabel(
  state: DesktopUpdateState | null,
  resolve: MessageResolver = m,
): string {
  if (!state) return resolve(msg("Up to date"));
  if (state.status === "downloading") {
    return state.availableVersion
      ? resolve(msg("Downloading update {version}", { version: state.availableVersion }))
      : resolve(msg("Downloading update"));
  }
  const action = resolveDesktopUpdateButtonAction(state);
  if (
    action === "install" ||
    state.status === "downloaded" ||
    (state.status === "checking" && state.downloadedVersion !== null)
  ) {
    const version = getDesktopUpdateDownloadedVersion(state);
    return version
      ? resolve(msg("Update {version} downloaded", { version }))
      : resolve(msg("Update downloaded"));
  }
  if (action === "download") {
    return state.availableVersion
      ? resolve(msg("Update {version} available", { version: state.availableVersion }))
      : resolve(msg("Update available"));
  }
  return resolve(msg("Up to date"));
}

export async function applyWslEnableSelection(input: {
  readonly bridge: WslEnableBridge;
  readonly mode: "both" | "wsl-only";
  readonly nextDistro: string | null;
  readonly persistedDistro: string | null;
}): Promise<DesktopWslState> {
  const { bridge, mode, nextDistro, persistedDistro } = input;

  // Stage preferences before enabling; only the final call should relaunch WSL with the complete selection.
  await bridge.setWslOnly(mode === "wsl-only");
  if (persistedDistro !== nextDistro) {
    await bridge.setWslDistro(nextDistro);
  }
  return await bridge.setWslBackendEnabled(true);
}

const accessTimestampFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

export function formatAccessTimestamp(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return accessTimestampFormatter.format(parsed);
}

export function sortDesktopPairingLinks(links: ReadonlyArray<ServerPairingLinkRecord>) {
  return [...links].toSorted(
    (left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime(),
  );
}

export function summarizeAuthorizedClients(
  sessions: ReadonlyArray<ServerClientSessionRecord>,
  links: ReadonlyArray<ServerPairingLinkRecord>,
  resolve: MessageResolver = m,
): string {
  const parts = [
    resolve(
      msg("{count, plural, one {{count} client} other {{count} clients}}", {
        count: sessions.length,
      }),
    ),
    links.length > 0
      ? resolve(
          msg("{count, plural, one {{count} pairing link} other {{count} pairing links}}", {
            count: links.length,
          }),
        )
      : null,
  ];
  return parts.filter((part): part is string => part !== null).join(" · ");
}

export function sortDesktopClientSessions(sessions: ReadonlyArray<ServerClientSessionRecord>) {
  return [...sessions].toSorted((left, right) => {
    if (left.current !== right.current) {
      return left.current ? -1 : 1;
    }
    if (left.connected !== right.connected) {
      return left.connected ? -1 : 1;
    }
    return new Date(right.issuedAt).getTime() - new Date(left.issuedAt).getTime();
  });
}

export function toDesktopPairingLinkRecord(pairingLink: AuthPairingLink): ServerPairingLinkRecord {
  return {
    ...pairingLink,
    scopes: pairingLink.permissions ?? pairingLink.scopes,
    createdAt: DateTime.formatIso(pairingLink.createdAt),
    expiresAt: DateTime.formatIso(pairingLink.expiresAt),
  };
}

export function toDesktopClientSessionRecord(
  clientSession: AuthClientSession,
): ServerClientSessionRecord {
  return {
    ...clientSession,
    scopes: clientSession.permissions ?? clientSession.scopes,
    issuedAt: DateTime.formatIso(clientSession.issuedAt),
    expiresAt: DateTime.formatIso(clientSession.expiresAt),
    lastConnectedAt:
      clientSession.lastConnectedAt === null
        ? null
        : DateTime.formatIso(clientSession.lastConnectedAt),
  };
}

export function resolveAccessEnvironmentId(input: {
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly connected: boolean;
  }>;
  readonly selected: EnvironmentId | null;
}): EnvironmentId | null {
  const isListed = (environmentId: EnvironmentId | null) =>
    input.environments.some((environment) => environment.environmentId === environmentId);
  if (isListed(input.selected)) return input.selected;
  if (isListed(input.primaryEnvironmentId)) return input.primaryEnvironmentId;
  return (
    (input.environments.find((environment) => environment.connected) ?? input.environments[0])
      ?.environmentId ?? null
  );
}
