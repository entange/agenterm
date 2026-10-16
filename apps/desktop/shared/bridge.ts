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
  'listTasks',
  'getTask',
  'run',
  'stop',
  'remove',
  'clearEnded',
  'sendInput',
  'resize',
  'output',
  'activity',
  'settings',
  'updateSettings',
  'listProcesses',
  'stopProcess'
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

/** `outdated`: an older daemon answers but is busy, so it waits for the user to restart it. */
export type ConnectionState = 'starting' | 'online' | 'offline' | 'stopped' | 'outdated';

export interface ConnectionInfo {
  state: ConnectionState;
  /** Daemon version once online. */
  version: string | null;
  /** Why the daemon is offline, in user terms. */
  detail: string | null;
}

/** Output volume and last visible line per task over the last tick. */
export interface ActivityTick {
  atMs: number;
  tasks: Record<string, { bytes: number; lastLine: string | null }>;
}

/** App-level commands sent from menus, tray, and notifications. */
export type AppCommand =
  | { kind: 'palette' }
  | { kind: 'settings' }
  | { kind: 'focus-task'; taskId: string }
  | { kind: 'cycle-task'; delta: 1 | -1 }
  | { kind: 'jump-task'; index: number }
  /** Show the Outside view, with this command picked. */
  | { kind: 'show-outside'; pid: number | null };

export interface Preferences {
  /** Notify when a task fails. */
  notifications: boolean;
  /** Notify when a command is left running after its terminal or agent exits. */
  orphanNotifications: boolean;
  /** Main has offered once to add the agenterm command. */
  commandOffered?: boolean;
}

/**
 * The agenterm command in terminals. installed: /usr/local/bin/agenterm runs
 * this app's copy. other: `agenterm` runs another install (npm) at `path`.
 * missing: no `agenterm` on the PATH. unavailable: this build has no copy to
 * offer (development, or not macOS).
 */
export interface CliStatus {
  state: 'installed' | 'other' | 'missing' | 'unavailable';
  path: string | null;
}

export interface AgentermBridge {
  platform: string;
  call<M extends ApiMethod>(method: M, ...args: ApiArgs<M>): Promise<ApiEnvelope<ApiResult<M>>>;
  /** Fast keystroke path over the daemon socket. */
  sendInput(taskId: string, data: string): void;
  subscribeOutput(taskId: string): void;
  unsubscribeOutput(taskId: string): void;
  onEvent(handler: (event: AgentermEvent) => void): () => void;
  onActivity(handler: (tick: ActivityTick) => void): () => void;
  onConnection(handler: (info: ConnectionInfo) => void): () => void;
  onCommand(handler: (command: AppCommand) => void): () => void;
  connection(): Promise<ConnectionInfo>;
  /** Start the daemon, or restart an outdated one. */
  startDaemon(): Promise<ConnectionInfo>;
  stopDaemon(): Promise<boolean>;
  openExternal(url: string): Promise<void>;
  revealPath(path: string): Promise<void>;
  preferences(): Promise<Preferences>;
  setPreferences(patch: Partial<Preferences>): Promise<Preferences>;
  cliStatus(): Promise<CliStatus>;
  /** Link /usr/local/bin/agenterm to the app's copy; macOS may ask for a password. */
  installCli(): Promise<CliStatus>;
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
  openExternal: 'agenterm:open-external',
  revealPath: 'agenterm:reveal-path',
  preferences: 'agenterm:preferences',
  setPreferences: 'agenterm:set-preferences',
  cliStatus: 'agenterm:cli-status',
  installCli: 'agenterm:install-cli'
} as const;
