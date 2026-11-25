import {
  isLocalLoopbackHost,
  isPrivateNetworkHost,
  isSharedAddressSpaceHost,
  isTailnetHost,
} from "@t3tools/shared/hostClassification";
import * as Option from "effect/Option";

import { type ConnectionCatalogEntry, type ConnectionRoute } from "./catalog.ts";
import { type ConnectionTarget } from "./model.ts";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

export type ConnectionRouteKind = "relay" | "loopback" | "lan" | "tailnet" | "vpn" | "public";

export const RELAY_ROUTE_ID = "relay";

export function connectionRouteId(target: ConnectionTarget): string {
  switch (target._tag) {
    case "PrimaryConnectionTarget":
      return "primary";
    case "RelayConnectionTarget":
      return RELAY_ROUTE_ID;
    case "BearerConnectionTarget":
      return target.connectionId;
  }
}

export function connectionRoutes(entry: ConnectionCatalogEntry): ReadonlyArray<ConnectionRoute> {
  return [{ target: entry.target, profile: entry.profile }, ...(entry.alternateRoutes ?? [])];
}

export function entryWithRoutes(
  entry: ConnectionCatalogEntry,
  routes: ReadonlyArray<ConnectionRoute>,
): ConnectionCatalogEntry {
  const [first, ...rest] = routes;
  if (first === undefined) {
    throw new Error("A saved environment needs at least one route.");
  }
  const { alternateRoutes: _previous, ...base } = entry;
  return {
    ...base,
    target: first.target,
    profile: first.profile,
    ...(rest.length === 0 ? {} : { alternateRoutes: rest }),
  };
}

export function routeEntry(
  entry: ConnectionCatalogEntry,
  route: ConnectionRoute,
): ConnectionCatalogEntry {
  return entryWithRoutes(entry, [route]);
}

export function routeHttpBaseUrl(route: ConnectionRoute): string | null {
  if (route.target._tag === "PrimaryConnectionTarget") return route.target.httpBaseUrl;
  const profile = Option.getOrNull(route.profile);
  return profile?._tag === "BearerConnectionProfile" ? profile.httpBaseUrl : null;
}

function routeHostname(route: ConnectionRoute): string | null {
  const httpBaseUrl = routeHttpBaseUrl(route);
  if (httpBaseUrl === null) return null;
  try {
    return new URL(httpBaseUrl).hostname;
  } catch {
    return null;
  }
}

function directAddressKind(hostname: string, tailscale = false) {
  if (isLocalLoopbackHost(hostname)) return "loopback";
  if (tailscale || isTailnetHost(hostname)) return "tailnet";
  if (isSharedAddressSpaceHost(hostname)) return "vpn";
  return isPrivateNetworkHost(hostname) ? "lan" : "public";
}

export function connectionRouteKind(route: ConnectionRoute): ConnectionRouteKind {
  switch (route.target._tag) {
    case "RelayConnectionTarget":
      return "relay";
    case "PrimaryConnectionTarget":
    case "BearerConnectionTarget": {
      const hostname = routeHostname(route);
      if (hostname === null) return "public";
      const profile = Option.getOrNull(route.profile);
      return directAddressKind(
        hostname,
        profile?._tag === "BearerConnectionProfile" && profile.network === "tailscale",
      );
    }
  }
}

/**
 * Whether the route's address reaches the same machine on every network: TLS
 * proves who answers, and loopback cannot move. Any other plain http address,
 * a tailnet one too once Tailscale is down, can belong to another machine after
 * a network change, so an answer from it is not kept.
 */
export function routeKeepsItsHost(route: ConnectionRoute): boolean {
  if (routeHttpBaseUrl(route)?.startsWith("https:") === true) return true;
  return connectionRouteKind(route) === "loopback";
}

/** A loopback or LAN host answers within a few seconds or is not there. */
export function isNearbyAddress(httpBaseUrl: string): boolean {
  try {
    const kind = directAddressKind(new URL(httpBaseUrl).hostname);
    return kind === "loopback" || kind === "lan";
  } catch {
    return false;
  }
}

const ROUTE_KIND_RANK: Record<ConnectionRouteKind, number> = {
  loopback: 0,
  lan: 1,
  tailnet: 2,
  vpn: 2,
  public: 3,
  relay: 5,
};

export function insertRoute(
  routes: ReadonlyArray<ConnectionRoute>,
  route: ConnectionRoute,
  { aheadOfSameKind = false }: { readonly aheadOfSameKind?: boolean } = {},
): ReadonlyArray<ConnectionRoute> {
  const kind = connectionRouteKind(route);
  const rank = ROUTE_KIND_RANK[kind];
  const index = routes.findIndex((existing) => {
    const existingKind = connectionRouteKind(existing);
    return ROUTE_KIND_RANK[existingKind] > rank || (aheadOfSameKind && existingKind === kind);
  });
  return index === -1
    ? [...routes, route]
    : [...routes.slice(0, index), route, ...routes.slice(index)];
}

export function upsertRoute(
  routes: ReadonlyArray<ConnectionRoute>,
  route: ConnectionRoute,
): ReadonlyArray<ConnectionRoute> {
  const id = connectionRouteId(route.target);
  return routes.some((existing) => connectionRouteId(existing.target) === id)
    ? routes.map((existing) => (connectionRouteId(existing.target) === id ? route : existing))
    : // A route paired at a new address, such as localhost beside a saved
      // 127.0.0.1, goes first among its kind so its fresh credential connects.
      insertRoute(routes, route, { aheadOfSameKind: true });
}

export function findRouteToSameAddress(
  routes: ReadonlyArray<ConnectionRoute>,
  route: ConnectionRoute,
): ConnectionRoute | undefined {
  const key = routeAddressKey(route);
  return key === null ? undefined : routes.find((existing) => routeAddressKey(existing) === key);
}

function routeAddressKey(route: ConnectionRoute): string | null {
  const profile = Option.getOrNull(route.profile);
  switch (profile?._tag) {
    case "BearerConnectionProfile":
      return `bearer:${profile.httpBaseUrl.replace(/\/+$/, "")}`;
    default:
      return null;
  }
}

const T3_CONNECT_NAME = "T3 Connect";

/** The route's label in English. Display sites use `connectionRouteLabelText`. */
export function connectionRouteLabel(route: ConnectionRoute): string {
  switch (connectionRouteKind(route)) {
    case "relay":
      return T3_CONNECT_NAME;
    case "loopback":
      return msg("This device");
    case "lan":
      return "LAN";
    case "tailnet":
      // Tailscale Serve answers over HTTPS on the machine's name; the same machine's
      // plain address is another route, so the two are told apart.
      return routeHttpBaseUrl(route)?.startsWith("https:") === true
        ? msg("Tailscale HTTPS")
        : "Tailscale";
    case "vpn":
      return "VPN";
    case "public":
      return routeHostname(route) ?? msg("Remote link");
  }
}

/** @public */
export function connectionRouteLabelText(
  route: ConnectionRoute,
  resolve: MFunctionType = mFallback,
): string {
  switch (connectionRouteKind(route)) {
    case "loopback":
      return resolve(msg("This device"));
    case "public":
      return routeHostname(route) ?? resolve(msg("Remote link"));
    default:
      return connectionRouteLabel(route);
  }
}

/** Learned routes alone must not make relay environments manually retryable. */
export const hasSavedBearerRoute = (entry: ConnectionCatalogEntry) =>
  connectionRoutes(entry).some((r) => !isLearned(r) && r.target._tag === "BearerConnectionTarget");

export function hasRelayRoute(
  entry: Pick<ConnectionCatalogEntry, "target" | "alternateRoutes">,
): boolean {
  return [entry.target, ...(entry.alternateRoutes ?? []).map((route) => route.target)].some(
    (target) => target._tag === "RelayConnectionTarget",
  );
}

// A paired token goes to a plain HTTP address outside the tailnet only when
// it was paired that way, so a token paired over HTTPS, loopback, or the
// tailnet keeps to the transports it was issued for.
function tokenAllowsPlainHttp(
  routes: ReadonlyArray<ConnectionRoute>,
  credentialId: string,
): boolean {
  const credentialRoute = routes.find((route) => connectionRouteId(route.target) === credentialId);
  return (
    credentialRoute !== undefined &&
    routeHttpBaseUrl(credentialRoute)?.startsWith("http:") === true &&
    (connectionRouteKind(credentialRoute) === "lan" ||
      connectionRouteKind(credentialRoute) === "public")
  );
}

/**
 * Whether connecting over `route` would send a paired token over plain HTTP
 * that it wasn't paired over. Checked against the token the route borrows,
 * so a route learned before this rule existed is refused too.
 */
export function sendsTokenInClear(
  routes: ReadonlyArray<ConnectionRoute>,
  route: ConnectionRoute,
  tailscale?: boolean,
): boolean {
  const profile = Option.getOrNull(route.profile);
  if (profile?._tag !== "BearerConnectionProfile" || profile.authorization === "t3-connect") {
    return false;
  }
  if ((tailscale ?? profile.network === "tailscale") || !profile.httpBaseUrl.startsWith("http:")) {
    return false;
  }
  const credentialId = credentialConnectionId(connectionRouteId(route.target));
  return (
    credentialId !== connectionRouteId(route.target) && !tokenAllowsPlainHttp(routes, credentialId)
  );
}

/** Routes a connect may use: none sends a paired token over plain HTTP it wasn't paired over. */
export function usableRoutes(entry: ConnectionCatalogEntry): ReadonlyArray<ConnectionRoute> {
  const routes = connectionRoutes(entry);
  return routes.filter((route) => !sendsTokenInClear(routes, route));
}

export function credentialConnectionId(connectionId: string): string {
  const at = connectionId.indexOf("@");
  return connectionId.startsWith("learned:") && at !== -1
    ? connectionId.slice(at + 1)
    : connectionId;
}

function isLearned(route: ConnectionRoute): boolean {
  const profile = Option.getOrNull(route.profile);
  return profile?._tag === "BearerConnectionProfile" && profile.learned === true;
}

/**
 * A learned route borrows the credential of the route it was learned over, so
 * it cannot outlive that route: removing T3 Connect also removes routes learned
 * through it, and removing a paired address removes routes that borrow its
 * token.
 */
export function routesAfterRemoving(
  routes: ReadonlyArray<ConnectionRoute>,
  removedId: string,
): ReadonlyArray<ConnectionRoute> {
  const removed = routes.find((route) => connectionRouteId(route.target) === removedId);
  if (removed === undefined) return routes;
  return routes.filter((route) => {
    if (route === removed) return false;
    if (!isLearned(route)) return true;
    const profile = Option.getOrNull(route.profile);
    if (profile?._tag === "BearerConnectionProfile" && profile.authorization === "t3-connect") {
      return removed.target._tag !== "RelayConnectionTarget";
    }
    return credentialConnectionId(connectionRouteId(route.target)) !== removedId;
  });
}

/**
 * A route is offered for removal only when removing it leaves a route behind.
 * A learned route would be learned again, and the last route a learned route
 * borrows from would take the whole environment with it.
 */
export function pendingRouteOrder(
  pending: ReadonlyArray<string> | null,
  savedIds: ReadonlyArray<string>,
): ReadonlyArray<string> | null {
  if (pending === null || pending.length !== savedIds.length) return null;
  const saved = new Set(savedIds);
  if (!pending.every((id) => saved.has(id))) return null;
  return pending.some((id, index) => id !== savedIds[index]) ? pending : null;
}
