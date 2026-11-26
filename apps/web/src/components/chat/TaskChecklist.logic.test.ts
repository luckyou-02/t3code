import { PlanId, RunId, ThreadId, TurnItemId } from "@t3tools/contracts";
import type { ThreadStructureTurnItem } from "@t3tools/client-runtime/state/models";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { latestTaskChecklist } from "./TaskChecklist.logic";

const runA = RunId.make("run-a");
const runB = RunId.make("run-b");

const todoList = (
  id: string,
  runId: RunId,
  steps: ReadonlyArray<{ id: string; text: string; status: "pending" | "running" | "completed" }>,
): ThreadStructureTurnItem => ({
  id: TurnItemId.make(id),
  threadId: ThreadId.make("thread"),
  runId,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "completed",
  title: null,
  startedAt: null,
  completedAt: null,
  updatedAt: DateTime.makeUnsafe("2026-11-26T00:00:00Z"),
  type: "todo_list",
  planId: PlanId.make(`plan-${id}`),
  steps,
});

const commandItem = (runId: RunId): ThreadStructureTurnItem => ({
  id: TurnItemId.make("command"),
  threadId: ThreadId.make("thread"),
  runId,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 2,
  status: "completed",
  title: null,
  startedAt: null,
  completedAt: null,
  updatedAt: DateTime.makeUnsafe("2026-11-26T00:00:00Z"),
  type: "command_execution",
  input: "ls",
  output: "",
});

describe("latestTaskChecklist", () => {
  it("returns the run's most recent todo list, past later work", () => {
    const first = todoList("first", runA, [{ id: "1", text: "Read", status: "running" }]);
    const second = todoList("second", runA, [{ id: "1", text: "Read", status: "completed" }]);

    const result = latestTaskChecklist([first, second, commandItem(runA)], runA);

    expect(result?.id).toBe(second.id);
  });

  it("ignores todo lists written by another run", () => {
    const earlier = todoList("earlier", runA, [{ id: "1", text: "Read", status: "pending" }]);

    expect(latestTaskChecklist([earlier, commandItem(runB)], runB)).toBeNull();
  });

  it("hides a cleared list instead of falling back to an older one", () => {
    const filled = todoList("filled", runA, [{ id: "1", text: "Read", status: "pending" }]);
    const cleared = todoList("cleared", runA, []);

    expect(latestTaskChecklist([filled, cleared], runA)).toBeNull();
  });
});
