import {
  EnvironmentId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2PendingBackgroundTask,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

const stopTask = vi.hoisted(() =>
  vi.fn(async (_input: unknown) => ({ _tag: "Success", value: undefined }) as const),
);

vi.mock(import("../../state/use-atom-command"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAtomCommand: (() => stopTask) as never,
}));
vi.mock(import("../../state/orchestration"), async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    orchestrationEnvironment: {
      ...original.orchestrationEnvironment,
      stopBackgroundTask: { permissionAtom: () => Atom.make(true) } as never,
    },
  };
});

import { render } from "../../../test/render";
import {
  ThreadBackgroundTasksPanel,
  type ThreadBackgroundWork,
} from "./ThreadBackgroundTasksPanel";

const environmentId = EnvironmentId.make("env");
const threadId = ThreadId.make("thread");

const work = (
  tasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask>,
  stoppable: ReadonlyArray<string>,
  onStopAll: () => Promise<void>,
): ThreadBackgroundWork => ({
  tasks: tasks.map((task) =>
    stoppable.includes(task.taskId) ? { ...task, stoppable: true as const } : task,
  ),
  turnItems: [],
  stopAllDisabled: false,
  stoppingAll: false,
  onStopAll,
  onOpenThread: () => undefined,
});

it("stops a roster task on its own and leaves others to Stop all", async () => {
  stopTask.mockClear();
  const onStopAll = vi.fn(async () => undefined);
  await using _screen = await render(
    <ThreadBackgroundTasksPanel
      environmentId={environmentId}
      threadId={threadId}
      work={work(
        [
          { taskId: "dev-server", kind: "command", description: "vp run dev" },
          { taskId: "watcher", kind: "monitor", description: "tail -f build.log" },
        ],
        ["dev-server"],
        onStopAll,
      )}
    />,
  );

  await expect.element(page.getByText("vp run dev")).toBeVisible();
  await expect.element(page.getByText("tail -f build.log")).toBeVisible();
  expect(page.getByRole("button", { name: "Stop tail -f build.log" }).elements()).toHaveLength(0);

  await page.getByRole("button", { name: "Stop vp run dev" }).click();
  await vi.waitFor(() =>
    expect(stopTask).toHaveBeenCalledWith({
      environmentId,
      input: { threadId, taskId: "dev-server" },
    }),
  );
  expect(onStopAll).not.toHaveBeenCalled();

  await page.getByRole("button", { name: "Stop all" }).click();
  expect(onStopAll).toHaveBeenCalledOnce();
});

it("stops a lone task through Stop all when its provider cannot stop one task", async () => {
  stopTask.mockClear();
  const onStopAll = vi.fn(async () => undefined);
  await using _screen = await render(
    <ThreadBackgroundTasksPanel
      environmentId={environmentId}
      threadId={threadId}
      work={work([{ taskId: "shell", kind: "command", description: "sleep 600" }], [], onStopAll)}
    />,
  );

  expect(page.getByRole("button", { name: "Stop all" }).elements()).toHaveLength(0);
  await page.getByRole("button", { name: "Stop sleep 600" }).click();
  expect(onStopAll).toHaveBeenCalledOnce();
  expect(stopTask).not.toHaveBeenCalled();
});

it("renders nothing without background work", async () => {
  await using screen = await render(
    <ThreadBackgroundTasksPanel
      environmentId={environmentId}
      threadId={threadId}
      work={work([], [], async () => undefined)}
    />,
  );
  expect(screen.container.querySelector("section")).toBeNull();
});

it("formats live background task elapsed time in whole seconds without decimals", async () => {
  const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_700_000_002_900);
  try {
    const itemId = TurnItemId.make("item-bg-elapsed");
    await using screen = await render(
      <ThreadBackgroundTasksPanel
        environmentId={environmentId}
        threadId={threadId}
        work={{
          ...work(
            [{ taskId: "shell", kind: "command", description: "sleep 15", itemId }],
            ["shell"],
            async () => undefined,
          ),
          turnItems: [
            {
              id: itemId,
              startedAt: DateTime.makeUnsafe(1_700_000_000_000),
            } as ThreadBackgroundWork["turnItems"][number],
          ],
        }}
      />,
    );
    await expect.element(page.getByText("sleep 15")).toBeVisible();
    const timer = screen.container.querySelector(".tabular-nums");
    expect(timer?.textContent).toBe("2s");
  } finally {
    nowSpy.mockRestore();
  }
});
