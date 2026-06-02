// @effect-diagnostics nodeBuiltinImport:off
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { discoverProjectGitRepos } from "./projectRepoDiscovery.ts";

const execFileAsync = promisify(execFile);
const MAX_DIFF_BUFFER = 64 * 1024 * 1024;

/**
 * Working-tree diff for ONE repo worktree — all changes vs HEAD, INCLUDING
 * untracked (non-ignored) files — with every path prefixed by the repo's path
 * inside the multi-repo session (e.g. `blackvesto-backend/src/foo.ts`).
 *
 * Uses a throwaway index (GIT_INDEX_FILE) seeded from HEAD: `read-tree HEAD`
 * then `add -A` stages the live working tree (untracked included, .gitignore
 * respected) into the temp index, and `diff --cached HEAD` reports it. The
 * repo's real index is never touched.
 */
async function workingTreeDiffForRepo(repoCwd: string, relativePath: string): Promise<string> {
  const tmpIndex = path.join(tmpdir(), `t3-mrdiff-${randomUUID()}.index`);
  const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
  const prefix = relativePath && relativePath !== "." ? `${relativePath}/` : "";
  try {
    await execFileAsync("git", ["read-tree", "HEAD"], { cwd: repoCwd, env });
    await execFileAsync("git", ["add", "-A"], { cwd: repoCwd, env });
    const { stdout } = await execFileAsync(
      "git",
      ["diff", "--cached", "HEAD", `--src-prefix=a/${prefix}`, `--dst-prefix=b/${prefix}`],
      { cwd: repoCwd, env, maxBuffer: MAX_DIFF_BUFFER },
    );
    return stdout;
  } catch {
    // empty repo (no HEAD), not a git dir, etc. — contribute nothing
    return "";
  } finally {
    try {
      rmSync(tmpIndex, { force: true });
    } catch {
      // best-effort cleanup
    }
  }
}

/**
 * Aggregated working-tree diff across every repo worktree of a multi-repo
 * session (the parent/root worktree + each nested sub-repo). The single-cwd
 * checkpoint diff only sees the root, so sub-repo changes are invisible; this
 * stitches each repo's `git diff` into one unified-diff string (paths prefixed
 * by repo), which the existing diff renderer parses as files grouped by repo.
 *
 * Returns `null` for a single-repo thread — the caller should fall back to the
 * normal checkpoint diff. Returns "" (or a diff) for a multi-repo session.
 */
export async function aggregatedMultiRepoWorkingTreeDiff(
  parentPath: string,
): Promise<string | null> {
  // Canonicalize so the per-repo relativePath (computed against the resolved
  // rootPath) isn't polluted by symlinks (e.g. /tmp → /private/tmp), which would
  // garble the diff path prefixes.
  let root = parentPath;
  try {
    root = realpathSync(parentPath);
  } catch {
    // use the path as given
  }
  const repos = await discoverProjectGitRepos("multi-repo-diff", root);
  if (repos.length <= 1) return null; // not a multi-repo session
  // Root first, then sub-repos alphabetically — stable, readable ordering.
  const ordered = [...repos].sort((a, b) =>
    a.relativePath === "."
      ? -1
      : b.relativePath === "."
        ? 1
        : a.relativePath.localeCompare(b.relativePath),
  );
  const parts: string[] = [];
  for (const repo of ordered) {
    const diff = await workingTreeDiffForRepo(repo.rootPath, repo.relativePath);
    if (diff.trim().length > 0) parts.push(diff);
  }
  return parts.join("");
}
