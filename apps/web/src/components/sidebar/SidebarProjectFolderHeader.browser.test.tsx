import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { buildSidebarProjectSnapshots } from "../../sidebarProjectGrouping";
import type { Project } from "../../types";
import {
  SidebarProjectFolderHeader,
  type SidebarProjectReorderHandlers,
} from "./SidebarProjectFolderHeader";

const environmentId = EnvironmentId.make("local");

function projectGroup(name: string) {
  const project: Project = {
    environmentId,
    id: ProjectId.make(name),
    title: name,
    workspaceRoot: `/work/${name}`,
    repositoryIdentity: null,
    defaultModelSelection: null,
    faviconPath: null,
    projectIcon: null,
    scripts: [],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  };
  return buildSidebarProjectSnapshots({
    projects: [project],
    settings: { sidebarProjectGroupingMode: "repository", sidebarProjectGroupingOverrides: {} },
    primaryEnvironmentId: environmentId,
    resolveEnvironmentLabel: () => null,
  })[0]!;
}

function Headers(props: { reorder?: SidebarProjectReorderHandlers }) {
  return (
    <ul>
      {[projectGroup("alpha"), projectGroup("beta")].map((group) => (
        <SidebarProjectFolderHeader
          key={group.projectKey}
          group={group}
          collapsed={false}
          hiddenThreads={[]}
          onToggle={vi.fn()}
          onNewThread={vi.fn()}
          onContextMenu={vi.fn()}
          reorder={props.reorder}
        />
      ))}
    </ul>
  );
}

function dispatchDrag(target: Element, type: string, dataTransfer: DataTransfer) {
  const event = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer });
  target.dispatchEvent(event);
  return event;
}

const folderButton = (name: string) => page.getByRole("button", { name, exact: true }).element();

it("drags one project header onto another when projects are sorted manually", async () => {
  const reorder = { onStart: vi.fn(), onOver: vi.fn(), onDrop: vi.fn(), onEnd: vi.fn() };
  await using _screen = await render(<Headers reorder={reorder} />);
  const dataTransfer = new DataTransfer();

  dispatchDrag(folderButton("alpha"), "dragstart", dataTransfer);
  const over = dispatchDrag(folderButton("beta"), "dragover", dataTransfer);
  dispatchDrag(folderButton("beta"), "drop", dataTransfer);

  expect(reorder.onStart).toHaveBeenCalledWith(expect.objectContaining({ title: "alpha" }));
  expect(over.defaultPrevented).toBe(true);
  expect(reorder.onOver).toHaveBeenCalledWith(expect.objectContaining({ title: "beta" }));
  expect(reorder.onDrop).toHaveBeenCalledWith(expect.objectContaining({ title: "beta" }));
});

it("lets file drags pass over project headers", async () => {
  const reorder = { onStart: vi.fn(), onOver: vi.fn(), onDrop: vi.fn(), onEnd: vi.fn() };
  await using _screen = await render(<Headers reorder={reorder} />);
  const dataTransfer = new DataTransfer();
  dataTransfer.items.add(new File(["x"], "notes.txt", { type: "text/plain" }));

  const over = dispatchDrag(folderButton("beta"), "dragover", dataTransfer);

  expect(over.defaultPrevented).toBe(false);
  expect(reorder.onOver).not.toHaveBeenCalled();
});

it("keeps headers fixed unless projects are sorted manually", async () => {
  await using _screen = await render(<Headers />);

  expect(folderButton("alpha").getAttribute("draggable")).toBe("false");
});
