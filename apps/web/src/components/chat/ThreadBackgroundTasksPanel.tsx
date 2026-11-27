import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  OrchestrationV2PendingBackgroundTask,
  ThreadId,
} from "@t3tools/contracts";
import type { ThreadStructure } from "@t3tools/client-runtime/state/shell";
import { presentPendingBackgroundWork } from "@t3tools/client-runtime/state/thread-execution";
import { formatDuration } from "@t3tools/shared/orchestrationTimingCopy";
import * as DateTime from "effect/DateTime";
import { T, useGT } from "gt-react";
import { ActivityIcon, BotIcon, CircleDashedIcon, SquareIcon, TerminalIcon } from "lucide-react";
import { useState } from "react";

import { m } from "~/i18n/messages";
import { tickTextContent } from "~/lib/tickTextContent";
import { cn } from "~/lib/utils";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useAtomCommand } from "../../state/use-atom-command";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { BackgroundWorkDetails } from "./BackgroundWorkDetails";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { THREAD_DETAILS_PANEL_ICON_CLASS } from "./threadDetailsPanelStyles";

export interface ThreadBackgroundWork {
  readonly tasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask>;
  readonly turnItems: ThreadStructure["turnItems"];
  /** Tasks the provider can stop one at a time; the rest only stop together. */
  readonly stoppableTaskIds: ReadonlySet<string>;
  readonly stopAllDisabled: boolean;
  readonly stoppingAll: boolean;
  readonly onStopAll: () => Promise<void>;
  readonly onOpenThread: (threadId: ThreadId) => void;
}

const KIND_ICONS = {
  command: TerminalIcon,
  monitor: ActivityIcon,
  subagent: BotIcon,
  background_task: CircleDashedIcon,
} as const;

/** The thread's background commands, monitors and subagents. Hidden while none run. */
export function ThreadBackgroundTasksPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly work: ThreadBackgroundWork;
}) {
  const gt = useGT();
  const { work } = props;
  const stopTask = useAtomCommand(orchestrationEnvironment.stopBackgroundTask, {
    reportFailure: false,
  });
  const canStopTask = useAtomValue(
    orchestrationEnvironment.stopBackgroundTask.permissionAtom(props.environmentId),
  );
  const [stoppingTaskId, setStoppingTaskId] = useState<string | null>(null);
  const presentation = presentPendingBackgroundWork(work.tasks, m);
  if (presentation === null) return null;

  const stop = async (taskId: string) => {
    if (stoppingTaskId !== null) return;
    setStoppingTaskId(taskId);
    const result = await stopTask({
      environmentId: props.environmentId,
      input: { threadId: props.threadId, taskId },
    });
    setStoppingTaskId(null);
    if (result._tag === "Failure") {
      toastManager.add({ type: "error", title: gt("Could not stop background task") });
    }
  };
  const kindLabel = (kind: string) => {
    switch (kind) {
      case "subagent":
        return gt("Subagent", { $context: "kind of background work" });
      case "command":
        return gt("Command", { $context: "kind of background work" });
      case "monitor":
        return gt("Monitor", { $context: "kind of background work" });
      default:
        return gt("Background task", { $context: "kind of background work" });
    }
  };
  const onlyOne = presentation.items.length === 1;

  return (
    <ThreadDetailsSection
      headingId="thread-details-background-tasks-heading"
      title={gt("Background tasks", { $context: "thread details section" })}
      actions={
        onlyOne ? null : (
          <ThreadDetailsControl
            part="meta"
            tone="destructive"
            disabled={work.stopAllDisabled}
            onClick={() => void work.onStopAll()}
          >
            {work.stoppingAll ? (
              <Spinner aria-hidden size="xs" />
            ) : (
              <SquareIcon aria-hidden className="size-3 fill-current" />
            )}
            <T context="verb, stops every background task">Stop all</T>
          </ThreadDetailsControl>
        )
      }
    >
      <ul className="m-0 list-none p-0">
        {presentation.items.map((presented) => {
          const task = work.tasks.find((candidate) => candidate.taskId === presented.taskId);
          if (task === undefined) return null;
          const itemKey = task.nativeItemId ?? task.taskId;
          const item = work.turnItems.findLast(
            (candidate) => (candidate.nativeItemRef?.nativeId || candidate.id) === itemKey,
          );
          const startedAtMs = item?.startedAt ? DateTime.toEpochMillis(item.startedAt) : null;
          const Icon = KIND_ICONS[task.kind as keyof typeof KIND_ICONS] ?? CircleDashedIcon;
          const isCommand = task.kind === "command" || task.kind === "monitor";
          // With one task, stopping all is stopping it, so every provider gets a row button.
          const stopsAlone = canStopTask && work.stoppableTaskIds.has(task.taskId);
          const stoppable = stopsAlone || (onlyOne && !work.stopAllDisabled);
          const stopping = stoppingTaskId === task.taskId || (onlyOne && work.stoppingAll);
          const childThreadId = task.kind === "subagent" ? task.childThreadId : undefined;
          const rowContent = (
            <>
              <Icon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
              {/* The end padding keeps text clear of the stop button. */}
              <span className={cn("flex min-w-0 flex-1 flex-col gap-0.5", stoppable && "pe-6")}>
                <span
                  className={cn(
                    "truncate text-sm font-medium leading-4 text-foreground/85",
                    isCommand && "font-mono text-xs",
                  )}
                >
                  {presented.label}
                </span>
                <span className="truncate text-2xs font-normal leading-4 text-muted-foreground">
                  {kindLabel(task.kind)}
                  {startedAtMs === null ? null : (
                    <>
                      {" · "}
                      <span
                        ref={tickTextContent(
                          (nowMs) => formatDuration(Math.max(1_000, nowMs - startedAtMs), m),
                          true,
                        )}
                        className="tabular-nums"
                      />
                    </>
                  )}
                </span>
              </span>
            </>
          );
          const row = <ThreadDetailsControl size="sm" variant="ghost" part="row" multiline />;
          return (
            <li key={task.taskId} className="group relative flex items-center rounded-lg">
              {childThreadId ? (
                <ThreadDetailsControl
                  size="sm"
                  variant="ghost"
                  part="row"
                  multiline
                  onClick={() => work.onOpenThread(childThreadId)}
                >
                  {rowContent}
                </ThreadDetailsControl>
              ) : (
                <BackgroundWorkDetails
                  environmentId={props.environmentId}
                  threadId={props.threadId}
                  tasks={[task]}
                  turnItems={work.turnItems}
                  onOpenThread={work.onOpenThread}
                  trigger={{ render: row, children: rowContent }}
                />
              )}
              {stoppable ? (
                <div
                  className={cn(
                    "absolute right-1 top-1/2 flex -translate-y-1/2 items-center",
                    !stopping &&
                      "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100",
                  )}
                >
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <ThreadDetailsControl
                          size="icon-xs"
                          variant="ghost"
                          part="icon"
                          tone="destructive"
                          aria-label={gt("Stop {label}", { label: presented.label })}
                          disabled={stopping || stoppingTaskId !== null}
                          onClick={() => void (stopsAlone ? stop(task.taskId) : work.onStopAll())}
                        />
                      }
                    >
                      {stopping ? (
                        <Spinner aria-hidden size="xs" />
                      ) : (
                        <SquareIcon aria-hidden className="size-3 fill-current" />
                      )}
                    </TooltipTrigger>
                    <TooltipPopup side="left">
                      <T context="verb, stops one background task">Stop</T>
                    </TooltipPopup>
                  </Tooltip>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </ThreadDetailsSection>
  );
}
