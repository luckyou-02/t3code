import { CircleCheckIcon, CircleDashedIcon, CircleIcon } from "lucide-react";
import { useGT } from "gt-react";

import { cn } from "~/lib/utils";
import type { TaskChecklistItem } from "./TaskChecklist.logic";

/** The running turn's todo list, pinned above the composer while the agent works through it. */
export function TaskChecklist({ checklist }: { readonly checklist: TaskChecklistItem }) {
  const gt = useGT();
  const done = checklist.steps.filter((step) => step.status === "completed").length;
  return (
    <div
      className="chat-content-lane pb-3 transition-opacity duration-150 ease-out starting:opacity-0 motion-reduce:transition-none"
      data-task-checklist
    >
      <ul
        aria-label={gt("Tasks {done}/{total}", { done, total: checklist.steps.length })}
        className="flex max-h-72 flex-col gap-1 overflow-y-auto rounded-xl border border-border/70 bg-card px-4 py-3 text-sm"
      >
        {checklist.steps.map((step) => (
          <li
            key={step.id}
            data-task-status={step.status}
            className={cn(
              "flex min-w-0 items-start gap-2.5 py-0.5",
              step.status === "running" ? "text-foreground" : "text-muted-foreground",
            )}
          >
            <span aria-hidden className="flex h-5 shrink-0 items-center">
              {step.status === "completed" ? (
                <CircleCheckIcon className="size-4 text-muted-foreground" />
              ) : step.status === "running" ? (
                <CircleIcon strokeWidth={2.5} className="size-4 text-foreground" />
              ) : (
                <CircleDashedIcon className="size-4 text-muted-foreground/70" />
              )}
            </span>
            <span className="min-w-0 wrap-break-word">
              <span className="sr-only">
                {step.status === "completed"
                  ? gt("Done:", { $context: "task checklist step status" })
                  : step.status === "running"
                    ? gt("In progress:", { $context: "task checklist step status" })
                    : gt("To do:", { $context: "task checklist step status" })}{" "}
              </span>
              {step.text}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
