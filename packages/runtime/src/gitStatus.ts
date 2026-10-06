import { simpleGit, type FileStatusResult, type SimpleGit } from 'simple-git';

/** One changed file with staged and unstaged states. */
export interface GitFileState {
  path: string;
  staged: string | null;
  unstaged: string | null;
}

/** Full git status for one session cwd. Nulls when not a repo. */
export interface GitStatus {
  branch: string | null;
  worktreeRoot: string | null;
  isDirty: boolean;
  stagedCount: number;
  unstagedCount: number;
  files: GitFileState[];
  insertions: number;
  deletions: number;
}

const EMPTY: GitStatus = {
  branch: null,
  worktreeRoot: null,
  isDirty: false,
  stagedCount: 0,
  unstagedCount: 0,
  files: [],
  insertions: 0,
  deletions: 0
};

/** Map one porcelain status letter to a readable state. */
function describe(code: string): string | null {
  switch (code) {
    case 'M':
      return 'modified';
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    case 'C':
      return 'copied';
    case 'U':
      return 'conflicted';
    case 'T':
      return 'typechange';
    default:
      return null;
  }
}

/**
 * Split porcelain entries into staged and unstaged sides.
 *
 * simple-git's `modified` list mixes index and worktree changes, so
 * per-file index and working_dir letters are the only reliable source.
 */
function fileStates(entries: readonly FileStatusResult[]): GitFileState[] {
  return entries
    .map((entry) => {
      if (entry.index === '?' && entry.working_dir === '?') {
        return { path: entry.path, staged: null, unstaged: 'untracked' };
      }
      return { path: entry.path, staged: describe(entry.index), unstaged: describe(entry.working_dir) };
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * Read full status plus diff stats with simple-git.
 *
 * Rev-parse supplies branch and root; status supplies per-file state;
 * diff summary supplies insertion and deletion totals. Non-repos and
 * any failure yield the empty status, never a throw.
 */
export async function readGitStatus(cwd: string, git?: SimpleGit): Promise<GitStatus> {
  const client = git ?? simpleGit(cwd);
  try {
    const [status, summary, rootRaw] = await Promise.all([
      client.status(),
      // Against HEAD so staged and unstaged edits both count; fresh repos have no HEAD.
      client.diffSummary(['HEAD']).catch(() => ({ insertions: 0, deletions: 0, files: [] })),
      client.revparse(['--show-toplevel']).catch(() => '')
    ]);
    const branch = status.current === null || status.current.length === 0 ? null : status.current;
    const root = typeof rootRaw === 'string' && rootRaw.trim().length > 0 ? rootRaw.trim() : null;
    const files = fileStates(status.files);
    return {
      branch,
      worktreeRoot: root,
      isDirty: files.length > 0,
      stagedCount: files.filter((file) => file.staged !== null).length,
      unstagedCount: files.filter((file) => file.unstaged !== null).length,
      files: files.slice(0, 200),
      insertions: summary.insertions,
      deletions: summary.deletions
    };
  } catch {
    return { ...EMPTY };
  }
}
