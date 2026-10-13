import fs from 'node:fs';
import path from 'node:path';
import { simpleGit, type FileStatusResult, type SimpleGit } from 'simple-git';
import { gitAt } from './gitInfo.js';

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
  try {
    const client = git ?? gitAt(cwd);
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

/** Diff text cap. Large generated files would otherwise stall the UI. */
export const MAX_DIFF_BYTES = 256 * 1024;

/**
 * Resolve a worktree-relative path, refusing anything that escapes the
 * root (absolute paths, `..` segments, or symlinked parents). Returns
 * the cleaned relative path or null.
 */
export function safeRelativePath(root: string, file: string): string | null {
  if (file.length === 0 || file.length > 4096 || file.includes('\0') || path.isAbsolute(file)) return null;
  const resolved = path.resolve(root, file);
  const relative = path.relative(root, resolved);
  if (relative.length === 0 || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join('/');
}

/**
 * Unified diff for one file versus HEAD, covering staged and unstaged
 * edits. Untracked files diff against /dev/null so new files show as
 * additions. Output is capped at MAX_DIFF_BYTES. Never throws.
 */
export async function readGitDiff(
  cwd: string,
  file: string,
  git?: SimpleGit
): Promise<{ path: string; diff: string; truncated: boolean } | null> {
  let root: string;
  let rooted: SimpleGit;
  try {
    const client = git ?? gitAt(cwd);
    root = (await client.revparse(['--show-toplevel'])).trim();
    rooted = git === undefined ? gitAt(root) : simpleGit(root);
  } catch {
    return null;
  }
  const relative = safeRelativePath(root, file);
  if (relative === null) return null;
  let diff = '';
  try {
    diff = await rooted.raw(['diff', '--no-color', 'HEAD', '--', relative]);
  } catch {
    // No HEAD yet in a fresh repo; fall back to the index view.
    diff = await rooted.raw(['diff', '--no-color', '--', relative]).catch(() => '');
  }
  if (diff.trim().length === 0) {
    const tracked = await rooted.raw(['ls-files', '--', relative]).catch(() => '');
    if (tracked.trim().length === 0 && fs.existsSync(path.join(root, relative))) {
      // git diff --no-index exits 1 when files differ, which simple-git reports as an error.
      diff = await rooted
        .raw(['diff', '--no-color', '--no-index', '--', '/dev/null', relative])
        .catch((error: unknown) => (error instanceof Error ? extractDiff(error.message) : ''));
    }
  }
  const truncated = Buffer.byteLength(diff, 'utf8') > MAX_DIFF_BYTES;
  return { path: relative, diff: truncated ? diff.slice(0, MAX_DIFF_BYTES) : diff, truncated };
}

function extractDiff(message: string): string {
  const start = message.indexOf('diff --git');
  return start === -1 ? '' : message.slice(start);
}
