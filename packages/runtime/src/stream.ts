import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { parseSessionIdParam } from '@agenterm/core';
import type { AgentermEvent } from '@agenterm/core';
import { checkBearer } from './auth.js';
import type { EventBus } from './events.js';
import { DAEMON_VERSION } from './paths.js';
import type { PtyManager } from './ptyManager.js';

/** Path of the event stream on the daemon port. */
export const STREAM_PATH = '/events/stream';

/** Inbound frame cap. Input frames carry keystrokes, never bulk data. */
const MAX_PAYLOAD_BYTES = 1024 * 1024;

/** Outbound backlog past which a slow consumer drops frames and re-fetches. */
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

/** Wildcard subscription that receives terminal bytes for every session. */
export const ALL_SESSIONS = '*';

interface Client {
  socket: WebSocket;
  /** Session ids whose terminal bytes this client wants, or the wildcard. */
  outputs: Set<string>;
}

function isTerminalEvent(event: AgentermEvent): boolean {
  return event.kind === 'terminal.output' || event.kind === 'terminal.input';
}

function send(socket: WebSocket, payload: unknown): void {
  if (socket.readyState !== 1) return;
  if (socket.bufferedAmount > MAX_BUFFERED_BYTES) return;
  try {
    socket.send(JSON.stringify(payload));
  } catch {
    // Slow or dead consumers fall back to sinceSeq re-fetch.
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Authenticated WebSocket fan-out for the event stream.
 *
 * The bearer token is checked before the upgrade completes so rejected
 * peers never get a socket. Lifecycle, port, status, and file events go
 * to every client; terminal bytes only go to clients that subscribed to
 * that session (or to the wildcard), which keeps N busy agents from
 * flooding every window. Malformed frames get an error reply and never
 * throw out of the listener.
 */
export class EventStream {
  private readonly wss: WebSocketServer;
  private readonly clients = new Set<Client>();
  private readonly detach: () => void;
  private readonly onUpgrade: (request: IncomingMessage, socket: Duplex, head: Buffer) => void;

  constructor(
    private readonly options: {
      server: Server;
      token: string;
      bus: EventBus;
      pty: PtyManager;
      onInput?: ((sessionId: string, data: string) => void) | undefined;
    }
  ) {
    this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });
    this.onUpgrade = (request, socket, head) => {
      const url = request.url ?? '';
      const pathname = url.split('?')[0];
      if (pathname !== STREAM_PATH) {
        socket.destroy();
        return;
      }
      const header = request.headers['authorization'];
      if (!checkBearer(typeof header === 'string' ? header : undefined, options.token)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(request, socket, head, (ws) => this.accept(ws));
    };
    options.server.on('upgrade', this.onUpgrade);
    this.detach = options.bus.onEvent((event) => this.broadcast(event));
  }

  /** Connected client count. Used by tests and health detail. */
  size(): number {
    return this.clients.size;
  }

  private accept(socket: WebSocket): void {
    const client: Client = { socket, outputs: new Set() };
    this.clients.add(client);
    socket.on('error', () => undefined);
    socket.on('close', () => {
      this.clients.delete(client);
    });
    socket.on('message', (raw) => {
      try {
        this.handle(client, String(raw));
      } catch {
        send(socket, { kind: 'error', code: 'internal', message: 'message could not be handled' });
      }
    });
    send(socket, { kind: 'hello', version: DAEMON_VERSION, serverTimeMs: Date.now() });
  }

  private handle(client: Client, raw: string): void {
    const { socket } = client;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      send(socket, { kind: 'error', code: 'malformed', message: 'message must be JSON' });
      return;
    }
    const message = asRecord(parsed);
    if (message === null || typeof message['kind'] !== 'string') {
      send(socket, { kind: 'error', code: 'malformed', message: 'message must be an object with a kind' });
      return;
    }
    const kind = message['kind'];
    if (kind === 'subscribe' || kind === 'unsubscribe') {
      const target = message['sessionId'];
      if (target === ALL_SESSIONS) {
        if (kind === 'subscribe') client.outputs.add(ALL_SESSIONS);
        else client.outputs.clear();
        return;
      }
      const idParsed = parseSessionIdParam(target);
      if (!idParsed.ok) {
        send(socket, { kind: 'error', code: idParsed.code, message: idParsed.message });
        return;
      }
      if (kind === 'unsubscribe') {
        client.outputs.delete(idParsed.value);
        return;
      }
      client.outputs.add(idParsed.value);
      const sinceSeq = message['sinceSeq'];
      if (typeof sinceSeq === 'number' && Number.isInteger(sinceSeq) && sinceSeq >= 0) {
        this.replay(socket, idParsed.value, sinceSeq);
      }
      return;
    }
    if (kind === 'terminal.input') {
      const idParsed = parseSessionIdParam(message['sessionId']);
      if (!idParsed.ok) {
        send(socket, { kind: 'error', code: idParsed.code, message: idParsed.message });
        return;
      }
      const data = message['data'];
      if (typeof data !== 'string' || data.length === 0) {
        send(socket, { kind: 'error', code: 'invalid_data', message: 'data must be a non-empty string' });
        return;
      }
      const managed = this.options.pty.get(idParsed.value);
      if (managed === null || managed.exit !== null) {
        send(socket, { kind: 'error', code: 'no_pty', message: 'session exposes no live PTY for input' });
        return;
      }
      try {
        this.options.pty.write(idParsed.value, data);
        this.options.onInput?.(idParsed.value, data);
      } catch {
        send(socket, { kind: 'error', code: 'no_pty', message: 'session exposes no live PTY for input' });
      }
      return;
    }
    send(socket, { kind: 'error', code: 'unknown_kind', message: 'message kind not recognized' });
  }

  /** Send every retained chunk after the cursor, paging through the ring. */
  private replay(socket: WebSocket, sessionId: string, sinceSeq: number): void {
    const managed = this.options.pty.get(sessionId);
    if (managed === null) return;
    let cursor = sinceSeq;
    for (;;) {
      const page = managed.log.read({ sinceSeq: cursor, limit: 500 });
      for (const chunk of page.chunks) {
        const event: AgentermEvent = {
          id: '',
          sessionId,
          createdAtMs: chunk.createdAtMs,
          kind: 'terminal.output',
          seq: chunk.seq,
          data: chunk.data
        };
        send(socket, { kind: 'event', event });
      }
      if (!page.hasMore || page.resumeAfterSeq === null) return;
      cursor = page.resumeAfterSeq;
    }
  }

  private broadcast(event: AgentermEvent): void {
    const scoped = isTerminalEvent(event);
    for (const client of this.clients) {
      if (scoped && !client.outputs.has(ALL_SESSIONS) && !client.outputs.has(event.sessionId)) continue;
      send(client.socket, { kind: 'event', event });
    }
  }

  /** Terminate every client so the HTTP server can close promptly. */
  close(): void {
    this.detach();
    this.options.server.off('upgrade', this.onUpgrade);
    for (const client of this.clients) {
      client.socket.terminate();
    }
    this.clients.clear();
    this.wss.close();
  }
}
