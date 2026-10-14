import { simpleGit } from 'simple-git';
import type { SimpleGit } from 'simple-git';

const GIT_ENV_KEYS = ['PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'TMPDIR', 'XDG_CONFIG_HOME', 'SystemRoot'];

/**
 * A git client for read-only inspection of an agent's folder.
 *
 * GIT_OPTIONAL_LOCKS=0 keeps `status` from taking index.lock, so polling
 * never makes an agent's own `git add` or `commit` fail. Only a minimal
 * env is passed (simple-git refuses editor and ssh overrides). Throws when
 * the folder no longer exists; callers treat that like a non-repo.
 */
export function gitAt(cwd: string): SimpleGit {
  const env: Record<string, string> = { GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
  for (const key of GIT_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return simpleGit({
    baseDir: cwd,
    maxConcurrentProcesses: 2,
    allowEnvironment: ['GIT_OPTIONAL_LOCKS', 'GIT_TERMINAL_PROMPT']
  }).env(env);
}

/** Worktree-aware git detail for one cwd. Nulls when unknown or not a repo. */
export interface GitInfo {
  branch: string | null;
  worktreeRoot: string | null;
}

/**
 * Read branch plus worktree root with rev-parse only. No watchers here.
 * Never throws: failures yield nulls so display can proceed without git.
 */
export async function readGitInfo(cwd: string, git?: SimpleGit): Promise<GitInfo> {
  try {
    git ??= gitAt(cwd);
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
