import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import { acquireLock, releaseLock } from './lock.js';
import { dataDir } from './paths.js';
import { loadOrCreateToken } from './token.js';
import { createApp } from './server.js';
import { SessionStore } from './sessionStore.js';
import { PtyManager } from './ptyManager.js';
import { Supervisor } from './supervisor.js';
import { EventBus } from './events.js';
import {
  databaseFile,
  openDatabase,
  PRIVATE_DIR_MODE,
  SqliteCommands,
  SqliteEvents,
  SqliteSessions
} from './database.js';
import { HarnessWatch, harnessWatchEnabled } from './harnessWatch.js';
import { EventStream } from './stream.js';

/** Retention pruning cadence while the daemon runs. */
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

/** Grace for shutdown before the process exits regardless. */
const SHUTDOWN_GRACE_MS = 4000;

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
 * shutdown ends owned sessions and releases the lock.
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
  const { raw, db } = openDatabase(databaseFile(dir));
  const sessionsTable = new SqliteSessions(db);
  const eventsTable = new SqliteEvents(db);
  const commandsTable = new SqliteCommands(db);
  const prune = (): void => {
    try {
      const removed = eventsTable.prune() + commandsTable.prune();
      if (removed > 0) log.info({ removed }, 'pruned rows past retention');
    } catch (error) {
      log.warn({ err: error }, 'prune failed');
    }
  };
  prune();
  const pruneTimer = setInterval(prune, PRUNE_INTERVAL_MS);
  pruneTimer.unref();

  const store = new SessionStore({ dataDir: dir, table: sessionsTable });
  const bus = new EventBus({ dataDir: dir, table: eventsTable });
  const pty = new PtyManager({ dataDir: dir });
  const supervisor = new Supervisor({
    onPorts: (sessionId, change) => {
      const now = Date.now();
      for (const port of change.opened) {
        bus.publish({ id: '', sessionId, createdAtMs: now, kind: 'port.opened', port: port.port, pid: port.pid });
      }
      for (const port of change.closed) {
        bus.publish({ id: '', sessionId, createdAtMs: now, kind: 'port.closed', port: port.port, pid: port.pid });
      }
    }
  });
  const watch = new HarnessWatch({ enabled: harnessWatchEnabled(), dataDir: dir, store, bus });
  const app = createApp({
    token,
    port: lock.port,
    startedAtMs: lock.startedAtMs,
    store,
    pty,
    supervisor,
    bus,
    watch,
    commandsDb: commandsTable,
    dataDir: dir
  });
  await app.listen({ host: '127.0.0.1', port: lock.port });
  const stream = new EventStream({ server: app.server, token, bus, pty });
  supervisor.start();
  watch.start();
  log.info({ port: lock.port, harnessWatch: watch.isEnabled() }, 'daemon listening');

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
    clearInterval(pruneTimer);
    supervisor.stop();
    watch.stop();
    stream.close();
    for (const session of store.list()) {
      const managed = pty.get(session.id);
      if (managed === null || managed.exit !== null) continue;
      store.markKilled(session.id);
      try {
        pty.kill(session.id, 'SIGHUP');
      } catch {
        // Already gone.
      }
      managed.log.close();
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
