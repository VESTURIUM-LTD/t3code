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
const GIT_REF_TIMEOUT = 5_000;

/**
 * Resolve the commit a repo's session branch forked from, so the diff can show
 * everything the session changed — including work the agent COMMITTED to the
 * branch — rather than only the still-uncommitted working tree. This mirrors
 * single-repo checkpoint semantics (thread-start → now); without it, a session
 * whose work is committed (the documented "commit + open a PR" flow) shows an
 * empty diff because the working tree matches HEAD.
 *
 * Tries, in priority order, the branch's own upstream, the remote's default
 * branch (origin/HEAD → origin/main → origin/master), then a local main/master,
 * and returns `git merge-base HEAD <base>` for the first that resolves. Falls
 * back to "HEAD" (uncommitted-only, the previous behavior) when no mainline can
 * be found — detached HEAD, no remote, unrelated histories, etc.
 */
async function resolveForkPointRef(repoCwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  const mergeBaseWith = async (baseRef: string): Promise<string | null> => {
    try {
      const { stdout } = await execFileAsync("git", ["merge-base", "HEAD", baseRef], {
        cwd: repoCwd,
        env,
        timeout: GIT_REF_TIMEOUT,
      });
      const oid = stdout.trim();
      return oid.length > 0 ? oid : null;
    } catch {
      return null; // baseRef missing / unrelated history
    }
  };

  // 1) The branch's own upstream (covers "remote"/"existing" branch modes).
  const fromUpstream = await mergeBaseWith("@{upstream}");
  if (fromUpstream) return fromUpstream;

  // 2) The remote's default branch (covers "new branch from latest main").
  let originDefault: string | null = null;
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
      { cwd: repoCwd, env, timeout: GIT_REF_TIMEOUT },
    );
    originDefault = stdout.trim() || null; // e.g. "origin/main"
  } catch {
    // origin/HEAD not set — fall through to common candidates
  }
  for (const candidate of [originDefault, "origin/main", "origin/master", "main", "master"]) {
    if (!candidate) continue;
    const base = await mergeBaseWith(candidate);
    if (base) return base;
  }

  // 3) No mainline resolved — diff against HEAD (uncommitted changes only).
  return "HEAD";
}

/**
 * Diff for ONE repo worktree covering everything the session changed since its
 * branch forked — COMMITTED commits AND uncommitted/untracked (non-ignored)
 * edits — with every path prefixed by the repo's path inside the multi-repo
 * session (e.g. `blackvesto-backend/src/foo.ts`).
 *
 * Uses a throwaway index (GIT_INDEX_FILE) seeded from HEAD: `read-tree HEAD`
 * then `add -A` stages the live working tree (untracked included, .gitignore
 * respected) into the temp index, and `diff --cached <fork-point>` reports the
 * whole range fork-point → working tree. The repo's real index is never touched.
 */
async function workingTreeDiffForRepo(repoCwd: string, relativePath: string): Promise<string> {
  const tmpIndex = path.join(tmpdir(), `t3-mrdiff-${randomUUID()}.index`);
  const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
  const prefix = relativePath && relativePath !== "." ? `${relativePath}/` : "";
  try {
    await execFileAsync("git", ["read-tree", "HEAD"], { cwd: repoCwd, env });
    await execFileAsync("git", ["add", "-A"], { cwd: repoCwd, env });
    const forkPoint = await resolveForkPointRef(repoCwd, env);
    const { stdout } = await execFileAsync(
      "git",
      ["diff", "--cached", forkPoint, `--src-prefix=a/${prefix}`, `--dst-prefix=b/${prefix}`],
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
 * Aggregated diff across every repo worktree of a multi-repo session (the
 * parent/root worktree + each nested sub-repo), covering everything the session
 * changed since each branch forked — COMMITTED work included, not just the
 * uncommitted working tree. The single-cwd checkpoint diff only sees the root,
 * so sub-repo changes are invisible; this stitches each repo's fork-point→now
 * `git diff` into one unified-diff string (paths prefixed by repo), which the
 * existing diff renderer parses as files grouped by repo.
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
