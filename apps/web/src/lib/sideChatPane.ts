import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  resolveSideThreadOpenTarget,
  type SideThreadOpenIntent,
} from "@t3tools/client-runtime/side-thread";
import type {
  OrchestrationV2ThreadShell,
  ScopedThreadRef,
  SideThreadOpenTarget,
} from "@t3tools/contracts";

import type { ToolCallDiffTarget } from "../diffPanelStore";

import { getClientSettings } from "../hooks/useSettings";
import { rightPanelHostRef, useRightPanelStore } from "../rightPanelStore";

/** Whether an event started in the side chat pane (`data-side-chat-pane`), which the main chat ignores. */
export function isInSideChatPane(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("[data-side-chat-pane]") !== null;
}

/**
 * Opens an embedded side thread's tool diffs in its parent's diff panel and runs its shell commands
 * in the parent's terminal drawer, since the embedded view hides its own. Other panel actions reach
 * the parent through `hostRightPanel`; diff selection and the drawer are not panel state.
 */
export interface SideChatParentPanel {
  /** The thread whose panel shows the embedded one. */
  readonly hostRef: ScopedThreadRef;
  readonly openToolDiff: (target: ToolCallDiffTarget) => void;
  readonly runShellCommand: (command: string) => void;
}

/**
 * Where opening `threadRef` should route. A side chat shows as a tab of its parent, so this opens
 * that tab and returns the parent; any other thread returns `threadRef`.
 */
export function resolveThreadOpenRoute(
  threadRef: ScopedThreadRef,
  thread: Pick<OrchestrationV2ThreadShell, "lineage"> | null,
): ScopedThreadRef {
  const parentThreadId = thread?.lineage.sideChat === true ? thread.lineage.parentThreadId : null;
  if (parentThreadId === null) return threadRef;
  const parentRef = scopeThreadRef(threadRef.environmentId, parentThreadId);
  useRightPanelStore.getState().openThread(parentRef, threadRef.threadId);
  return parentRef;
}

/**
 * Whether `panelRef`'s right panel can show `threadRef` as a tab: a thread of the same environment
 * that is not the one the panel belongs to.
 */
function canOpenThreadInPanel(
  threadRef: ScopedThreadRef,
  panelRef: ScopedThreadRef | null,
): panelRef is ScopedThreadRef {
  if (panelRef === null) return false;
  const host = rightPanelHostRef(panelRef);
  return host.environmentId === threadRef.environmentId && host.threadId !== threadRef.threadId;
}

/**
 * Opens a side chat or subagent where the click asked: as a tab beside `panelRef`, the thread the
 * click happened in, or on the main screen through `navigate`. Returns where it went.
 */
export function openSideThread(input: {
  readonly threadRef: ScopedThreadRef;
  readonly panelRef: ScopedThreadRef | null;
  readonly intent: SideThreadOpenIntent;
  readonly navigate: (threadRef: ScopedThreadRef) => void;
}): SideThreadOpenTarget {
  const { threadRef, panelRef } = input;
  const target = resolveSideThreadOpenTarget({
    preference: getClientSettings().sideThreadOpenTarget,
    intent: input.intent,
    panelAvailable: canOpenThreadInPanel(threadRef, panelRef),
  });
  if (target === "panel" && panelRef !== null) {
    useRightPanelStore.getState().openThread(panelRef, threadRef.threadId);
  } else {
    input.navigate(threadRef);
  }
  return target;
}
