import type { EnvironmentId } from "@t3tools/contracts";

import { isElectron } from "../env";
import { readPrimaryEnvironmentId } from "../state/environments";
import { readPreparedConnection } from "../state/session";

export function appLinkBaseUrl(environmentId?: EnvironmentId): string {
  if (isElectron) {
    const id = environmentId ?? readPrimaryEnvironmentId();
    const backend = id === null ? null : readPreparedConnection(id);
    if (backend !== null) return backend.httpBaseUrl;
  }
  return window.location.href;
}
