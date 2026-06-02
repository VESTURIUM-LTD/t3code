// @effect-diagnostics nodeBuiltinImport:off
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { aggregatedMultiRepoWorkingTreeDiff } from "./multiRepoDiff.ts";

const GIT_ENV = {
  GIT_AUTHOR_NAME: "t3-test",
  GIT_AUTHOR_EMAIL: "t3-test@example.com",
  GIT_COMMITTER_NAME: "t3-test",
  GIT_COMMITTER_EMAIL: "t3-test@example.com",
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...GIT_ENV },
  });
}

/** Init a standalone source repo on `main` with a single seed commit. */
function makeSourceRepo(dir: string, seedFile: string, seedContent: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(path.join(dir, seedFile), seedContent);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "seed");
}

/**
 * Builds a multi-repo session that mirrors production: a root worktree at the
 * session dir plus nested sub-repo worktrees, each on a fresh `sess` branch
 * forked from its source repo's `main`. Returns the session parent path.
 */
function buildSession(base: string): {
  session: string;
  rootSrc: string;
  subASrc: string;
  subBSrc: string;
  subAWt: string;
  subBWt: string;
} {
  const sources = path.join(base, "sources");
  const session = path.join(base, "session");

  const rootSrc = path.join(sources, "root");
  const subASrc = path.join(sources, "subA");
  const subBSrc = path.join(sources, "subB");
  makeSourceRepo(rootSrc, "root.txt", "root v1\n");
  makeSourceRepo(subASrc, "a.txt", "a v1\n");
  makeSourceRepo(subBSrc, "b.txt", "b v1\n");

  // Root worktree IS the session dir (relativePath ".").
  git(rootSrc, "worktree", "add", "-q", "-b", "sess", session);
  writeFileSync(path.join(session, ".gitignore"), "subA/\nsubB/\n");
  git(session, "add", "-A");
  git(session, "commit", "-q", "-m", "ignore subrepos");

  // Nested sub-repo worktrees.
  const subAWt = path.join(session, "subA");
  const subBWt = path.join(session, "subB");
  git(subASrc, "worktree", "add", "-q", "-b", "sess", subAWt);
  git(subBSrc, "worktree", "add", "-q", "-b", "sess", subBWt);

  return { session, rootSrc, subASrc, subBSrc, subAWt, subBWt };
}

describe("aggregatedMultiRepoWorkingTreeDiff", () => {
  let base: string;
  beforeEach(() => {
    base = mkdtempSync(path.join(tmpdir(), "t3-mrdiff-"));
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it("includes work the agent COMMITTED to the session branch", async () => {
    const { session, subBWt } = buildSession(base);

    // Agent edits a sub-repo file and COMMITS it on the session branch.
    writeFileSync(path.join(subBWt, "b.txt"), "b v2 committed-by-agent\n");
    git(subBWt, "add", "-A");
    git(subBWt, "commit", "-q", "-m", "feat: agent change");

    const diff = await aggregatedMultiRepoWorkingTreeDiff(session);

    expect(diff).not.toBeNull();
    expect(diff).toContain("b v2 committed-by-agent");
    expect(diff).toContain("subB/b.txt");
  });

  it("still includes uncommitted and untracked changes (regression)", async () => {
    const { session, subAWt } = buildSession(base);

    // Uncommitted edit to a tracked file + a brand-new untracked file.
    writeFileSync(path.join(subAWt, "a.txt"), "a v2 uncommitted\n");
    writeFileSync(path.join(subAWt, "new.txt"), "freshly created\n");

    const diff = await aggregatedMultiRepoWorkingTreeDiff(session);

    expect(diff).not.toBeNull();
    expect(diff).toContain("a v2 uncommitted");
    expect(diff).toContain("freshly created");
    expect(diff).toContain("subA/new.txt");
  });

  it("combines committed + uncommitted within the same repo", async () => {
    const { session, subBWt } = buildSession(base);

    // Commit one change, then leave a second change uncommitted.
    writeFileSync(path.join(subBWt, "b.txt"), "b v2 committed\n");
    git(subBWt, "add", "-A");
    git(subBWt, "commit", "-q", "-m", "feat: step 1");
    writeFileSync(path.join(subBWt, "b.txt"), "b v3 then uncommitted\n");

    const diff = await aggregatedMultiRepoWorkingTreeDiff(session);

    expect(diff).not.toBeNull();
    // Final working-tree content vs the fork point.
    expect(diff).toContain("b v3 then uncommitted");
  });

  it("returns null for a single-repo workspace", async () => {
    const single = path.join(base, "solo");
    makeSourceRepo(single, "x.txt", "x v1\n");
    writeFileSync(path.join(single, "x.txt"), "x v2\n");

    const diff = await aggregatedMultiRepoWorkingTreeDiff(single);

    expect(diff).toBeNull();
  });
});
