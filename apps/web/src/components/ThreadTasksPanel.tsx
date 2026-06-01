import {
  ActivityIcon,
  BotIcon,
  CheckIcon,
  CircleXIcon,
  LoaderIcon,
  OctagonXIcon,
  PanelRightCloseIcon,
  RadioIcon,
  TerminalSquareIcon,
  WorkflowIcon,
} from "lucide-react";
import { useMemo, type ComponentType } from "react";

import type { OrchestrationThreadActivity } from "@t3tools/contracts";

import { cn } from "~/lib/utils";
import { deriveLiveTasks, type LiveTask, type LiveTaskStatus } from "./chat/threadTasks.logic";
import { Button } from "./ui/button";

interface ThreadTasksPanelProps {
  activities: ReadonlyArray<OrchestrationThreadActivity>;
  mode?: "sheet" | "sidebar";
  onClose: () => void;
}

const TYPE_ICON: Record<string, ComponentType<{ className?: string }>> = {
  workflow: WorkflowIcon,
  subagent: BotIcon,
  shell: TerminalSquareIcon,
  monitor: RadioIcon,
};

function StatusBadge({ status }: { status: LiveTaskStatus }) {
  if (status === "running") {
    return (
      <span className="flex shrink-0 items-center gap-1 text-[10px] font-medium text-blue-400">
        <LoaderIcon className="size-3 animate-spin" />
        running
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className="flex shrink-0 items-center gap-1 text-[10px] font-medium text-red-400">
        <CircleXIcon className="size-3" />
        failed
      </span>
    );
  }
  if (status === "stopped") {
    return (
      <span className="flex shrink-0 items-center gap-1 text-[10px] font-medium text-muted-foreground">
        <OctagonXIcon className="size-3" />
        stopped
      </span>
    );
  }
  return (
    <span className="flex shrink-0 items-center gap-1 text-[10px] font-medium text-emerald-500">
      <CheckIcon className="size-3" />
      done
    </span>
  );
}

function TaskRow({ task }: { task: LiveTask }) {
  const Icon = TYPE_ICON[task.type] ?? ActivityIcon;
  return (
    <div
      className={cn(
        "rounded-md border px-2.5 py-2",
        task.status === "running" ? "border-blue-500/30 bg-blue-500/5" : "border-border/60",
      )}
    >
      <div className="flex items-center gap-2">
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate text-xs font-medium text-foreground">{task.label}</span>
        <span className="ml-auto" />
        <StatusBadge status={task.status} />
      </div>
      <div className="mt-1 flex items-center gap-2 pl-[1.375rem]">
        <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
          {task.type}
        </span>
        {task.detail ? (
          <span className="truncate text-[11px] text-muted-foreground" title={task.detail}>
            {task.detail}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Live "background tasks" panel — a dedicated view (distinct from the chat
 * timeline) of the SDK's dynamic tasks (workflow / subagent / shell / monitor),
 * derived from the thread's task.* activities and updated as they stream in.
 */
export function ThreadTasksPanel({ activities, mode = "sidebar", onClose }: ThreadTasksPanelProps) {
  const tasks = useMemo(() => deriveLiveTasks(activities), [activities]);
  const running = useMemo(() => tasks.filter((task) => task.status === "running").length, [tasks]);

  return (
    <div
      className={cn(
        "flex flex-col bg-background",
        mode === "sidebar"
          ? "h-full w-[340px] shrink-0 border-l border-border/70"
          : "h-full w-full",
      )}
    >
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border/60 px-3">
        <div className="flex items-center gap-2">
          <span className="rounded-md bg-blue-500/10 px-1.5 py-0 text-[10px] font-semibold uppercase tracking-wide text-blue-400">
            Tasks
          </span>
          <span className="text-[11px] text-muted-foreground/60">
            {running > 0 ? `${running} running · ${tasks.length} total` : `${tasks.length} total`}
          </span>
        </div>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onClose}
          aria-label="Close tasks panel"
          className="text-muted-foreground/50 hover:text-foreground/70"
        >
          <PanelRightCloseIcon className="size-3.5" />
        </Button>
      </div>

      <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-2.5">
        {tasks.length === 0 ? (
          <p className="px-1 py-6 text-center text-xs text-muted-foreground">
            No background tasks yet. Workflows, subagents, shells and monitors this thread spawns
            will appear here live.
          </p>
        ) : (
          tasks.map((task) => <TaskRow key={task.taskId} task={task} />)
        )}
      </div>
    </div>
  );
}
