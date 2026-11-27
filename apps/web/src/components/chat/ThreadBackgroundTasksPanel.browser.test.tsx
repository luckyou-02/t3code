import {
  EnvironmentId,
  ThreadId,
  type OrchestrationV2PendingBackgroundTask,
} from "@t3tools/contracts";
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
  tasks,
  turnItems: [],
  stoppableTaskIds: new Set(stoppable),
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
