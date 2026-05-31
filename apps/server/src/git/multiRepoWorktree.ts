// @effect-diagnostics nodeBuiltinImport:off
import { existsSync } from "node:fs";

import * as Effect from "effect/Effect";

import type { ProjectGitRepo, ProjectRepoWorktree, ThreadMultiRepoWorktree } from "@t3tools/contracts";

import { ServerConfig } from "../config.ts";
import { GitWorkflowService } from "./GitWorkflowService.ts";
import { sortProjectRepos } from "./projectRepoFanout.ts";
import { buildRepoWorktreeLayout, buildSyntheticWorktreeParent } from "./projectWorktreeLayout.ts";

export interface CreateMultiRepoWorktreesInput {
  readonly threadId: string;
  readonly branch: string;
  readonly baseBranch: string | null;
  readonly repos: ReadonlyArray<ProjectGitRepo>;
}

/**
 * Creates one git worktree per repo under a shared synthetic parent directory.
 * The agent then runs with cwd = parentPath, seeing every repo as a subfolder.
 * Returns the ThreadMultiRepoWorktree to persist on the thread.
 */
export const createMultiRepoWorktrees = Effect.fn("createMultiRepoWorktrees")(function* (
  input: CreateMultiRepoWorktreesInput,
) {
  const config = yield* ServerConfig;
  const gitWorkflow = yield* GitWorkflowService;

  const repos = sortProjectRepos(input.repos);
  const parentPath = buildSyntheticWorktreeParent({
    worktreesDir: config.worktreesDir,
    threadId: input.threadId,
    branch: input.branch,
  });
  const layout = buildRepoWorktreeLayout({ parentPath, repos });

  const created: ProjectRepoWorktree[] = [];
  for (const entry of layout) {
    // Idempotent: if this repo's worktree already exists (re-click / retry on the
    // same thread+branch), reuse it instead of re-running `git worktree add -b`,
    // which would fail with "a branch named '<branch>' already exists".
    if (existsSync(entry.worktreePath)) {
      created.push({
        repoId: entry.repoId,
        repoRelativePath: entry.repoRelativePath,
        sourceRootPath: entry.sourceRootPath,
        worktreePath: entry.worktreePath,
      });
      continue;
    }
    const result = yield* gitWorkflow.createWorktree({
      cwd: entry.sourceRootPath,
      refName: input.baseBranch ?? "HEAD",
      newRefName: input.branch,
      path: entry.worktreePath,
    });
    created.push({
      repoId: entry.repoId,
      repoRelativePath: entry.repoRelativePath,
      sourceRootPath: entry.sourceRootPath,
      worktreePath: result.worktree.path,
    });
  }

  return { parentPath, repos: created } satisfies ThreadMultiRepoWorktree;
});
