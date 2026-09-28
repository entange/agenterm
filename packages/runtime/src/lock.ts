import fs from 'node:fs';
import path from 'node:path';
import getPort from 'get-port';
import { DEFAULT_DAEMON_PORT, lockPath } from './paths.js';
import { tokenHash } from './token.js';

/** Lock file shape. Second starter becomes a client. */
export interface DaemonLock {
  pid: number;
  port: number;
  tokenHash: string;
  startedAtMs: number;
}

function readLockFile(file: string): DaemonLock | null {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw) as Partial<DaemonLock>;
    if (
      typeof parsed.pid === 'number' &&
      typeof parsed.port === 'number' &&
      typeof parsed.tokenHash === 'string' &&
      typeof parsed.startedAtMs === 'number'
    ) {
      return parsed as DaemonLock;
    }
    return null;
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Acquire the single-flight lock.
 *
 * When a live lock exists the caller must act as a client reading the port
 * from the lock file. When the pid is dead the stale lock is replaced.
 * Port conflicts fall back via get-port and the actual port is written back.
 */
export async function acquireLock(options: {
  dir?: string;
  token: string;
  desiredPort?: number;
}): Promise<{ lock: DaemonLock; isOwner: boolean }> {
  const file = lockPath(options.dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const existing = readLockFile(file);
  if (existing !== null && pidAlive(existing.pid)) {
    return { lock: existing, isOwner: false };
  }
  const desired = options.desiredPort ?? DEFAULT_DAEMON_PORT;
  const port = await getPort({ port: desired });
  const lock: DaemonLock = {
    pid: process.pid,
    port,
    tokenHash: tokenHash(options.token),
    startedAtMs: Date.now()
  };
  fs.writeFileSync(file, JSON.stringify(lock, null, 2));
  return { lock, isOwner: true };
}

/** Read the lock for clients. Null when the daemon has never started. */
export function readLock(dir?: string): DaemonLock | null {
  return readLockFile(lockPath(dir));
}
