import "~/index.css";
import { NodeId, PlanId, RunId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { TaskChecklist } from "./TaskChecklist";
import type { TaskChecklistPlan } from "./TaskChecklist.logic";

const checklist: TaskChecklistPlan = {
  id: PlanId.make("plan"),
  threadId: ThreadId.make("thread"),
  runId: RunId.make("run"),
  nodeId: NodeId.make("node"),
  status: "active",
  kind: "todo_list",
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
  const runningSpinner = items[1]?.querySelector<HTMLElement>("[data-task-spinner]");
  expect(runningSpinner).not.toBeNull();
  expect(runningSpinner?.className).toContain("visible-animate-spin");
  expect(getComputedStyle(runningSpinner!).backgroundImage).toContain("conic-gradient");
});
