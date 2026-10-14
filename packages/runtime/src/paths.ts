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

export function settingsPath(dir?: string): string {
  return path.join(dir ?? dataDir(), 'settings.json');
}

export function tasksDir(dir?: string): string {
  return path.join(dir ?? dataDir(), 'tasks');
}

export function taskDir(taskId: string, dir?: string): string {
  return path.join(tasksDir(dir), taskId);
}

/** Raw terminal mirror for one task. Survives daemon restarts. */
export function terminalLogPath(taskId: string, dir?: string): string {
  return path.join(taskDir(taskId, dir), 'terminal.log');
}
