import type { AgentProvider } from './agent.js';
import type { DiscoveredProcess, PortRecord, ProcessSnapshot } from './process.js';
import type {
  SessionLifecycleStatus,
  SessionOverlayStatus,
  SessionRecord,
} from './session.js';

/** Standard error envelope returned by every route on failure. */
export interface ErrorEnvelope {
  error: {
    /** Machine readable code. Example: missing_binary, unknown_pid. */
    code: string;
    /** Human readable detail. Redacted, no secrets. */
    message: string;
    /** Optional hint for recovery. Example: install hint. */
    hint?: string;
  };
}

/** GET /health response. Liveness plus daemon detail. */
export interface HealthResponse {
  ok: true;
  /** Production daemon version. Example: 0.1.0. No stage suffix. */
  version: string;
  /** Daemon uptime in seconds. Integer, >= 0. */
  uptimeSeconds: number;
  /** Daemon start time. Milliseconds since epoch. */
  startedAtMs: number;
  /** Listening port. Integer, 1-65535. */
  port: number;
}

/** GET /sessions query filters. All optional. */
export interface ListSessionsQuery {
  provider?: AgentProvider;
  lifecycle?: SessionLifecycleStatus;
  overlay?: SessionOverlayStatus;
  cwd?: string;
}

/** GET /sessions response. Ordered by startedAtMs descending. */
export interface ListSessionsResponse {
  sessions: SessionRecord[];
}

/** POST /sessions spawn body. Provider or custom command. */
export interface SpawnSessionRequest {
  /** Provider key. Generic allows any binary. */
  provider: AgentProvider;
  /** Binary override. When empty the provider default is used. */
  command?: string;
  /** Argument list. Defaults to empty. */
  args?: string[];
  /** Absolute working directory. Must exist. */
  cwd: string;
  /** Human title. When empty the daemon derives one from command and time. */
  title?: string;
  /** Terminal width. Integer, 1-500. Defaults to 80. */
  cols?: number;
  /** Terminal height. Integer, 1-200. Defaults to 24. */
  rows?: number;
  /** Environment overrides. Secrets-blocklist keys are rejected. */
  env?: Record<string, string>;
}

/** POST /sessions spawn response. */
export interface SpawnSessionResponse {
  session: SessionRecord;
}

/** POST /sessions/attach body. Adopt an existing OS pid. */
export interface AttachSessionRequest {
  /** Existing OS pid to adopt. Integer, > 0. */
  pid: number;
  /** Human title. When empty the daemon derives one from pid and command. */
  title?: string;
  /** Absolute cwd hint or null to use the discovered cwd. */
  cwd?: string | null;
}

/** POST /sessions/attach response. */
export interface AttachSessionResponse {
  session: SessionRecord;
}

/** Single discover candidate. */
export type DiscoverCandidate = DiscoveredProcess;

/** GET /discover response. Candidates only, no side effects. */
export interface DiscoverResponse {
  candidates: DiscoverCandidate[];
  /** Time of scan. Milliseconds since epoch. */
  scannedAtMs: number;
}

/** GET /sessions/:id response. Full detail. */
export interface SessionDetailResponse {
  session: SessionRecord;
  /** Child pid table. Skinny first, full snapshots in a later change. */
  processes: ProcessSnapshot[];
  /** Listening ports joined back to owning pids. */
  ports: PortRecord[];
  /** Branch name or null. */
  branch: string | null;
}

/** DELETE /sessions/:id body. Selects detach versus kill-tree. */
export interface DeleteSessionRequest {
  /**
   * True means kill the full process tree. False means detach only.
   * Attached sessions default to false and require explicit true naming
   * the pid to kill. Spawned sessions accept either value.
   */
  killTree: boolean;
}

/** DELETE /sessions/:id response. */
export interface DeleteSessionResponse {
  detached: boolean;
  killed: boolean;
  pid: number;
}

/** POST /sessions/:id/input body. Write bytes to owned PTY stdin. */
export interface SessionInputRequest {
  /** Bytes to write. Never empty. Max 1MB per call. */
  data: string;
}

/** POST /sessions/:id/input response. */
export interface SessionInputResponse {
  acceptedBytes: number;
}

/** POST /sessions/:id/resize body. Debounced UI calls. */
export interface SessionResizeRequest {
  /** Columns. Integer, 1-500. */
  cols: number;
  /** Rows. Integer, 1-200. */
  rows: number;
}

/** POST /sessions/:id/resize response. */
export interface SessionResizeResponse {
  cols: number;
  rows: number;
}

/** Signal name accepted by POST /sessions/:id/signal. */
export type SessionSignalName = 'interrupt' | 'terminate' | 'kill';

/** POST /sessions/:id/signal body. */
export interface SessionSignalRequest {
  signal: SessionSignalName;
}

/** POST /sessions/:id/signal response. */
export interface SessionSignalResponse {
  signaled: boolean;
  pid: number;
  signal: SessionSignalName;
}

/** GET /sessions/:id/output query. Paged scrollback with resume cursor. */
export interface SessionOutputQuery {
  /** Tail length in bytes. Integer, 1-1048576. Defaults to 65536. */
  tailBytes?: number;
  /** Resume cursor. Return chunks with seq greater than this value. */
  sinceSeq?: number;
  /** Max chunks to return. Integer, 1-1000. Defaults to 200. */
  limit?: number;
}

/** One output chunk. */
export interface SessionOutputChunk {
  seq: number;
  data: string;
  createdAtMs: number;
}

/** GET /sessions/:id/output response. */
export interface SessionOutputResponse {
  sessionId: string;
  chunks: SessionOutputChunk[];
  /** Highest seq returned or null when no chunks. Use as sinceSeq. */
  resumeAfterSeq: number | null;
  /** True when more chunks remain after this page. */
  hasMore: boolean;
}

/** GET /sessions/:id/processes response. */
export interface SessionProcessesResponse {
  sessionId: string;
  processes: ProcessSnapshot[];
  sampledAtMs: number;
}

/** GET /sessions/:id/ports response. */
export interface SessionPortsResponse {
  sessionId: string;
  ports: PortRecord[];
  sampledAtMs: number;
}

/** GET /sessions/:id/commands query. All fields optional. */
export interface SessionCommandsQuery {
  /** Max rows, newest first. Integer, 1-500. Defaults to 100. */
  limit?: number;
}

/** GET /sessions/:id/commands response. Newest first. */
export interface SessionCommandsResponse {
  sessionId: string;
  commands: import('./command.js').CommandRecord[];
}

/** Socket message sent from client to daemon on the event stream. */
export type ClientSocketMessage =
  | { kind: 'subscribe'; sessionId: string; sinceSeq?: number }
  | { kind: 'unsubscribe'; sessionId: string }
  | { kind: 'terminal.input'; sessionId: string; data: string };

/** Socket message sent from daemon to clients. */
export type ServerSocketMessage =
  | { kind: 'event'; event: import('./event.js').AgentermEvent }
  | { kind: 'hello'; version: string; serverTimeMs: number }
  | { kind: 'error'; code: string; message: string };
