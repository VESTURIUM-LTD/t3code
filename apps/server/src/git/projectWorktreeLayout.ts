// @effect-diagnostics nodeBuiltinImport:off
import crypto from "node:crypto";
import path from "node:path";

import type { ProjectGitRepo, ProjectRepoWorktree } from "@t3tools/contracts";

// Ported from ashvinnihalani/t3code (local-only; SSH-remote layout dropped for prototype).

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "repo";
}

function repoChildName(relativePath: string): string {
  if (relativePath === ".") {
    return "root";
  }
  return relativePath.split("/").map(sanitizeSegment).join("__");
}

/** A synthetic parent dir holding one worktree per repo: <worktreesDir>/multi-repo/<thread>/<branch>/ */
export function buildSyntheticWorktreeParent(input: {
  worktreesDir: string;
  threadId?: string;
  branch: string;
}): string {
  const branchSegment = sanitizeSegment(input.branch);
  const threadSegment = sanitizeSegment(input.threadId ?? crypto.randomUUID().slice(0, 8));
  return path.join(input.worktreesDir, "multi-repo", threadSegment, branchSegment);
}

export function buildRepoWorktreeLayout(input: {
  parentPath: string;
  repos: ReadonlyArray<ProjectGitRepo>;
}): ReadonlyArray<ProjectRepoWorktree> {
  return input.repos.map((repo) => ({
    repoId: repo.id,
    repoRelativePath: repo.relativePath,
    sourceRootPath: repo.rootPath,
    worktreePath: path.join(input.parentPath, repoChildName(repo.relativePath)),
  }));
}
