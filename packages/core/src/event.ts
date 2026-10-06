import type { OverlaySource, SessionOrigin } from './session.js';

/** Base fields shared by every event on the bus and on the socket. */
export interface EventBase {
  /** Stable event identifier. UUID string. */
  id: string;
  /** Session this event belongs to. References SessionRecord.id. */
  sessionId: string;
  /** Creation time. Milliseconds since epoch. Integer, >= 0. */
  createdAtMs: number;
}

/** Session created. Fired by the daemon right after the row is written. */
export interface SessionCreatedEvent extends EventBase {
  kind: 'session.created';
  pid: number;
  origin: SessionOrigin;
  commandLine: string[];
  cwd: string;
}

/** Session exited. Fired once with PTY truth. Never overridden by overlay. */
export interface SessionExitedEvent extends EventBase {
  kind: 'session.exited';
  pid: number;
  exitCode: number | null;
  exitSignal: string | null;
}

/** Attach completed. Fired after explicit user approval naming the pid. */
export interface SessionAttachedEvent extends EventBase {
  kind: 'session.attached';
  pid: number;
  origin: SessionOrigin;
}

/** Detach completed. Attached sessions return to unmanaged state. */
export interface SessionDetachedEvent extends EventBase {
  kind: 'session.detached';
  pid: number;
}

/** Session row changed outside lifecycle, such as a rename. */
export interface SessionUpdatedEvent extends EventBase {
  kind: 'session.updated';
  title: string;
}

/** Running model spend for a session changed. Live only; GET /usage holds totals. */
export interface SessionUsageEvent extends EventBase {
  kind: 'session.usage';
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

/** Terminal output chunk with monotonic sequence numbers. */
export interface TerminalOutputEvent extends EventBase {
  kind: 'terminal.output';
  /** Monotonic sequence number per session. Integer, >= 0. Supports resume. */
  seq: number;
  /** UTF-8 text chunk. May contain escape sequences. Never empty. */
  data: string;
}

/**
 * Terminal input echo. Records bytes written to owned PTY stdin.
 * Delivered live to subscribers only; never persisted, since input can
 * carry typed passwords.
 */
export interface TerminalInputEvent extends EventBase {
  kind: 'terminal.input';
  /** Monotonic sequence number per session. Integer, >= 0. */
  seq: number;
  /** Bytes written. Never empty. */
  data: string;
}

/** Process started inside a session subtree. */
export interface ProcessStartedEvent extends EventBase {
  kind: 'process.started';
  pid: number;
  command: string;
}

/** Process exited inside a session subtree. */
export interface ProcessExitedEvent extends EventBase {
  kind: 'process.exited';
  pid: number;
  command: string;
  exitCode: number | null;
}

/** Best-effort agent status overlay change. Redacted before storage. */
export interface AgentStatusEvent extends EventBase {
  kind: 'agent.status';
  overlay: 'unknown' | 'working' | 'waiting_input' | 'waiting_permission' | 'completed' | 'failed';
  source: OverlaySource;
  /** Redacted summary text or null when no summary. */
  summary: string | null;
}

/** Port opened. Joined from listening sockets to owning pid. */
export interface PortOpenedEvent extends EventBase {
  kind: 'port.opened';
  port: number;
  pid: number;
}

/** Port closed. Fired when a previously open port disappears. */
export interface PortClosedEvent extends EventBase {
  kind: 'port.closed';
  port: number;
  pid: number;
}

/** Shared-cwd warning listing all involved session ids. */
export interface WorkspaceConflictEvent extends EventBase {
  kind: 'workspace.conflict';
  cwd: string;
  involvedSessionIds: string[];
}

/** File changed inside a watched session cwd. Debounced by the watcher. */
export interface FileChangedEvent extends EventBase {
  kind: 'file.changed';
  /** Workspace-relative path where resolvable, else the absolute path. */
  path: string;
  change: 'added' | 'modified' | 'deleted';
}

/**
 * Full event union.
 *
 * Ordered by createdAtMs then id for stable replay. Socket fan-out sends
 * each variant with the same JSON shape stored in SQLite and mirrored to
 * events.jsonl for tail and debug.
 */
export type AgentermEvent =
  | SessionCreatedEvent
  | SessionExitedEvent
  | SessionAttachedEvent
  | SessionDetachedEvent
  | SessionUpdatedEvent
  | SessionUsageEvent
  | TerminalOutputEvent
  | TerminalInputEvent
  | ProcessStartedEvent
  | ProcessExitedEvent
  | AgentStatusEvent
  | PortOpenedEvent
  | PortClosedEvent
  | WorkspaceConflictEvent
  | FileChangedEvent;

/** Stored event row backing the Activity views. Append-only. */
export interface EventRow {
  /** Stable event identifier. UUID string. */
  id: string;
  /** Session id. References SessionRecord.id. Indexed. */
  sessionId: string;
  /** Typed event name. Matches AgentermEvent kind. Indexed with time. */
  kind: AgentermEvent['kind'];
  /** JSON payload. Redacted before write. */
  payloadJson: string;
  /** Creation time. Milliseconds since epoch. Indexed. */
  createdAtMs: number;
}

/** Terminal byte events are streamed live but never stored or listed. */
export function isTerminalEventKind(kind: AgentermEvent['kind']): boolean {
  return kind === 'terminal.output' || kind === 'terminal.input';
}

/**
 * Events delivered live only: terminal bytes and high-frequency signals.
 * File edits can arrive by the thousand during a checkout or build, so they
 * stay out of SQLite; the daemon keeps a per-session summary for the Files view.
 */
export function isLiveOnlyEventKind(kind: AgentermEvent['kind']): boolean {
  return isTerminalEventKind(kind) || kind === 'session.usage' || kind === 'file.changed';
}
