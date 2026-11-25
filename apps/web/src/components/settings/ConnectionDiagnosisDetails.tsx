import { useAtomValue } from "@effect/atom-react";
import {
  AVAILABLE_CONNECTION_STATE,
  connectionRoutes,
  hasRelayRoute,
  presentConnectionDiagnosis,
} from "@t3tools/client-runtime/connection";
import { AsyncResult } from "effect/reactivity";
import { useMessages } from "gt-react";

import { APP_VERSION } from "~/branding";
import { environmentCatalog } from "~/connection/catalog";
import { type EnvironmentPresentation } from "~/state/environments";

/**
 * What failed on the way to an environment, or null while it is connected, off,
 * or has not failed. Reads the supervisor state itself so callers that only need
 * the headline do not re-render on every attempt.
 */
export function ConnectionDiagnosisHeadline({
  environment,
}: {
  readonly environment: EnvironmentPresentation;
}) {
  const m = useMessages();
  const environmentId = environment.environmentId;
  const state = AsyncResult.getOrElse(
    useAtomValue(environmentCatalog.stateAtom(environmentId)),
    () => AVAILABLE_CONNECTION_STATE,
  );
  const routes = connectionRoutes(environment.entry);
  const relayOnly = routes.length === 1 && hasRelayRoute(environment.entry);
  const phase = environment.connection.phase;
  const diagnosis =
    environment.entry.enabled && phase !== "connected" && phase !== "unsupported"
      ? presentConnectionDiagnosis(
          {
            hostLabel: environment.label,
            state,
            via: relayOnly ? "relay" : "direct",
            clientVersion: APP_VERSION,
            serverVersion: environment.serverConfig?.environment.serverVersion,
          },
          m,
        )
      : null;
  return diagnosis?.headline ?? null;
}
