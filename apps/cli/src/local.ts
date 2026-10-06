import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

/** Data dir shared with the daemon. Overridable for tests and side-by-side installs. */
export function dataDir(): string {
  const override = process.env['AGENTERM_DATA_DIR'];
  if (typeof override === 'string' && override.length > 0) return override;
  return path.join(os.homedir(), '.agenterm');
}

export function readToken(): string {
  try {
    return fs.readFileSync(path.join(dataDir(), 'token'), 'utf8').trim();
  } catch {
    return '';
  }
}

export interface LockInfo {
  pid: number;
  port: number;
  startedAtMs: number;
}

export function readLock(): LockInfo | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dataDir(), 'agentermd.lock'), 'utf8')) as Partial<LockInfo>;
    if (typeof parsed.pid === 'number' && typeof parsed.port === 'number') {
      return { pid: parsed.pid, port: parsed.port, startedAtMs: parsed.startedAtMs ?? 0 };
    }
  } catch {
    // Missing or torn lock reads as not running.
  }
  return null;
}

export function readPort(): number {
  const lock = readLock();
  if (lock !== null) return lock.port;
  const fallback = Number(process.env['AGENTERM_PORT'] ?? '37241');
  return Number.isInteger(fallback) ? fallback : 37241;
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Daemon entry script: explicit env override, else the workspace runtime build. */
export function daemonEntry(): string | null {
  const override = process.env['AGENTERM_DAEMON_ENTRY'];
  if (typeof override === 'string' && override.length > 0) return override;
  try {
    const require = createRequire(import.meta.url);
    const pkg = require.resolve('@agenterm/runtime/package.json');
    const entry = path.join(path.dirname(pkg), 'dist', 'index.js');
    return fs.existsSync(entry) ? entry : null;
  } catch {
    return null;
  }
}

/** Start the daemon detached so it outlives this CLI invocation. */
export function startDaemonProcess(entry: string): void {
  const child = spawn(process.execPath, [entry], { detached: true, stdio: 'ignore', env: process.env });
  child.unref();
}

/** Last lines of the daemon log, oldest first. */
export function daemonLogTail(lines: number): string[] {
  try {
    const text = fs.readFileSync(path.join(dataDir(), 'daemon.log'), 'utf8');
    return text.trimEnd().split('\n').slice(-lines);
  } catch {
    return [];
  }
}
