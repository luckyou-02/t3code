// @effect-diagnostics globalTimers:off -- Accessibility timeouts run outside Effect fibers.

import {
  SNAP_SHOT_ACCESSIBLE_TEXT_MAX_CHARS,
  type SnapShotAccessibility,
} from "@t3tools/contracts";
import type * as Electron from "electron";

import {
  accessibleWindowElementTree,
  accessibleWindowText,
  compactAccessibilityTree,
  findAccessibleWindow,
  MAX_ACCESSIBILITY_TREE_DEPTH,
} from "./snapShot.ts";

const ACCESSIBILITY_TIMEOUT_MS = 3_000;

export type AccessibleWindowIdentity = {
  readonly title: string;
  readonly bounds: Electron.Rectangle;
  readonly owner: { readonly processId: number };
};

export type CapturedWindowAccessibilityContext = {
  readonly accessibleText?: string;
  readonly accessibility?: SnapShotAccessibility;
};

export type SnapShotAccessibilityRequest = {
  readonly active: AccessibleWindowIdentity;
  readonly sourceTitle: string;
  readonly imageSize: Electron.Size;
};

type AccessibilityApp = (typeof import("@crowecawcaw/xa11y"))["App"];

type AccessibilityReadProgress = {
  accessibleText: string | undefined;
  flatComplete: boolean;
  richComplete: boolean;
  richRoot?: Extract<SnapShotAccessibility, { format: "element-tree" }>["root"];
  richTruncated: boolean;
  timedOut: boolean;
};

function accessibilityReadSnapshot(
  progress: AccessibilityReadProgress,
  imageSize: Electron.Size,
): CapturedWindowAccessibilityContext | undefined {
  const richTree = progress.richRoot ? compactAccessibilityTree(progress.richRoot) : undefined;
  const richText = richTree
    ? accessibleWindowText(richTree.root, SNAP_SHOT_ACCESSIBLE_TEXT_MAX_CHARS)
    : undefined;
  const accessibleText = progress.accessibleText ?? richText;
  const richTruncated = progress.richTruncated || richTree?.truncated === true;
  const accessibility: SnapShotAccessibility | undefined =
    progress.richComplete &&
    richTree &&
    (!richTruncated || !progress.accessibleText || progress.accessibleText === richText)
      ? {
          format: "element-tree",
          coordinateSpace: "captured-image",
          imageSize,
          truncated: richTruncated,
          root: richTree.root,
        }
      : progress.flatComplete && progress.accessibleText
        ? {
            format: "flat-text",
            text: progress.accessibleText,
            truncated: progress.accessibleText.length >= SNAP_SHOT_ACCESSIBLE_TEXT_MAX_CHARS,
          }
        : richTree
          ? {
              format: "element-tree",
              coordinateSpace: "captured-image",
              imageSize,
              truncated: true,
              root: richTree.root,
            }
          : undefined;
  if (!accessibleText && !accessibility) return undefined;
  return JSON.parse(
    JSON.stringify({
      ...(accessibleText ? { accessibleText } : {}),
      ...(accessibility ? { accessibility } : {}),
    }),
  ) as CapturedWindowAccessibilityContext;
}

async function readCapturedWindowAccessibility(
  App: AccessibilityApp,
  request: SnapShotAccessibilityRequest,
  progress: AccessibilityReadProgress,
  onStarted: () => void,
): Promise<CapturedWindowAccessibilityContext | undefined> {
  const { active, sourceTitle, imageSize } = request;
  const foreground = await App.foreground({ timeout: 0 });
  const pidWindows =
    foreground.pid === active.owner.processId ? await foreground.children().catch(() => []) : [];
  const window = findAccessibleWindow(pidWindows, {
    title: active.title,
    sourceTitle,
    bounds: active.bounds,
  });
  if (!window) {
    onStarted();
    return undefined;
  }
  const accessibleBounds = window.bounds;
  const flatRead = window
    .tree(MAX_ACCESSIBILITY_TREE_DEPTH)
    .then((tree) => {
      progress.accessibleText =
        accessibleWindowText(tree, SNAP_SHOT_ACCESSIBLE_TEXT_MAX_CHARS) || undefined;
      progress.flatComplete = true;
    })
    .catch(() => {
      progress.flatComplete = true;
    });
  const sourceBounds = accessibleBounds ?? active.bounds;
  const richRead = accessibleWindowElementTree(window, sourceBounds, imageSize, {
    onProgress: (root, truncated) => {
      progress.richRoot = root;
      progress.richTruncated = truncated;
    },
    shouldContinue: () => !progress.timedOut,
  })
    .then((rich) => {
      progress.richComplete = true;
      if (rich) {
        progress.richRoot = rich.root;
        progress.richTruncated = rich.truncated;
      }
    })
    .catch(() => {
      progress.richComplete = true;
    });
  onStarted();
  await Promise.all([flatRead, richRead]);
  return accessibilityReadSnapshot(progress, imageSize);
}

let activeAccessibilityRead: Promise<unknown> | undefined;

async function raceAccessibleRead<T>(
  run: () => Promise<T>,
  timeoutValue: () => T | undefined,
): Promise<T | undefined> {
  if (activeAccessibilityRead) return undefined;
  const read = run().catch(() => undefined);
  activeAccessibilityRead = read;
  void read.finally(() => {
    if (activeAccessibilityRead === read) activeAccessibilityRead = undefined;
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      read,
      new Promise<T | undefined>((resolve) => {
        timeout = setTimeout(() => resolve(timeoutValue()), ACCESSIBILITY_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function readAccessibleWindowContextWithApp(
  App: AccessibilityApp,
  request: SnapShotAccessibilityRequest,
  onStarted: () => void = () => undefined,
): Promise<CapturedWindowAccessibilityContext | undefined> {
  const progress: AccessibilityReadProgress = {
    accessibleText: undefined,
    flatComplete: false,
    richComplete: false,
    richTruncated: false,
    timedOut: false,
  };
  return raceAccessibleRead(
    () => readCapturedWindowAccessibility(App, request, progress, onStarted),
    () => {
      progress.timedOut = true;
      return accessibilityReadSnapshot(progress, request.imageSize);
    },
  );
}
