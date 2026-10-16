import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import { acquireLock, releaseLock } from './lock.js';
import { dataDir } from './paths.js';
import { loadOrCreateToken } from './token.js';
import { createApp } from './server.js';
import { PtyManager } from './ptyManager.js';
import { Supervisor } from './supervisor.js';
import { EventBus } from './events.js';
import { databaseFile, openDatabase, PRIVATE_DIR_MODE, TaskTable } from './database.js';
import { EventStream } from './stream.js';
import { TaskStore } from './taskStore.js';
import { isRunning } from '@agenterm/core';

/** Grace for shutdown before the process exits regardless. */
const SHUTDOWN_GRACE_MS = 4000;

/** Soft open-file limit this process inherited, or null when unknown. */
function fileLimit(): number | null {
  if (process.platform === 'win32') return null;
  try {
    const value = Number(execFileSync('/bin/sh', ['-c', 'ulimit -n'], { encoding: 'utf8' }).trim());
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

/** Daemon log file inside the data dir. */
export function daemonLogPath(dir: string): string {
  return path.join(dir, 'daemon.log');
}

/**
 * Daemon entry.
 *
 * Ensures the data dir, loads the token, acquires the single-flight lock,
 * then listens on 127.0.0.1 only with an authenticated WebSocket fan-out
 * for the event stream. A second starter exits as a client. The daemon
 * owns every PTY, so stray exceptions are logged rather than fatal, and
 * shutdown ends running tasks and releases the lock.
 */
async function main(): Promise<void> {
  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  try {
    fs.chmodSync(dir, PRIVATE_DIR_MODE);
  } catch {
    // Non-POSIX filesystems ignore modes.
  }
  const log = pino(
    { base: { pid: process.pid }, timestamp: pino.stdTimeFunctions.isoTime },
    pino.destination({ dest: daemonLogPath(dir), mkdir: true, sync: false })
  );
  process.on('uncaughtException', (error) => {
    log.error({ err: error }, 'uncaught exception');
  });
  process.on('unhandledRejection', (reason) => {
    log.error({ err: reason }, 'unhandled rejection');
  });

  const token = loadOrCreateToken(dir);
  const desiredPort = Number(process.env['AGENTERM_PORT'] ?? '37241');
  const { lock, isOwner } = await acquireLock({
    dir,
    token,
    desiredPort: Number.isInteger(desiredPort) ? desiredPort : 37241
  });
  if (!isOwner) {
    console.log(`daemon already running on port ${lock.port} (pid ${lock.pid})`);
    return;
  }
  const raw = openDatabase(databaseFile(dir));
  const table = new TaskTable(raw);
  // Terminals died with the previous daemon.
  table.markLost(Date.now());
  // Session-era output from older builds.
  fs.rmSync(path.join(dir, 'sessions'), { recursive: true, force: true });

  const store = new TaskStore(table);
  const bus = new EventBus();
  const pty = new PtyManager({ dataDir: dir });
  const supervisor = new Supervisor({
    onPorts: (taskId) => {
      const task = store.get(taskId);
      if (task !== null && isRunning(task)) {
        bus.publish({ kind: 'task.updated', taskId, task: { ...task, ports: supervisor.portsFor(taskId) } });
      }
    }
  });
  const app = createApp({
    token,
    port: lock.port,
    startedAtMs: lock.startedAtMs,
    store,
    pty,
    supervisor,
    bus,
    dataDir: dir
  });
  await app.listen({ host: '127.0.0.1', port: lock.port });
  const stream = new EventStream({
    server: app.server,
    token,
    bus,
    pty,
    activity: app.agenterm.activity
  });
  supervisor.start();
  log.info({ port: lock.port, fileLimit: fileLimit() }, 'daemon listening');
  const limit = fileLimit();
  if (limit !== null && limit < 4096) {
    log.warn({ fileLimit: limit }, 'open-file limit is low; each terminal uses several descriptors');
  }

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) {
      process.exit(1);
    }
    stopping = true;
    log.info({ signal }, 'shutting down');
    const force = setTimeout(() => {
      releaseLock(dir);
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    force.unref();
    supervisor.stop();
    stream.close();
    for (const task of store.list()) {
      const managed = pty.get(task.id);
      if (managed === null || managed.exit !== null) continue;
      store.put({ ...task, status: 'stopped', endedAtMs: Date.now() });
      try {
        pty.kill(task.id, 'SIGHUP');
      } catch {
        // Already gone.
      }
      void managed.log.close();
    }
    try {
      await app.close();
    } catch (error) {
      log.warn({ err: error }, 'http close failed');
    }
    try {
      raw.close();
    } catch {
      // Closing twice or mid-write is fine at exit.
    }
    releaseLock(dir);
    log.flush();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGHUP', () => void shutdown('SIGHUP'));
  console.log(`agentermd listening on 127.0.0.1:${lock.port}`);
}

await main();
