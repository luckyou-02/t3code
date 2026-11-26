import {
  NodeId,
  PlanId,
  RunId,
  ThreadId,
  type OrchestrationV2PlanArtifact,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { latestTaskChecklist } from "./TaskChecklist.logic";

const executing = RunId.make("run-executing");
const queued = RunId.make("run-queued");

type Step = { id: string; text: string; status: "pending" | "running" | "completed" };

const todoList = (
  id: string,
  runId: RunId,
  steps: ReadonlyArray<Step>,
  status: OrchestrationV2PlanArtifact["status"] = "active",
): OrchestrationV2PlanArtifact => ({
  id: PlanId.make(id),
  threadId: ThreadId.make("thread"),
  runId,
  nodeId: NodeId.make("node"),
  status,
  kind: "todo_list",
  steps,
});

const proposedPlan = (runId: RunId): OrchestrationV2PlanArtifact => ({
  id: PlanId.make("proposal"),
  threadId: ThreadId.make("thread"),
  runId,
  nodeId: NodeId.make("node"),
  status: "active",
  kind: "proposed_plan",
  markdown: "# Plan",
});

const read: Step = { id: "1", text: "Read", status: "running" };

describe("latestTaskChecklist", () => {
  it("returns the executing run's latest list, past other plan kinds", () => {
    const first = todoList("first", executing, [read], "completed");
    const second = todoList("second", executing, [{ ...read, status: "completed" }]);

    const result = latestTaskChecklist([first, second, proposedPlan(executing)], executing);

    expect(result?.id).toBe(second.id);
  });

  it("keeps the executing run's list while a follow-up is queued", () => {
    const list = todoList("list", executing, [read]);

    expect(latestTaskChecklist([list], executing)?.id).toBe(list.id);
    expect(latestTaskChecklist([list], queued)).toBeNull();
  });

  it("hides a list the agent withdrew instead of showing its old steps", () => {
    const withdrawn = todoList("withdrawn", executing, [read], "superseded");

    expect(latestTaskChecklist([withdrawn], executing)).toBeNull();
  });

  it("hides a cleared list instead of falling back to an older one", () => {
    const filled = todoList("filled", executing, [read], "completed");
    const cleared = todoList("cleared", executing, []);

    expect(latestTaskChecklist([filled, cleared], executing)).toBeNull();
  });
});
