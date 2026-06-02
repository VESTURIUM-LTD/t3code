// @effect-diagnostics nodeBuiltinImport:off
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { CheckpointRef, ProjectId, ThreadId, TurnId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { afterEach, describe, expect, it } from "vitest";

import {
  ProjectionSnapshotQuery,
  type ProjectionThreadCheckpointContext,
} from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { checkpointRefForThreadTurn } from "../Utils.ts";
import { CheckpointDiffQueryLive } from "./CheckpointDiffQuery.ts";
import { CheckpointStore, type CheckpointStoreShape } from "../Services/CheckpointStore.ts";
import { CheckpointDiffQuery } from "../Services/CheckpointDiffQuery.ts";

function makeThreadCheckpointContext(input: {
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly workspaceRoot: string;
  readonly worktreePath: string | null;
  readonly checkpointTurnCount: number;
  readonly checkpointRef: CheckpointRef;
}): ProjectionThreadCheckpointContext {
  return {
    threadId: input.threadId,
    projectId: input.projectId,
    workspaceRoot: input.workspaceRoot,
    worktreePath: input.worktreePath,
    checkpoints: [
      {
        turnId: TurnId.make("turn-1"),
        checkpointTurnCount: input.checkpointTurnCount,
        checkpointRef: input.checkpointRef,
        status: "ready",
        files: [],
        assistantMessageId: null,
        completedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  };
}

const GIT_ENV = {
  GIT_AUTHOR_NAME: "t3-test",
  GIT_AUTHOR_EMAIL: "t3-test@example.com",
  GIT_COMMITTER_NAME: "t3-test",
  GIT_COMMITTER_EMAIL: "t3-test@example.com",
};
function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...GIT_ENV } });
}

const tempDirs: string[] = [];

/**
 * Builds a minimal multi-repo session (root repo + one sub-repo) where the
 * sub-repo has work COMMITTED on a `sess` branch forked from `main`. Returns the
 * session parent path. The aggregator surfaces the committed change; the
 * single-repo checkpoint path would not.
 */
function buildMultiRepoSessionWithCommittedSubRepoWork(marker: string): string {
  const base = mkdtempSync(nodePath.join(tmpdir(), "t3-turndiff-"));
  tempDirs.push(base);
  const session = nodePath.join(base, "session");

  mkdirSync(session, { recursive: true });
  git(session, "init", "-q", "-b", "main");
  writeFileSync(nodePath.join(session, "root.txt"), "root v1\n");
  writeFileSync(nodePath.join(session, ".gitignore"), "subA/\n");
  git(session, "add", "-A");
  git(session, "commit", "-q", "-m", "seed root");

  const subA = nodePath.join(session, "subA");
  mkdirSync(subA, { recursive: true });
  git(subA, "init", "-q", "-b", "main");
  writeFileSync(nodePath.join(subA, "a.txt"), "a v1\n");
  git(subA, "add", "-A");
  git(subA, "commit", "-q", "-m", "seed subA");
  git(subA, "checkout", "-q", "-b", "sess");
  writeFileSync(nodePath.join(subA, "a.txt"), `a v2 ${marker}\n`);
  git(subA, "add", "-A");
  git(subA, "commit", "-q", "-m", "feat: agent change");

  return session;
}

describe("CheckpointDiffQueryLive", () => {
  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it("uses the narrow full-thread context lookup for all-turns diffs", async () => {
    const projectId = ProjectId.make("project-full-thread");
    const threadId = ThreadId.make("thread-full-thread");
    const toCheckpointRef = checkpointRefForThreadTurn(threadId, 4);
    let getThreadCheckpointContextCalls = 0;
    let getFullThreadDiffContextCalls = 0;
    const diffCheckpointsCalls: Array<{
      readonly fromCheckpointRef: CheckpointRef;
      readonly toCheckpointRef: CheckpointRef;
      readonly cwd: string;
      readonly ignoreWhitespace: boolean;
    }> = [];

    const checkpointStore: CheckpointStoreShape = {
      isGitRepository: () => Effect.succeed(true),
      captureCheckpoint: () => Effect.void,
      hasCheckpointRef: () => Effect.succeed(true),
      restoreCheckpoint: () => Effect.succeed(true),
      diffCheckpoints: ({ fromCheckpointRef, toCheckpointRef, cwd, ignoreWhitespace }) =>
        Effect.sync(() => {
          diffCheckpointsCalls.push({
            fromCheckpointRef,
            toCheckpointRef,
            cwd,
            ignoreWhitespace,
          });
          return "full thread diff patch";
        }),
      deleteCheckpointRefs: () => Effect.void,
    };

    const layer = CheckpointDiffQueryLive.pipe(
      Layer.provideMerge(Layer.succeed(CheckpointStore, checkpointStore)),
      Layer.provideMerge(
        Layer.succeed(ProjectionSnapshotQuery, {
          getCommandReadModel: () =>
            Effect.die("CheckpointDiffQuery should not request the command read model"),
          getSnapshot: () =>
            Effect.die("CheckpointDiffQuery should not request the full orchestration snapshot"),
          getShellSnapshot: () =>
            Effect.die("CheckpointDiffQuery should not request the orchestration shell snapshot"),
          getArchivedShellSnapshot: () =>
            Effect.die("CheckpointDiffQuery should not request archived shell snapshots"),
          getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 0 }),
          getCounts: () => Effect.succeed({ projectCount: 0, threadCount: 0 }),
          getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
          getProjectShellById: () => Effect.succeed(Option.none()),
          getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
          getThreadCheckpointContext: () =>
            Effect.sync(() => {
              getThreadCheckpointContextCalls += 1;
              return Option.none();
            }),
          getFullThreadDiffContext: () =>
            Effect.sync(() => {
              getFullThreadDiffContextCalls += 1;
              return Option.some({
                threadId,
                projectId,
                workspaceRoot: "/tmp/workspace",
                worktreePath: "/tmp/worktree",
                latestCheckpointTurnCount: 4,
                toCheckpointRef,
              });
            }),
          getThreadShellById: () => Effect.succeed(Option.none()),
          getThreadDetailById: () => Effect.succeed(Option.none()),
        }),
      ),
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const query = yield* CheckpointDiffQuery;
        return yield* query.getFullThreadDiff({
          threadId,
          toTurnCount: 4,
          ignoreWhitespace: true,
        });
      }).pipe(Effect.provide(layer)),
    );

    expect(getThreadCheckpointContextCalls).toBe(0);
    expect(getFullThreadDiffContextCalls).toBe(1);
    expect(diffCheckpointsCalls).toEqual([
      {
        cwd: "/tmp/worktree",
        fromCheckpointRef: checkpointRefForThreadTurn(threadId, 0),
        toCheckpointRef,
        ignoreWhitespace: true,
      },
    ]);
    expect(result).toEqual({
      threadId,
      fromTurnCount: 0,
      toTurnCount: 4,
      diff: "full thread diff patch",
    });
  });

  it("computes diffs using canonical turn-0 checkpoint refs", async () => {
    const projectId = ProjectId.make("project-1");
    const threadId = ThreadId.make("thread-1");
    const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);
    const diffCheckpointsCalls: Array<{
      readonly fromCheckpointRef: CheckpointRef;
      readonly toCheckpointRef: CheckpointRef;
      readonly cwd: string;
      readonly ignoreWhitespace: boolean;
    }> = [];

    const threadCheckpointContext = makeThreadCheckpointContext({
      projectId,
      threadId,
      workspaceRoot: "/tmp/workspace",
      worktreePath: null,
      checkpointTurnCount: 1,
      checkpointRef: toCheckpointRef,
    });

    const checkpointStore: CheckpointStoreShape = {
      isGitRepository: () => Effect.succeed(true),
      captureCheckpoint: () => Effect.void,
      hasCheckpointRef: () => Effect.succeed(true),
      restoreCheckpoint: () => Effect.succeed(true),
      diffCheckpoints: ({ fromCheckpointRef, toCheckpointRef, cwd, ignoreWhitespace }) =>
        Effect.sync(() => {
          diffCheckpointsCalls.push({
            fromCheckpointRef,
            toCheckpointRef,
            cwd,
            ignoreWhitespace,
          });
          return "diff patch";
        }),
      deleteCheckpointRefs: () => Effect.void,
    };

    const layer = CheckpointDiffQueryLive.pipe(
      Layer.provideMerge(Layer.succeed(CheckpointStore, checkpointStore)),
      Layer.provideMerge(
        Layer.succeed(ProjectionSnapshotQuery, {
          getCommandReadModel: () =>
            Effect.die("CheckpointDiffQuery should not request the command read model"),
          getSnapshot: () =>
            Effect.die("CheckpointDiffQuery should not request the full orchestration snapshot"),
          getShellSnapshot: () =>
            Effect.die("CheckpointDiffQuery should not request the orchestration shell snapshot"),
          getArchivedShellSnapshot: () =>
            Effect.die("CheckpointDiffQuery should not request archived shell snapshots"),
          getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 0 }),
          getCounts: () => Effect.succeed({ projectCount: 0, threadCount: 0 }),
          getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
          getProjectShellById: () => Effect.succeed(Option.none()),
          getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
          getThreadCheckpointContext: () => Effect.succeed(Option.some(threadCheckpointContext)),
          getFullThreadDiffContext: () => Effect.die("unused"),
          getThreadShellById: () => Effect.succeed(Option.none()),
          getThreadDetailById: () => Effect.succeed(Option.none()),
        }),
      ),
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const query = yield* CheckpointDiffQuery;
        return yield* query.getTurnDiff({
          threadId,
          fromTurnCount: 0,
          toTurnCount: 1,
          ignoreWhitespace: true,
        });
      }).pipe(Effect.provide(layer)),
    );

    const expectedFromRef = checkpointRefForThreadTurn(threadId, 0);
    expect(diffCheckpointsCalls).toEqual([
      {
        cwd: "/tmp/workspace",
        fromCheckpointRef: expectedFromRef,
        toCheckpointRef,
        ignoreWhitespace: true,
      },
    ]);
    expect(result).toEqual({
      threadId,
      fromTurnCount: 0,
      toTurnCount: 1,
      diff: "diff patch",
    });
  });

  it("defaults to hide whitespace changes", async () => {
    const projectId = ProjectId.make("project-default-whitespace");
    const threadId = ThreadId.make("thread-default-whitespace");
    const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);
    const diffCheckpointsCalls: Array<{ readonly ignoreWhitespace: boolean }> = [];

    const threadCheckpointContext = makeThreadCheckpointContext({
      projectId,
      threadId,
      workspaceRoot: "/tmp/workspace",
      worktreePath: null,
      checkpointTurnCount: 1,
      checkpointRef: toCheckpointRef,
    });

    const checkpointStore: CheckpointStoreShape = {
      isGitRepository: () => Effect.succeed(true),
      captureCheckpoint: () => Effect.void,
      hasCheckpointRef: () => Effect.succeed(true),
      restoreCheckpoint: () => Effect.succeed(true),
      diffCheckpoints: ({ ignoreWhitespace }) =>
        Effect.sync(() => {
          diffCheckpointsCalls.push({ ignoreWhitespace });
          return "diff patch";
        }),
      deleteCheckpointRefs: () => Effect.void,
    };

    const layer = CheckpointDiffQueryLive.pipe(
      Layer.provideMerge(Layer.succeed(CheckpointStore, checkpointStore)),
      Layer.provideMerge(
        Layer.succeed(ProjectionSnapshotQuery, {
          getCommandReadModel: () =>
            Effect.die("CheckpointDiffQuery should not request the command read model"),
          getSnapshot: () =>
            Effect.die("CheckpointDiffQuery should not request the full orchestration snapshot"),
          getShellSnapshot: () =>
            Effect.die("CheckpointDiffQuery should not request the orchestration shell snapshot"),
          getArchivedShellSnapshot: () =>
            Effect.die("CheckpointDiffQuery should not request archived shell snapshots"),
          getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 0 }),
          getCounts: () => Effect.succeed({ projectCount: 0, threadCount: 0 }),
          getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
          getProjectShellById: () => Effect.succeed(Option.none()),
          getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
          getThreadCheckpointContext: () => Effect.succeed(Option.some(threadCheckpointContext)),
          getFullThreadDiffContext: () => Effect.die("unused"),
          getThreadShellById: () => Effect.succeed(Option.none()),
          getThreadDetailById: () => Effect.succeed(Option.none()),
        }),
      ),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const query = yield* CheckpointDiffQuery;
        return yield* query.getTurnDiff({
          threadId,
          fromTurnCount: 0,
          toTurnCount: 1,
        });
      }).pipe(Effect.provide(layer)),
    );

    expect(diffCheckpointsCalls).toEqual([{ ignoreWhitespace: true }]);
  });

  it("does not preflight checkpoint refs before diffing", async () => {
    const projectId = ProjectId.make("project-no-preflight");
    const threadId = ThreadId.make("thread-no-preflight");
    const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);
    let hasCheckpointRefCallCount = 0;

    const threadCheckpointContext = makeThreadCheckpointContext({
      projectId,
      threadId,
      workspaceRoot: "/tmp/workspace",
      worktreePath: null,
      checkpointTurnCount: 1,
      checkpointRef: toCheckpointRef,
    });

    const checkpointStore: CheckpointStoreShape = {
      isGitRepository: () => Effect.succeed(true),
      captureCheckpoint: () => Effect.void,
      hasCheckpointRef: () =>
        Effect.sync(() => {
          hasCheckpointRefCallCount += 1;
          return true;
        }),
      restoreCheckpoint: () => Effect.succeed(true),
      diffCheckpoints: () => Effect.succeed("diff patch"),
      deleteCheckpointRefs: () => Effect.void,
    };

    const layer = CheckpointDiffQueryLive.pipe(
      Layer.provideMerge(Layer.succeed(CheckpointStore, checkpointStore)),
      Layer.provideMerge(
        Layer.succeed(ProjectionSnapshotQuery, {
          getCommandReadModel: () =>
            Effect.die("CheckpointDiffQuery should not request the command read model"),
          getSnapshot: () =>
            Effect.die("CheckpointDiffQuery should not request the full orchestration snapshot"),
          getShellSnapshot: () =>
            Effect.die("CheckpointDiffQuery should not request the orchestration shell snapshot"),
          getArchivedShellSnapshot: () =>
            Effect.die("CheckpointDiffQuery should not request archived shell snapshots"),
          getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 0 }),
          getCounts: () => Effect.succeed({ projectCount: 0, threadCount: 0 }),
          getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
          getProjectShellById: () => Effect.succeed(Option.none()),
          getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
          getThreadCheckpointContext: () => Effect.succeed(Option.some(threadCheckpointContext)),
          getFullThreadDiffContext: () => Effect.die("unused"),
          getThreadShellById: () => Effect.succeed(Option.none()),
          getThreadDetailById: () => Effect.succeed(Option.none()),
        }),
      ),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const query = yield* CheckpointDiffQuery;
        return yield* query.getTurnDiff({
          threadId,
          fromTurnCount: 0,
          toTurnCount: 1,
          ignoreWhitespace: true,
        });
      }).pipe(Effect.provide(layer)),
    );

    expect(hasCheckpointRefCallCount).toBe(0);
  });

  it("multi-repo: getTurnDiff returns the aggregated cross-repo diff, not the checkpoint diff", async () => {
    const projectId = ProjectId.make("project-multi-turn");
    const threadId = ThreadId.make("thread-multi-turn");
    const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);
    const session = buildMultiRepoSessionWithCommittedSubRepoWork("committed-sub-repo-change");

    let diffCheckpointsCalled = false;
    const threadCheckpointContext = makeThreadCheckpointContext({
      projectId,
      threadId,
      workspaceRoot: session,
      worktreePath: session,
      checkpointTurnCount: 1,
      checkpointRef: toCheckpointRef,
    });

    const checkpointStore: CheckpointStoreShape = {
      isGitRepository: () => Effect.succeed(true),
      captureCheckpoint: () => Effect.void,
      hasCheckpointRef: () => Effect.succeed(true),
      restoreCheckpoint: () => Effect.succeed(true),
      diffCheckpoints: () =>
        Effect.sync(() => {
          diffCheckpointsCalled = true;
          return "ROOT ONLY CHECKPOINT DIFF";
        }),
      deleteCheckpointRefs: () => Effect.void,
    };

    const layer = CheckpointDiffQueryLive.pipe(
      Layer.provideMerge(Layer.succeed(CheckpointStore, checkpointStore)),
      Layer.provideMerge(
        Layer.succeed(ProjectionSnapshotQuery, {
          getCommandReadModel: () => Effect.die("unused"),
          getSnapshot: () => Effect.die("unused"),
          getShellSnapshot: () => Effect.die("unused"),
          getArchivedShellSnapshot: () => Effect.die("unused"),
          getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 0 }),
          getCounts: () => Effect.succeed({ projectCount: 0, threadCount: 0 }),
          getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
          getProjectShellById: () => Effect.succeed(Option.none()),
          getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
          getThreadCheckpointContext: () => Effect.succeed(Option.some(threadCheckpointContext)),
          getFullThreadDiffContext: () => Effect.die("unused"),
          getThreadShellById: () => Effect.succeed(Option.none()),
          getThreadDetailById: () => Effect.succeed(Option.none()),
        }),
      ),
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const query = yield* CheckpointDiffQuery;
        return yield* query.getTurnDiff({
          threadId,
          fromTurnCount: 0,
          toTurnCount: 1,
          ignoreWhitespace: true,
        });
      }).pipe(Effect.provide(layer)),
    );

    expect(result.diff).toContain("committed-sub-repo-change");
    expect(result.diff).toContain("subA/a.txt");
    expect(diffCheckpointsCalled).toBe(false);
  });

  it("fails when the thread is missing from the snapshot", async () => {
    const threadId = ThreadId.make("thread-missing");

    const checkpointStore: CheckpointStoreShape = {
      isGitRepository: () => Effect.succeed(true),
      captureCheckpoint: () => Effect.void,
      hasCheckpointRef: () => Effect.succeed(true),
      restoreCheckpoint: () => Effect.succeed(true),
      diffCheckpoints: () => Effect.succeed(""),
      deleteCheckpointRefs: () => Effect.void,
    };

    const layer = CheckpointDiffQueryLive.pipe(
      Layer.provideMerge(Layer.succeed(CheckpointStore, checkpointStore)),
      Layer.provideMerge(
        Layer.succeed(ProjectionSnapshotQuery, {
          getCommandReadModel: () =>
            Effect.die("CheckpointDiffQuery should not request the command read model"),
          getSnapshot: () =>
            Effect.die("CheckpointDiffQuery should not request the full orchestration snapshot"),
          getShellSnapshot: () =>
            Effect.die("CheckpointDiffQuery should not request the orchestration shell snapshot"),
          getArchivedShellSnapshot: () =>
            Effect.die("CheckpointDiffQuery should not request archived shell snapshots"),
          getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 0 }),
          getCounts: () => Effect.succeed({ projectCount: 0, threadCount: 0 }),
          getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
          getProjectShellById: () => Effect.succeed(Option.none()),
          getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
          getThreadCheckpointContext: () => Effect.succeed(Option.none()),
          getFullThreadDiffContext: () => Effect.succeed(Option.none()),
          getThreadShellById: () => Effect.succeed(Option.none()),
          getThreadDetailById: () => Effect.succeed(Option.none()),
        }),
      ),
    );

    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const query = yield* CheckpointDiffQuery;
          return yield* query.getTurnDiff({
            threadId,
            fromTurnCount: 0,
            toTurnCount: 1,
          });
        }).pipe(Effect.provide(layer)),
      ),
    ).rejects.toThrow("Thread 'thread-missing' not found.");
  });
});
