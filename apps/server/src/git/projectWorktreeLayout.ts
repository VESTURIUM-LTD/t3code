// @effect-diagnostics nodeBuiltinImport:off
import crypto from "node:crypto";
import path from "node:path";

import type { ProjectGitRepo, ProjectRepoWorktree } from "@t3tools/contracts";

// Ported from ashvinnihalani/t3code (local-only; SSH-remote layout dropped for prototype).

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "repo";
}

/** The session base dir holding the multi-repo worktrees: <worktreesDir>/multi-repo/<thread>/<branch>/ */
export function buildSyntheticWorktreeParent(input: {
  worktreesDir: string;
  threadId?: string;
  branch: string;
}): string {
  const branchSegment = sanitizeSegment(input.branch);
  const threadSegment = sanitizeSegment(input.threadId ?? crypto.randomUUID().slice(0, 8));
  return path.join(input.worktreesDir, "multi-repo", threadSegment, branchSegment);
}

/**
 * Lays out worktrees mirroring the real project structure:
 * - the project root (relativePath ".") becomes the session base dir itself, so
 *   its .claude/skills + CLAUDE.md + .mcp.json auto-load (the agent runs "at root").
 * - every other repo is a worktree at its real relative path inside the base.
 */
export function buildRepoWorktreeLayout(input: {
  parentPath: string;
  repos: ReadonlyArray<ProjectGitRepo>;
}): ReadonlyArray<ProjectRepoWorktree> {
  return input.repos.map((repo) => ({
    repoId: repo.id,
    repoRelativePath: repo.relativePath,
    sourceRootPath: repo.rootPath,
    worktreePath:
      repo.relativePath === "." ? input.parentPath : path.join(input.parentPath, repo.relativePath),
  }));
}
