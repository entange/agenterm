import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const MARKER = '__AGENTERM_ENV__';

/** Common install dirs for agent CLIs, appended when the login shell cannot be read. */
function fallbackPath(current: string | undefined): string {
  const home = os.homedir();
  const extra = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.join(home, '.local', 'bin'),
    path.join(home, '.bun', 'bin'),
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.volta', 'bin'),
    path.join(home, '.cargo', 'bin')
  ];
  const parts = (current ?? '/usr/bin:/bin:/usr/sbin:/sbin').split(path.delimiter);
  for (const dir of extra) if (!parts.includes(dir)) parts.push(dir);
  return parts.join(path.delimiter);
}

/** Parse `env -0` output framed by markers. Exported for tests. */
export function parseEnvDump(stdout: string): Record<string, string> | null {
  const start = stdout.indexOf(MARKER);
  const end = stdout.lastIndexOf(MARKER);
  if (start === -1 || end <= start) return null;
  const out: Record<string, string> = {};
  for (const entry of stdout.slice(start + MARKER.length, end).split('\0')) {
    const cut = entry.indexOf('=');
    if (cut > 0) out[entry.slice(0, cut)] = entry.slice(cut + 1);
  }
  return out;
}

/**
 * Resolve the user's login-shell environment.
 *
 * Apps launched from Finder or the Dock inherit a bare launchd env with a
 * minimal PATH, so `claude` or `codex` would not resolve and agents would
 * miss the keys and config the user set up in their shell. Reading the
 * interactive login shell once at startup fixes both. Falls back to the
 * process env plus common install dirs when the shell is slow or broken.
 */
export function loadLoginEnv(timeoutMs = 5000): Promise<Record<string, string>> {
  const base: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') base[key] = value;
  }
  if (process.platform === 'win32') return Promise.resolve(base);
  const shell = process.env['SHELL'] ?? (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
  return new Promise((resolve) => {
    execFile(
      shell,
      ['-ilc', `printf '${MARKER}'; env -0; printf '${MARKER}'`],
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env: { ...base, DISABLE_AUTO_UPDATE: 'true' } },
      (error, stdout) => {
        const parsed = error === null ? parseEnvDump(stdout) : null;
        if (parsed === null) {
          resolve({ ...base, PATH: fallbackPath(base['PATH']) });
          return;
        }
        delete parsed['SHLVL'];
        delete parsed['_'];
        resolve({ ...base, ...parsed });
      }
    );
  });
}
