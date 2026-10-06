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

/** A lock this young is trusted without a probe; the owner may not be listening yet. */
const STARTUP_GRACE_MS = 15_000;

/** True when something answers /health on the lock port. */
async function daemonAnswers(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * A lock is live when its pid exists and either it is still starting up
 * or its port answers /health. A recycled pid with a dead port is stale.
 */
async function lockIsLive(lock: DaemonLock): Promise<boolean> {
  if (!pidAlive(lock.pid)) return false;
  if (Date.now() - lock.startedAtMs < STARTUP_GRACE_MS) return true;
  return daemonAnswers(lock.port);
}

/**
 * Acquire the single-flight lock.
 *
 * When a live lock exists the caller must act as a client reading the port
 * from the lock file. Stale locks (dead pid, or a recycled pid whose port
 * no longer answers) are replaced. The file is created exclusively so two
 * simultaneous starters cannot both win. Port conflicts fall back via
 * get-port and the actual port is written into the lock.
 */
export async function acquireLock(options: {
  dir?: string;
  token: string;
  desiredPort?: number;
}): Promise<{ lock: DaemonLock; isOwner: boolean }> {
  const file = lockPath(options.dir);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const desired = options.desiredPort ?? DEFAULT_DAEMON_PORT;
  for (let attempt = 0; attempt < 3; attempt++) {
    const existing = readLockFile(file);
    if (existing !== null && (await lockIsLive(existing))) {
      return { lock: existing, isOwner: false };
    }
    if (existing !== null || fs.existsSync(file)) {
      // Remove the stale lock only if it is still the one judged stale.
      const again = readLockFile(file);
      if (
        again !== null &&
        existing !== null &&
        (again.pid !== existing.pid || again.startedAtMs !== existing.startedAtMs)
      )
        continue;
      fs.rmSync(file, { force: true });
    }
    const port = await getPort({ port: desired });
    const lock: DaemonLock = {
      pid: process.pid,
      port,
      tokenHash: tokenHash(options.token),
      startedAtMs: Date.now()
    };
    // Write the full lock beside the target, then hard-link it into place: the link
    // fails if another starter got there first, and readers never see a partial file.
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(lock, null, 2), { mode: 0o600 });
    try {
      fs.linkSync(temp, file);
      return { lock, isOwner: true };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // Another starter won the race; loop to read its lock.
    } finally {
      fs.rmSync(temp, { force: true });
    }
  }
  const winner = readLockFile(file);
  if (winner === null) throw new Error('could not acquire the daemon lock');
  return { lock: winner, isOwner: false };
}

/** Remove the lock when this process still owns it. Called on shutdown. */
export function releaseLock(dir?: string): void {
  const file = lockPath(dir);
  const current = readLockFile(file);
  if (current !== null && current.pid === process.pid) {
    fs.rmSync(file, { force: true });
  }
}

/** Read the lock for clients. Null when the daemon has never started. */
export function readLock(dir?: string): DaemonLock | null {
  return readLockFile(lockPath(dir));
}
