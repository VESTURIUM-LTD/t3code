import type { OrchestrationThreadActivity } from "@t3tools/contracts";

// Live view of the SDK's dynamic background tasks (shell / subagent / monitor /
// workflow), reconstructed from the thread's task.* activities. Each task is
// keyed by taskId; task.started opens it, task.progress updates it, and
// task.completed closes it with a terminal status.

export type LiveTaskStatus = "running" | "completed" | "failed" | "stopped";

export interface LiveTask {
  readonly taskId: string;
  /** "workflow" | "subagent" | "shell" | "monitor" | "plan" | "task" | … */
  readonly type: string;
  readonly label: string;
  readonly status: LiveTaskStatus;
  readonly detail: string | null;
  readonly startedAt: string;
  readonly updatedAt: string;
}

function readStr(payload: unknown, key: string): string | undefined {
  if (payload && typeof payload === "object" && key in payload) {
    const value = (payload as Record<string, unknown>)[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return undefined;
}

function terminalStatus(payload: unknown, tone: string): LiveTaskStatus {
  const status = readStr(payload, "status");
  if (status === "failed" || tone === "error") return "failed";
  if (status === "stopped") return "stopped";
  return "completed";
}

/**
 * Reduce a thread's activities into the current set of background tasks,
 * sorted running-first then most-recently-updated. Pure — safe to memoize on
 * the activities array.
 */
export function deriveLiveTasks(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<LiveTask> {
  const byId = new Map<string, LiveTask>();

  for (const activity of activities) {
    if (!activity.kind.startsWith("task.")) continue;
    const taskId = readStr(activity.payload, "taskId");
    if (!taskId) continue;
    const existing = byId.get(taskId);

    if (activity.kind === "task.started") {
      byId.set(taskId, {
        taskId,
        type: readStr(activity.payload, "taskType") ?? "task",
        label: readStr(activity.payload, "detail") ?? activity.summary,
        status: "running",
        detail: readStr(activity.payload, "detail") ?? null,
        startedAt: activity.createdAt,
        updatedAt: activity.createdAt,
      });
    } else if (activity.kind === "task.progress") {
      if (existing) {
        byId.set(taskId, {
          ...existing,
          detail:
            readStr(activity.payload, "detail") ??
            readStr(activity.payload, "summary") ??
            existing.detail,
          updatedAt: activity.createdAt,
        });
      }
    } else if (activity.kind === "task.completed") {
      const status = terminalStatus(activity.payload, activity.tone);
      const detail = readStr(activity.payload, "detail") ?? existing?.detail ?? null;
      byId.set(taskId, {
        taskId,
        type: existing?.type ?? "task",
        label: existing?.label ?? activity.summary,
        status,
        detail,
        startedAt: existing?.startedAt ?? activity.createdAt,
        updatedAt: activity.createdAt,
      });
    }
  }

  return [...byId.values()].sort((a, b) => {
    const ar = a.status === "running" ? 0 : 1;
    const br = b.status === "running" ? 0 : 1;
    if (ar !== br) return ar - br;
    return b.updatedAt.localeCompare(a.updatedAt);
  });
}

export function countRunningTasks(tasks: ReadonlyArray<LiveTask>): number {
  let n = 0;
  for (const task of tasks) if (task.status === "running") n++;
  return n;
}
