import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";

import { type ThreadSurface, useRightPanelStore } from "../rightPanelStore";
import { buildThreadRouteParams } from "../threadRoutes";

/**
 * Moves a side thread's tab from `panelRef`'s panel to the main screen. The tab closes, without
 * the cleanup Close does, so the way back does not show the thread beside itself.
 */
export function useOpenSurfaceInMainView(panelRef: ScopedThreadRef | null) {
  const navigate = useNavigate();
  return (surface: ThreadSurface) => {
    if (panelRef === null) return;
    useRightPanelStore.getState().closeSurface(panelRef, surface.id);
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(panelRef.environmentId, surface.threadId)),
    });
  };
}
