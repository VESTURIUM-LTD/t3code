import { describe, expect, it } from "vitest";

import type { OrchestrationThreadActivity } from "@t3tools/contracts";

import { countRunningTasks, deriveLiveTasks } from "./threadTasks.logic";

let seq = 0;
function act(
  kind: string,
  payload: Record<string, unknown>,
  opts: { tone?: string; summary?: string; createdAt?: string } = {},
): OrchestrationThreadActivity {
  seq += 1;
  return {
    id: `evt-${seq}`,
    tone: opts.tone ?? "info",
    kind,
    summary: opts.summary ?? "activity",
    payload,
    turnId: null,
    createdAt: opts.createdAt ?? `2026-06-01T00:00:0${seq}.000Z`,
  } as unknown as OrchestrationThreadActivity;
}

describe("deriveLiveTasks", () => {
  it("opens a task on task.started and marks it running", () => {
    const tasks = deriveLiveTasks([
      act("task.started", { taskId: "t1", taskType: "workflow", detail: "review changes" }),
    ]);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      taskId: "t1",
      type: "workflow",
      status: "running",
      label: "review changes",
    });
  });

  it("updates detail on task.progress without changing status", () => {
    const tasks = deriveLiveTasks([
      act("task.started", { taskId: "t1", taskType: "subagent", detail: "start" }),
      act("task.progress", { taskId: "t1", detail: "halfway" }),
    ]);
    expect(tasks[0]?.status).toBe("running");
    expect(tasks[0]?.detail).toBe("halfway");
  });

  it("closes a task as completed / failed / stopped", () => {
    const done = deriveLiveTasks([
      act("task.started", { taskId: "t1" }),
      act("task.completed", { taskId: "t1", status: "completed" }),
    ]);
    expect(done[0]?.status).toBe("completed");

    const failed = deriveLiveTasks([
      act("task.started", { taskId: "t2" }),
      act("task.completed", { taskId: "t2", status: "failed" }, { tone: "error" }),
    ]);
    expect(failed[0]?.status).toBe("failed");

    const stopped = deriveLiveTasks([
      act("task.started", { taskId: "t3" }),
      act("task.completed", { taskId: "t3", status: "stopped" }),
    ]);
    expect(stopped[0]?.status).toBe("stopped");
  });

  it("shows a completed task even if its start wasn't seen (truncated history)", () => {
    const tasks = deriveLiveTasks([
      act(
        "task.completed",
        { taskId: "orphan", status: "completed" },
        { summary: "Task completed" },
      ),
    ]);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.status).toBe("completed");
  });

  it("ignores non-task activities and task events without a taskId", () => {
    const tasks = deriveLiveTasks([
      act("message", { foo: "bar" }),
      act("task.started", { taskType: "workflow" }), // no taskId
    ]);
    expect(tasks).toHaveLength(0);
  });

  it("sorts running tasks before finished ones", () => {
    const tasks = deriveLiveTasks([
      act("task.started", { taskId: "done", taskType: "shell" }),
      act("task.completed", { taskId: "done", status: "completed" }),
      act("task.started", { taskId: "live", taskType: "workflow" }),
    ]);
    expect(tasks.map((t) => t.taskId)).toEqual(["live", "done"]);
  });

  it("counts running tasks", () => {
    const tasks = deriveLiveTasks([
      act("task.started", { taskId: "a" }),
      act("task.started", { taskId: "b" }),
      act("task.completed", { taskId: "b", status: "completed" }),
    ]);
    expect(countRunningTasks(tasks)).toBe(1);
  });
});
