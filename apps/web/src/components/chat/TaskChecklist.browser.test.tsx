import "~/index.css";
import { PlanId, RunId, ThreadId, TurnItemId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { TaskChecklist } from "./TaskChecklist";
import type { TaskChecklistItem } from "./TaskChecklist.logic";

const checklist: TaskChecklistItem = {
  id: TurnItemId.make("todo"),
  threadId: ThreadId.make("thread"),
  runId: RunId.make("run"),
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
  planId: PlanId.make("plan"),
  steps: [
    { id: "1", text: "Read the handoff", status: "completed" },
    { id: "2", text: "Port the theme fix", status: "running" },
    { id: "3", text: "Run the tests", status: "pending" },
  ],
};

it("lists every step in order with its status announced", async () => {
  await using _screen = await render(<TaskChecklist checklist={checklist} />);

  const list = page.getByRole("list", { name: "Tasks 1/3" });
  await expect.element(list).toBeVisible();
  const items = list.getByRole("listitem").elements();
  expect(items.map((item) => item.textContent)).toEqual([
    "Done: Read the handoff",
    "In progress: Port the theme fix",
    "To do: Run the tests",
  ]);
  expect(items.map((item) => item.getAttribute("data-task-status"))).toEqual(
    checklist.steps.map((step) => step.status),
  );
});
