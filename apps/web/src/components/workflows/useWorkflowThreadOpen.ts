import type { EnvironmentId } from "@t3tools/contracts";

import { useConnectedEnvironmentIds, useEnvironment } from "../../state/environments";

export type WorkflowThreadOpen = "own" | "unavailable";

export function useWorkflowThreadOpen(
  _viaEnvironmentId: EnvironmentId,
  environmentId: EnvironmentId,
): { readonly open: WorkflowThreadOpen; readonly label: string | null } {
  const own = useEnvironment(environmentId);
  const connected = useConnectedEnvironmentIds().includes(environmentId);
  return {
    open: own !== null && connected ? "own" : "unavailable",
    label: own?.label ?? null,
  };
}
