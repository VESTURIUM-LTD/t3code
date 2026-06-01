// @effect-diagnostics nodeBuiltinImport:off
import { existsSync } from "node:fs";

import * as Encoding from "effect/Encoding";
import { CheckpointRef, ProjectId, type ThreadId } from "@t3tools/contracts";

export const CHECKPOINT_REFS_PREFIX = "refs/t3/checkpoints";

export function checkpointRefForThreadTurn(threadId: ThreadId, turnCount: number): CheckpointRef {
  return CheckpointRef.make(
    `${CHECKPOINT_REFS_PREFIX}/${Encoding.encodeBase64Url(threadId)}/turn/${turnCount}`,
  );
}

export function resolveThreadWorkspaceCwd(input: {
  readonly thread: {
    readonly projectId: ProjectId;
    readonly worktreePath: string | null;
  };
  readonly projects: ReadonlyArray<{
    readonly id: ProjectId;
    readonly workspaceRoot: string;
  }>;
}): string | undefined {
  const projectRoot = input.projects.find(
    (project) => project.id === input.thread.projectId,
  )?.workspaceRoot;

  // Guard: a thread may carry a worktreePath whose directory has since been
  // removed (e.g. its multi-repo worktrees were deleted). Running the agent /
  // git there fails with ENOENT, so fall back to the project root.
  const worktreeCwd = input.thread.worktreePath ?? undefined;
  if (worktreeCwd && existsSync(worktreeCwd)) {
    return worktreeCwd;
  }

  return projectRoot;
}
