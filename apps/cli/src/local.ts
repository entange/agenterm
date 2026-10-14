import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

/** Daemon entry script: an explicit override, else the daemon bundled next to this CLI. */
export function daemonEntry(): string | null {
  const override = process.env['AGENTERM_DAEMON_ENTRY'];
  if (typeof override === 'string' && override.length > 0) return override;
  const bundled = fileURLToPath(new URL('./daemon.js', import.meta.url));
  return fs.existsSync(bundled) ? bundled : null;
}

/**
 * Whether node-pty, which runs every terminal, has its native addon. It ships
 * prebuilt for macOS but compiles at install time on Linux, and npm 12 skips
 * that step unless the install allows node-pty's scripts. Without it the
 * daemon cannot start. A node-pty that cannot be found at all (a bundled or
 * overridden daemon) counts as present: that daemon brings its own.
 */
export function ptyAddonMissing(): boolean {
  let root: string;
  try {
    root = path.dirname(createRequire(import.meta.url).resolve('node-pty/package.json'));
  } catch {
    return false;
  }
  return ![
    path.join(root, 'prebuilds', `${process.platform}-${process.arch}`, 'pty.node'),
    path.join(root, 'build', 'Release', 'pty.node')
  ].some((addon) => fs.existsSync(addon));
}

/**
 * Wrap a launch so the daemon gets a high open-file limit. Each terminal
 * holds several descriptors, and macOS hands GUI-launched processes a soft
 * limit of 256, which would cap agenterm at well under a hundred terminals.
 */
export function withFileLimit(command: string, args: string[]): { command: string; args: string[] } {
  if (process.platform === 'win32') return { command, args };
  return {
    command: '/bin/sh',
    args: ['-c', 'ulimit -n 65536 2>/dev/null || ulimit -n 10240 2>/dev/null; exec "$0" "$@"', command, ...args]
  };
}

/** Start the daemon detached so it outlives this CLI invocation. */
export function startDaemonProcess(entry: string): void {
  const launch = withFileLimit(process.execPath, [entry]);
  const child = spawn(launch.command, launch.args, { detached: true, stdio: 'ignore', env: process.env });
  child.unref();
}

/** Last lines of the daemon log, oldest first. */
export function daemonLogTail(lines: number): string[] {
  try {
    // Read only the end of the file; the log is never rotated and can be large.
    const file = path.join(dataDir(), 'daemon.log');
    const fd = fs.openSync(file, 'r');
    let text: string;
    try {
      const size = fs.fstatSync(fd).size;
      const length = Math.min(size, Math.max(64 * 1024, lines * 1024));
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, size - length);
      text = buffer.toString('utf8');
      if (length < size) text = text.slice(text.indexOf('\n') + 1);
    } finally {
      fs.closeSync(fd);
    }
    return text
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .slice(-lines);
  } catch {
    return [];
  }
}
