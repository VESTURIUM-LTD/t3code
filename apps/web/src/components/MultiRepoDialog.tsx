import { FoldersIcon } from "lucide-react";
import { useState } from "react";

import { scopeThreadRef } from "@t3tools/client-runtime";
import type {
  EnvironmentId,
  ProjectGitRepo,
  ProjectId,
  ProjectRepoWorktree,
  ThreadId,
} from "@t3tools/contracts";

import { useComposerDraftStore, type DraftId } from "../composerDraftStore";
import { readEnvironmentApi } from "../environmentApi";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

interface MultiRepoDialogProps {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  threadId: ThreadId;
  workspaceRoot: string;
  draftId?: DraftId;
}

/**
 * Minimal multi-repo control: discover repos under the project root, pick which
 * to include, then create one git worktree per repo. The resulting parent path
 * is written onto the (draft) thread as its worktreePath so that — once started —
 * the agent launches with cwd = parent and sees every repo.
 */
export function MultiRepoDialog({
  environmentId,
  projectId,
  threadId,
  workspaceRoot,
  draftId,
}: MultiRepoDialogProps) {
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const [open, setOpen] = useState(false);
  const [repos, setRepos] = useState<readonly ProjectGitRepo[]>([]);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [branch, setBranch] = useState("multi-repo/session");
  const [status, setStatus] = useState("");
  const [created, setCreated] = useState<readonly ProjectRepoWorktree[]>([]);
  const [inSession, setInSession] = useState<ReadonlySet<string>>(new Set());

  const discover = async () => {
    const api = readEnvironmentApi(environmentId);
    if (!api?.vcs.discoverProjectRepos) {
      setStatus("Multi-repo API unavailable in this environment.");
      return;
    }
    setStatus("Discovering repositories…");
    try {
      const result = await api.vcs.discoverProjectRepos({ projectId, workspaceRoot, threadId, branch });
      // Drop the workspace-root "." entry (the monorepo umbrella) when there are
      // nested sub-repos — those are what you actually want in a multi-repo session.
      const nested = result.repos.filter((repo) => repo.relativePath !== ".");
      const list = nested.length > 0 ? nested : result.repos;
      const existing = new Set(result.existingRepoIds);
      setRepos(list);
      setInSession(existing);
      // Pre-select repos already in this session; a fresh session starts with none
      // selected so you pick deliberately instead of unchecking everything.
      setSelected(new Set(list.filter((repo) => existing.has(repo.id)).map((repo) => repo.id)));
      setStatus(
        existing.size > 0
          ? `${existing.size} in session · ${list.length} available — check more to add.`
          : list.length === 0
            ? "No repositories found under this project."
            : `Found ${list.length} ${list.length === 1 ? "repository" : "repositories"} — select which to include.`,
      );
    } catch (error) {
      setStatus(`Discovery failed: ${String(error)}`);
    }
  };

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const create = async () => {
    const api = readEnvironmentApi(environmentId);
    if (!api?.vcs.createMultiRepoWorktree) {
      setStatus("Multi-repo API unavailable in this environment.");
      return;
    }
    const chosen = repos.filter((repo) => selected.has(repo.id));
    if (chosen.length === 0) {
      setStatus("Select at least one repository.");
      return;
    }
    setStatus(`Creating ${chosen.length} worktree(s)…`);
    try {
      const result = await api.vcs.createMultiRepoWorktree({
        threadId,
        branch,
        baseBranch: null,
        repos: chosen,
      });
      setCreated(result.repos);
      setInSession((prev) => new Set([...prev, ...chosen.map((repo) => repo.id)]));
      // Point the (draft) thread at the shared parent so, once started, the agent
      // runs with cwd = parentPath and sees every repo (resolveThreadWorkspaceCwd).
      setDraftThreadContext(draftId ?? scopeThreadRef(environmentId, threadId), {
        branch,
        worktreePath: result.parentPath,
        envMode: "worktree",
      });
      setStatus(`Created ${result.repos.length} worktree(s) under ${result.parentPath}.`);
    } catch (error) {
      setStatus(`Worktree creation failed: ${String(error)}`);
    }
  };

  return (
    <div className="relative">
      <Button
        variant="ghost"
        size="xs"
        className="font-medium"
        aria-label="Multi-repo session"
        onClick={() => {
          const next = !open;
          setOpen(next);
          if (next && repos.length === 0) {
            void discover();
          }
        }}
      >
        <FoldersIcon className="size-3" />
        Multi-repo
      </Button>

      {open ? (
        <div className="absolute bottom-full left-0 z-50 mb-2 w-96 rounded-lg border border-border bg-popover p-3 shadow-lg">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-medium">Multi-repo session</span>
            <Button variant="ghost" size="sm" onClick={() => void discover()}>
              Re-scan
            </Button>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="multi-repo-branch">Branch</Label>
            <Input
              id="multi-repo-branch"
              value={branch}
              onChange={(event) => setBranch(event.target.value)}
            />
          </div>

          <div className="mt-3 space-y-1.5">
            <Label>Repositories</Label>
            {repos.length === 0 ? (
              <p className="text-sm text-muted-foreground">No repositories discovered yet.</p>
            ) : (
              <div className="max-h-48 space-y-1 overflow-y-auto">
                {repos.map((repo) => (
                  <label key={repo.id} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={selected.has(repo.id)}
                      onChange={() => toggle(repo.id)}
                    />
                    <span className="truncate font-medium">{repo.displayName}</span>
                    {repo.relativePath !== repo.displayName ? (
                      <span className="truncate text-xs text-muted-foreground">
                        {repo.relativePath}
                      </span>
                    ) : null}
                    {inSession.has(repo.id) ? (
                      <span className="ml-auto shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                        in session
                      </span>
                    ) : null}
                  </label>
                ))}
              </div>
            )}
          </div>

          {created.length > 0 ? (
            <div className="mt-3 space-y-1">
              <Label>Created worktrees</Label>
              <div className="space-y-0.5 text-xs text-muted-foreground">
                {created.map((worktree) => (
                  <div key={worktree.worktreePath}>
                    {worktree.repoRelativePath} → {worktree.worktreePath}
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {status ? <p className="mt-3 text-xs text-muted-foreground">{status}</p> : null}

          <div className="mt-3 flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
              Close
            </Button>
            <Button size="sm" onClick={() => void create()}>
              {inSession.size > 0 ? "Update session" : "Create worktrees"}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
