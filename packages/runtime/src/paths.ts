import os from 'node:os';
import path from 'node:path';

/** Default daemon port. Clients read the lock file for the actual port. */
export const DEFAULT_DAEMON_PORT = 37241;

/** Production daemon version. Single source for health output. */
export const DAEMON_VERSION = '0.1.0';

/** Resolve the agenterm data dir. Overridable for tests via env. */
export function dataDir(): string {
  const override = process.env['AGENTERM_DATA_DIR'];
  if (typeof override === 'string' && override.length > 0) {
    return override;
  }
  return path.join(os.homedir(), '.agenterm');
}

export function tokenPath(dir?: string): string {
  return path.join(dir ?? dataDir(), 'token');
}

export function lockPath(dir?: string): string {
  return path.join(dir ?? dataDir(), 'agentermd.lock');
}

export function sessionsDir(dir?: string): string {
  return path.join(dir ?? dataDir(), 'sessions');
}

export function sessionDir(sessionId: string, dir?: string): string {
  return path.join(sessionsDir(dir), sessionId);
}

/** Raw terminal mirror for one session. Survives daemon restarts. */
export function terminalLogPath(sessionId: string, dir?: string): string {
  return path.join(sessionDir(sessionId, dir), 'terminal.log');
}
