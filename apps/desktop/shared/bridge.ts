import type { AgentermClient, AgentermEvent } from '@agenterm/core';

/**
 * Contract between Electron main, the preload, and the renderer.
 *
 * The renderer never sees the daemon token. It asks main to run one of a
 * fixed list of AgentermClient methods; main validates the method name
 * and the calling frame, runs the call, and returns a result envelope so
 * error codes and hints survive the IPC hop.
 */
export const API_METHODS = [
  'health',
  'discover',
  'listSessions',
  'attach',
  'sessionDetail',
  'spawn',
  'deleteSession',
  'updateSession',
  'restart',
  'sendInput',
  'resize',
  'signal',
  'output',
  'processes',
  'ports',
  'commands',
  'git',
  'gitDiff',
  'files',
  'events',
  'activity'
] as const;

export type ApiMethod = (typeof API_METHODS)[number];
export type ApiArgs<M extends ApiMethod> = Parameters<AgentermClient[M]>;
export type ApiResult<M extends ApiMethod> = Awaited<ReturnType<AgentermClient[M]>>;

export interface ApiFailure {
  status: number;
  code: string;
  message: string;
  hint?: string | undefined;
}

export type ApiEnvelope<T> = { ok: true; value: T } | { ok: false; error: ApiFailure };

export type ConnectionState = 'starting' | 'online' | 'offline' | 'stopped';

export interface ConnectionInfo {
  state: ConnectionState;
  /** Daemon version once online. */
  version: string | null;
  /** Why the daemon is offline, in user terms. */
  detail: string | null;
}

/** Output volume and last visible line per session over the last tick. */
export interface ActivityTick {
  atMs: number;
  sessions: Record<string, { bytes: number; lastLine: string | null }>;
}

/** App-level commands sent from menus, tray, and notifications. */
export type AppCommand =
  | { kind: 'new-session' }
  | { kind: 'palette' }
  | { kind: 'toggle-activity' }
  | { kind: 'home' }
  | { kind: 'focus-session'; sessionId: string }
  | { kind: 'cycle-session'; delta: 1 | -1 }
  | { kind: 'jump-session'; index: number };

export interface Preferences {
  notifications: boolean;
}

export interface AgentermBridge {
  platform: string;
  call<M extends ApiMethod>(method: M, ...args: ApiArgs<M>): Promise<ApiEnvelope<ApiResult<M>>>;
  /** Fast keystroke path over the daemon socket. */
  sendInput(sessionId: string, data: string): void;
  subscribeOutput(sessionId: string): void;
  unsubscribeOutput(sessionId: string): void;
  onEvent(handler: (event: AgentermEvent) => void): () => void;
  onActivity(handler: (tick: ActivityTick) => void): () => void;
  onConnection(handler: (info: ConnectionInfo) => void): () => void;
  onCommand(handler: (command: AppCommand) => void): () => void;
  connection(): Promise<ConnectionInfo>;
  startDaemon(): Promise<ConnectionInfo>;
  stopDaemon(): Promise<boolean>;
  pickDirectory(defaultPath?: string): Promise<string | null>;
  openExternal(url: string): Promise<void>;
  revealPath(path: string): Promise<void>;
  preferences(): Promise<Preferences>;
  setPreferences(patch: Partial<Preferences>): Promise<Preferences>;
}

export const IPC = {
  call: 'agenterm:call',
  input: 'agenterm:input',
  subscribe: 'agenterm:subscribe',
  unsubscribe: 'agenterm:unsubscribe',
  event: 'agenterm:event',
  activity: 'agenterm:activity',
  connection: 'agenterm:connection',
  getConnection: 'agenterm:get-connection',
  command: 'agenterm:command',
  startDaemon: 'agenterm:start-daemon',
  stopDaemon: 'agenterm:stop-daemon',
  pickDirectory: 'agenterm:pick-directory',
  openExternal: 'agenterm:open-external',
  revealPath: 'agenterm:reveal-path',
  preferences: 'agenterm:preferences',
  setPreferences: 'agenterm:set-preferences'
} as const;
