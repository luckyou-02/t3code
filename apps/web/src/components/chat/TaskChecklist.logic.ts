import type { OrchestrationV2PlanArtifact, RunId } from "@t3tools/contracts";

export type TaskChecklistPlan = Extract<OrchestrationV2PlanArtifact, { kind: "todo_list" }>;

/**
 * The executing run's todo list. Read from plans, not turn items: history paging can drop the
 * list's row from the loaded window, but the server always keeps the latest list in plans.
 */
export function latestTaskChecklist(
  plans: ReadonlyArray<OrchestrationV2PlanArtifact>,
  runId: RunId,
): TaskChecklistPlan | null {
  for (let index = plans.length - 1; index >= 0; index -= 1) {
    const plan = plans[index]!;
    if (plan.kind === "todo_list" && plan.runId === runId && plan.status !== "superseded") {
      return plan.steps.length > 0 ? plan : null;
    }
  }
  return null;
}
