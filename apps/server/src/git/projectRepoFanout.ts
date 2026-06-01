import type { ProjectGitRepo } from "@t3tools/contracts";

// Ported from ashvinnihalani/t3code (unchanged; pure).

export interface ProjectRepoRuntimeTarget extends ProjectGitRepo {
  cwd: string;
}

export function sortProjectRepos(
  repos: ReadonlyArray<ProjectGitRepo>,
): ReadonlyArray<ProjectGitRepo> {
  return repos.toSorted((left, right) => left.relativePath.localeCompare(right.relativePath));
}

export function toProjectRepoRuntimeTargets(input: {
  repos: ReadonlyArray<ProjectGitRepo>;
  worktreeByRepoId?: ReadonlyMap<string, string>;
}): ReadonlyArray<ProjectRepoRuntimeTarget> {
  return sortProjectRepos(input.repos).map((repo) => ({
    id: repo.id,
    rootPath: repo.rootPath,
    relativePath: repo.relativePath,
    displayName: repo.displayName,
    cwd: input.worktreeByRepoId?.get(repo.id) ?? repo.rootPath,
  }));
}
