import { WebSocketServer, type WebSocket } from 'ws';
import { parseSessionIdParam } from '@agenterm/core';
import type { AgentermEvent, ClientSocketMessage } from '@agenterm/core';
import { acquireLock } from './lock.js';
import { dataDir, DAEMON_VERSION } from './paths.js';
import { loadOrCreateToken } from './token.js';
import { createApp } from './server.js';
import { SessionStore } from './sessionStore.js';
import { PtyManager } from './ptyManager.js';
import { Supervisor } from './supervisor.js';
import { EventBus } from './events.js';
import { databaseFile, openDatabase, SqliteCommands, SqliteEvents, SqliteSessions } from './database.js';
import { HarnessWatch, harnessWatchEnabled } from './harnessWatch.js';

function authorized(header: string | undefined, token: string): boolean {
  if (typeof header !== 'string') return false;
  const parts = header.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') return false;
  return parts[1] === token;
}

function send(socket: WebSocket, payload: unknown): void {
  if (socket.readyState !== 1) return;
  if (socket.bufferedAmount > 1024 * 1024) return;
  try {
    socket.send(JSON.stringify(payload));
  } catch {
    // Slow or dead consumers fall back to since_seq re-fetch.
  }
}

/**
 * Daemon entry.
 *
 * Ensures the data dir, loads the token, acquires the single-flight lock,
 * then listens on 127.0.0.1 only with an attached WebSocket fan-out for
 * the event stream. A second starter exits as a client.
 */
async function main(): Promise<void> {
  const dir = dataDir();
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
  const { db } = openDatabase(databaseFile(dir));
  const sessionsTable = new SqliteSessions(db);
  const eventsTable = new SqliteEvents(db);
  const commandsTable = new SqliteCommands(db);
  try {
    eventsTable.prune();
  } catch {
    // Prune is best effort at startup.
  }
  try {
    commandsTable.prune();
  } catch {
    // Prune is best effort at startup.
  }
  const store = new SessionStore({ dataDir: dir, table: sessionsTable });
  const bus = new EventBus({ dataDir: dir, table: eventsTable });
  const pty = new PtyManager({ dataDir: dir });
  const supervisor = new Supervisor();
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
  const sockets = new Set<WebSocket>();
  const wss = new WebSocketServer({ server: app.server, path: '/events/stream' });
  wss.on('connection', (socket, request) => {
    const header = request.headers['authorization'];
    if (!authorized(typeof header === 'string' ? header : undefined, token)) {
      socket.close(4401, 'unauthorized');
      return;
    }
    sockets.add(socket);
    send(socket, { kind: 'hello', version: DAEMON_VERSION, serverTimeMs: Date.now() });
    socket.on('message', (raw) => {
      let message: ClientSocketMessage;
      try {
        message = JSON.parse(String(raw)) as ClientSocketMessage;
      } catch {
        send(socket, { kind: 'error', code: 'malformed', message: 'message must be JSON' });
        return;
      }
      if (message.kind === 'subscribe' && typeof message.sessionId === 'string') {
        const idParsed = parseSessionIdParam(message.sessionId);
        if (!idParsed.ok) {
          send(socket, { kind: 'error', code: idParsed.code, message: idParsed.message });
          return;
        }
        const managed = pty.get(idParsed.value);
        if (managed !== null && typeof message.sinceSeq === 'number') {
          const page = managed.log.read({ sinceSeq: message.sinceSeq, tailBytes: 65536, limit: 200 });
          for (const chunk of page.chunks) {
            const event: AgentermEvent = {
              id: '',
              sessionId: idParsed.value,
              createdAtMs: chunk.createdAtMs,
              kind: 'terminal.output',
              seq: chunk.seq,
              data: chunk.data
            };
            send(socket, { kind: 'event', event });
          }
        }
        return;
      }
      if (message.kind === 'terminal.input') {
        const idParsed = parseSessionIdParam(message.sessionId);
        if (!idParsed.ok) {
          send(socket, { kind: 'error', code: idParsed.code, message: idParsed.message });
          return;
        }
        try {
          pty.write(idParsed.value, message.data);
        } catch {
          send(socket, { kind: 'error', code: 'no_pty', message: 'session exposes no PTY for input' });
        }
        return;
      }
      if (message.kind === 'unsubscribe') {
        return;
      }
      send(socket, { kind: 'error', code: 'unknown_kind', message: 'message kind not recognized' });
    });
    socket.on('close', () => {
      sockets.delete(socket);
    });
  });
  bus.onEvent((event) => {
    for (const socket of sockets) {
      send(socket, { kind: 'event', event });
    }
  });
  supervisor.start();
  watch.start();
  const shutdown = async (): Promise<void> => {
    supervisor.stop();
    watch.stop();
    wss.close();
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  console.log(`agentermd listening on 127.0.0.1:${lock.port}`);
}

await main();
