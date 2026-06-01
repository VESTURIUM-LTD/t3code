// @effect-diagnostics nodeBuiltinImport:off
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type { ProjectGitRepo } from "@t3tools/contracts";

const execFileAsync = promisify(execFile);

/**
 * Best-effort `git fetch --prune` so the per-repo remote branch list is fresh
 * during multi-repo discovery. Never throws — offline / no-remote / auth-prompt
 * repos just keep whatever refs were last fetched. Bounded by a timeout so a
 * hung fetch can't stall discovery.
 */
export async function fetchRepoRemotes(rootPath: string): Promise<void> {
  try {
    await execFileAsync("git", ["fetch", "--prune", "--no-tags"], {
      cwd: rootPath,
      timeout: 20_000,
    });
  } catch {
    // offline / no remote / credential prompt — proceed with cached refs
  }
}

// Ported from ashvinnihalani/t3code (local-only; SSH-remote discovery dropped for prototype).

function makeRepoId(projectId: string, relativePath: string): string {
  const normalized = relativePath.trim().replaceAll("\\", "/");
  const suffix = normalized.length > 0 ? normalized : ".";
  return `${projectId}:${suffix}`;
}

function toDisplayName(relativePath: string): string {
  const normalized = relativePath.trim().replace(/\/+$/g, "");
  if (!normalized || normalized === ".") {
    return ".";
  }
  const parts = normalized.split("/");
  return parts.at(-1) ?? normalized;
}

function toProjectRepo(projectId: string, workspaceRoot: string, rootPath: string): ProjectGitRepo {
  const relativePath = path.relative(workspaceRoot, rootPath).replaceAll("\\", "/") || ".";
  return {
    id: makeRepoId(projectId, relativePath),
    rootPath,
    relativePath,
    displayName: toDisplayName(relativePath),
  };
}

/**
 * Walks `workspaceRoot` breadth-first, collecting directories that contain a
 * `.git` entry. Stops descending once a repo is found (does not recurse into
 * a repo). NOTE: if `workspaceRoot` is itself a git repo, only that repo is
 * returned — point at a non-repo parent, or select repos explicitly.
 */
export async function discoverProjectGitRepos(
  projectId: string,
  workspaceRoot: string,
): Promise<ReadonlyArray<ProjectGitRepo>> {
  const discovered = new Set<string>();
  const queue = [workspaceRoot];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;

    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }

    let hasGitEntry = false;
    for (const entry of entries) {
      if (entry.name === ".git") {
        hasGitEntry = true;
        break;
      }
    }

    const isWorkspaceRoot = current === workspaceRoot;
    if (hasGitEntry) {
      try {
        discovered.add(realpathSync.native(current));
      } catch {
        discovered.add(current);
      }
      // Stop descending into a *nested* repo, but keep descending through the
      // workspace root itself so nested sub-repos (monorepo layout) are found.
      if (!isWorkspaceRoot) {
        continue;
      }
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".turbo") {
        continue;
      }
      queue.push(path.join(current, entry.name));
    }
  }

  return Array.from(discovered)
    .toSorted((left, right) => {
      const leftRel = path.relative(workspaceRoot, left).replaceAll("\\", "/") || ".";
      const rightRel = path.relative(workspaceRoot, right).replaceAll("\\", "/") || ".";
      return leftRel.localeCompare(rightRel);
    })
    .map((rootPath) => toProjectRepo(projectId, workspaceRoot, rootPath));
}

/** Builds a ProjectGitRepo from an explicitly-selected absolute repo path. */
export function toExplicitProjectRepo(
  projectId: string,
  workspaceRoot: string,
  rootPath: string,
): ProjectGitRepo {
  return toProjectRepo(projectId, workspaceRoot, rootPath);
}
