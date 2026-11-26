import type { RunId } from "@t3tools/contracts";
import type { ThreadStructureTurnItem } from "@t3tools/client-runtime/state/models";

export type TaskChecklistItem = Extract<ThreadStructureTurnItem, { type: "todo_list" }>;

/** The run's latest todo list: each update the agent writes is a new item that replaces the last. */
export function latestTaskChecklist(
  turnItems: ReadonlyArray<ThreadStructureTurnItem>,
  runId: RunId,
): TaskChecklistItem | null {
  for (let index = turnItems.length - 1; index >= 0; index -= 1) {
    const item = turnItems[index]!;
    if (item.type === "todo_list" && item.runId === runId) {
      return item.steps.length > 0 ? item : null;
    }
  }
  return null;
}
