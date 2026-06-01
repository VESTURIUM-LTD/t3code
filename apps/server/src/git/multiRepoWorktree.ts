// @effect-diagnostics nodeBuiltinImport:off
import { execFileSync } from "node:child_process";
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
  // Optional per-repo branch decision. Repos without an entry create `branch`
  // from baseBranch/HEAD; "existing" attaches the named local branch; "remote"
  // creates `branch` tracking `baseRef` (e.g. origin/x).
  readonly repoRefs?: ReadonlyArray<{
    readonly repoId: string;
    readonly mode: "new" | "existing" | "remote";
    readonly branch: string;
    readonly baseRef?: string | undefined;
  }>;
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
  // The project-root worktree IS the session base dir (worktreePath === parentPath);
  // create it first so the nested sub-repo worktrees land inside it.
  const ordered = [...layout].sort((a, b) =>
    a.worktreePath === parentPath ? -1 : b.worktreePath === parentPath ? 1 : 0,
  );

  // Per-repo branch decision (keyed by repoId). Repos without an entry default
  // to a new `input.branch` from HEAD.
  const refByRepoId = new Map((input.repoRefs ?? []).map((ref) => [ref.repoId, ref]));

  const created: ProjectRepoWorktree[] = [];
  for (const entry of ordered) {
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
    // Per-repo branch decision:
    //   "existing"   -> attach the named local branch into the worktree (no -b)
    //   "remote"     -> create `branchName` tracking baseRef (git auto-tracks
    //                   when branching from a remote ref like origin/x)
    //   "new"/none   -> create `branchName` from baseBranch/HEAD (default)
    const ref = refByRepoId.get(entry.repoId);
    const branchName = ref?.branch ?? input.branch;
    const createArgs =
      ref?.mode === "existing"
        ? { cwd: entry.sourceRootPath, refName: branchName, path: entry.worktreePath }
        : ref?.mode === "remote" && ref.baseRef
          ? {
              cwd: entry.sourceRootPath,
              refName: ref.baseRef,
              newRefName: branchName,
              path: entry.worktreePath,
            }
          : {
              cwd: entry.sourceRootPath,
              refName: input.baseBranch ?? "HEAD",
              newRefName: branchName,
              path: entry.worktreePath,
            };
    const result = yield* gitWorkflow
      .createWorktree(createArgs)
      .pipe(
        // Recover from two failure modes (both for "new" collisions and for
        // "existing" branches whose prior worktree dir was removed):
        //   "a branch named '<b>' already exists"        — branch lingers, free
        //   "'<b>' is already used by worktree at <path>" — stale registration
        // `git worktree prune` clears the stale registration; afterwards the
        // branch is free, so we attach it (refName only, no -b). If the branch
        // is checked out in a LIVE worktree, this still fails — surfaced as a
        // clear "already used by worktree" error.
        Effect.catchIf(
          (err) =>
            err.detail.includes("already exists") ||
            err.detail.includes("already used by worktree"),
          () =>
            Effect.sync(() => {
              try {
                execFileSync("git", ["worktree", "prune"], {
                  cwd: entry.sourceRootPath,
                  stdio: "ignore",
                });
              } catch {
                // best-effort: prune failure shouldn't mask the attach attempt
              }
            }).pipe(
              Effect.andThen(() =>
                gitWorkflow.createWorktree({
                  cwd: entry.sourceRootPath,
                  refName: branchName,
                  path: entry.worktreePath,
                }),
              ),
            ),
        ),
      );
    created.push({
      repoId: entry.repoId,
      repoRelativePath: entry.repoRelativePath,
      sourceRootPath: entry.sourceRootPath,
      worktreePath: result.worktree.path,
    });
  }

  return { parentPath, repos: created } satisfies ThreadMultiRepoWorktree;
});

/**
 * Returns the ids of repos that already have a worktree under the thread's
 * synthetic parent (for branch). Lets the UI show which repos are already part
 * of a multi-repo session and pre-select them.
 */
export function findExistingRepoWorktrees(input: {
  worktreesDir: string;
  threadId: string;
  branch: string;
  repos: ReadonlyArray<ProjectGitRepo>;
}): ReadonlyArray<string> {
  const parentPath = buildSyntheticWorktreeParent({
    worktreesDir: input.worktreesDir,
    threadId: input.threadId,
    branch: input.branch,
  });
  const layout = buildRepoWorktreeLayout({ parentPath, repos: input.repos });
  return layout.filter((entry) => existsSync(entry.worktreePath)).map((entry) => entry.repoId);
}
