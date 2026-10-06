import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { AgentermClient, daemonBaseUrl, lastVisibleLine, type AgentermEvent } from '@agenterm/core';
import WebSocket from 'ws';
import type { ActivityTick, ConnectionInfo } from '../../shared/bridge.js';

export function dataDir(): string {
  const override = process.env['AGENTERM_DATA_DIR'];
  return typeof override === 'string' && override.length > 0 ? override : path.join(os.homedir(), '.agenterm');
}

interface Lock {
  pid: number;
  port: number;
}

function readLock(): Lock | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dataDir(), 'agentermd.lock'), 'utf8')) as Partial<Lock>;
    return typeof parsed.pid === 'number' && typeof parsed.port === 'number' ? { pid: parsed.pid, port: parsed.port } : null;
  } catch {
    return null;
  }
}

function readToken(): string {
  try {
    return fs.readFileSync(path.join(dataDir(), 'token'), 'utf8').trim();
  } catch {
    return '';
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

function findOnPath(binary: string, envPath: string | undefined): string | null {
  for (const dir of (envPath ?? '').split(path.delimiter)) {
    if (dir.length === 0) continue;
    const candidate = path.join(dir, binary);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Keep looking.
    }
  }
  return null;
}

/**
 * Electron main's link to the daemon.
 *
 * Starts the daemon when it is not running (with the login-shell env so
 * agents resolve), tracks connection state, holds one event socket that
 * receives every session's output, and folds that output into per-second
 * activity ticks (bytes plus last visible line) for the heartbeat traces.
 * Terminal bytes themselves are forwarded only to windows that asked.
 */
export class DaemonLink {
  private info: ConnectionInfo = { state: 'starting', version: null, detail: null };
  private socket: WebSocket | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryDelayMs = 500;
  private userStopped = false;
  private readonly tails = new Map<string, string>();
  private readonly bytes = new Map<string, number>();
  private readonly dirtyLines = new Set<string>();
  private readonly tickTimer: ReturnType<typeof setInterval>;
  private readonly eventHandlers = new Set<(event: AgentermEvent) => void>();
  private readonly activityHandlers = new Set<(tick: ActivityTick) => void>();
  private readonly connectionHandlers = new Set<(info: ConnectionInfo) => void>();

  constructor(
    private readonly options: {
      loginEnv: Promise<Record<string, string>>;
      isPackaged: boolean;
      resourcesPath: string;
    }
  ) {
    this.tickTimer = setInterval(() => this.flushActivity(), 1000);
  }

  connection(): ConnectionInfo {
    return this.info;
  }

  onEvent(handler: (event: AgentermEvent) => void): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  onActivity(handler: (tick: ActivityTick) => void): () => void {
    this.activityHandlers.add(handler);
    return () => this.activityHandlers.delete(handler);
  }

  onConnection(handler: (info: ConnectionInfo) => void): () => void {
    this.connectionHandlers.add(handler);
    return () => this.connectionHandlers.delete(handler);
  }

  /** Fresh client per call so a restarted daemon (new port or token) is picked up. */
  client(): AgentermClient {
    const lock = readLock();
    return new AgentermClient({ baseUrl: daemonBaseUrl(lock?.port ?? 37241), token: readToken() });
  }

  private setInfo(next: ConnectionInfo): void {
    if (next.state === this.info.state && next.version === this.info.version && next.detail === this.info.detail) return;
    this.info = next;
    for (const handler of this.connectionHandlers) handler(next);
  }

  /** Daemon entry script and the runtime that should execute it. */
  private async launchSpec(): Promise<{ command: string; args: string[]; env: Record<string, string> } | null> {
    const env = await this.options.loginEnv;
    if (this.options.isPackaged) {
      const entry = path.join(this.options.resourcesPath, 'agentermd', 'index.js');
      if (!fs.existsSync(entry)) return null;
      // Packaged native modules are rebuilt for Electron's Node ABI.
      return { command: process.execPath, args: [entry], env: { ...env, ELECTRON_RUN_AS_NODE: '1' } };
    }
    let entry: string;
    try {
      const require = createRequire(import.meta.url);
      entry = path.join(path.dirname(require.resolve('@agenterm/runtime/package.json')), 'dist', 'index.js');
    } catch {
      return null;
    }
    if (!fs.existsSync(entry)) return null;
    // In development native modules match the system Node, not Electron.
    const node = findOnPath('node', env['PATH']);
    return node === null
      ? { command: process.execPath, args: [entry], env: { ...env, ELECTRON_RUN_AS_NODE: '1' } }
      : { command: node, args: [entry], env };
  }

  private async healthy(): Promise<string | null> {
    try {
      const health = await this.client().health();
      return health.version;
    } catch {
      return null;
    }
  }

  /** Make sure a daemon is running and connected. Starts one when needed. */
  async ensure(): Promise<ConnectionInfo> {
    this.userStopped = false;
    if (this.socket !== null && this.info.state === 'online') return this.info;
    const lock = readLock();
    let version = lock !== null && pidAlive(lock.pid) ? await this.healthy() : null;
    if (version === null) {
      this.setInfo({ state: 'starting', version: null, detail: 'Starting the agenterm daemon…' });
      const spec = await this.launchSpec();
      if (spec === null) {
        this.setInfo({
          state: 'offline',
          version: null,
          detail: 'The daemon build was not found. Run `bun run build` in the agenterm repo, then start it again.'
        });
        return this.info;
      }
      const child = spawn(spec.command, spec.args, { detached: true, stdio: 'ignore', env: spec.env });
      child.unref();
      for (let i = 0; i < 80 && version === null; i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        if (readLock() !== null) version = await this.healthy();
      }
      if (version === null) {
        this.setInfo({
          state: 'offline',
          version: null,
          detail: `The daemon did not answer. Check ${path.join(dataDir(), 'daemon.log')}.`
        });
        this.scheduleRetry();
        return this.info;
      }
    }
    this.openSocket(version);
    return this.info;
  }

  /** Stop the daemon on explicit user request. Ends every spawned session. */
  async stop(): Promise<boolean> {
    const lock = readLock();
    this.userStopped = true;
    this.closeSocket();
    if (lock === null || !pidAlive(lock.pid)) {
      this.setInfo({ state: 'stopped', version: null, detail: 'The daemon is stopped.' });
      return false;
    }
    process.kill(lock.pid, 'SIGTERM');
    for (let i = 0; i < 50 && pidAlive(lock.pid); i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    this.setInfo({ state: 'stopped', version: null, detail: 'The daemon is stopped. Agents it started have ended.' });
    return true;
  }

  sendInput(sessionId: string, data: string): void {
    if (this.socket !== null && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ kind: 'terminal.input', sessionId, data }));
      return;
    }
    void this.client()
      .sendInput(sessionId, { data })
      .catch(() => undefined);
  }

  private openSocket(version: string): void {
    this.closeSocket();
    const lock = readLock();
    if (lock === null) {
      this.scheduleRetry();
      return;
    }
    const socket = new WebSocket(`ws://127.0.0.1:${lock.port}/events/stream`, {
      headers: { Authorization: `Bearer ${readToken()}` }
    });
    this.socket = socket;
    socket.on('open', () => {
      this.retryDelayMs = 500;
      socket.send(JSON.stringify({ kind: 'subscribe', sessionId: '*' }));
      this.setInfo({ state: 'online', version, detail: null });
    });
    socket.on('message', (raw) => {
      let parsed: { kind?: string; event?: AgentermEvent };
      try {
        parsed = JSON.parse(String(raw)) as typeof parsed;
      } catch {
        return;
      }
      if (parsed.kind !== 'event' || parsed.event === undefined) return;
      const event = parsed.event;
      if (event.kind === 'terminal.output') this.trackOutput(event.sessionId, event.data);
      for (const handler of this.eventHandlers) handler(event);
    });
    socket.on('error', () => undefined);
    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (this.userStopped) return;
      this.setInfo({ state: 'offline', version: null, detail: 'Lost the connection to the daemon. Reconnecting…' });
      this.scheduleRetry();
    });
  }

  private closeSocket(): void {
    const socket = this.socket;
    this.socket = null;
    socket?.terminate();
  }

  private scheduleRetry(): void {
    if (this.retryTimer !== null || this.userStopped) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.ensure();
    }, this.retryDelayMs);
    this.retryDelayMs = Math.min(this.retryDelayMs * 2, 5000);
  }

  private trackOutput(sessionId: string, data: string): void {
    this.bytes.set(sessionId, (this.bytes.get(sessionId) ?? 0) + data.length);
    this.tails.set(sessionId, ((this.tails.get(sessionId) ?? '') + data).slice(-4096));
    this.dirtyLines.add(sessionId);
  }

  private flushActivity(): void {
    if (this.bytes.size === 0 && this.dirtyLines.size === 0) return;
    const tick: ActivityTick = { atMs: Date.now(), sessions: {} };
    for (const sessionId of new Set([...this.bytes.keys(), ...this.dirtyLines])) {
      tick.sessions[sessionId] = {
        bytes: this.bytes.get(sessionId) ?? 0,
        lastLine: lastVisibleLine(this.tails.get(sessionId) ?? '')
      };
    }
    this.bytes.clear();
    this.dirtyLines.clear();
    for (const handler of this.activityHandlers) handler(tick);
  }

  /** Forget per-session buffers once a session is closed. */
  forget(sessionId: string): void {
    this.tails.delete(sessionId);
    this.bytes.delete(sessionId);
  }

  dispose(): void {
    clearInterval(this.tickTimer);
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.userStopped = true;
    this.closeSocket();
  }
}
