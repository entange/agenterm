import { simpleGit } from 'simple-git';
import type { SimpleGit } from 'simple-git';

/** Worktree-aware git detail for one cwd. Nulls when unknown or not a repo. */
export interface GitInfo {
  branch: string | null;
  worktreeRoot: string | null;
}

/**
 * Read branch plus worktree root with rev-parse only. No watchers here.
 * Never throws: failures yield nulls so display can proceed without git.
 */
export async function readGitInfo(cwd: string, git: SimpleGit = simpleGit(cwd)): Promise<GitInfo> {
  try {
    const branchRaw = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim();
    const rootRaw = (await git.revparse(['--show-toplevel'])).trim();
    return {
      branch: branchRaw.length > 0 && branchRaw !== 'HEAD' ? branchRaw : null,
      worktreeRoot: rootRaw.length > 0 ? rootRaw : null
    };
  } catch {
    return { branch: null, worktreeRoot: null };
  }
}

/**
 * List session ids that share a cwd with the given one, excluding the
 * given session itself. Powers the shared-cwd warning badge.
 */
export function sharedCwdSessions(selfId: string, cwd: string, all: Array<{ id: string; cwd: string }>): string[] {
  return all.filter((entry) => entry.id !== selfId && entry.cwd === cwd).map((entry) => entry.id);
}
