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

/**
 * GET /health response. Liveness for anyone on localhost; the detail
 * fields are only present when the request carries the bearer token.
 */
export interface HealthResponse {
  ok: true;
  /** Production daemon version. Example: 0.1.0. No stage suffix. */
  version: string;
  /** Daemon uptime in seconds. Integer, >= 0. Authenticated only. */
  uptimeSeconds?: number;
  /** Daemon start time. Milliseconds since epoch. Authenticated only. */
  startedAtMs?: number;
  /** Listening port. Integer, 1-65535. Authenticated only. */
  port?: number;
  /** Daemon process id. Authenticated only. */
  pid?: number;
  /** Sessions with a live leader. Authenticated only. */
  liveSessions?: number;
  /** True when the harness overlay watcher is enabled. Authenticated only. */
  harnessWatch?: boolean;
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
   * True ends the full process tree of a live session and keeps the row
   * as history. False closes the row: attached sessions detach (the OS
   * process is untouched) and ended sessions are removed. Closing a live
   * spawned session is refused; kill it first.
   */
  killTree: boolean;
  /**
   * Required when killing an attached session. Must equal the session
   * pid so the approval names exactly the process being ended.
   */
  confirmPid?: number;
}

/** DELETE /sessions/:id response. */
export interface DeleteSessionResponse {
  /** True when the row was removed from the session list. */
  detached: boolean;
  /** True when a live process tree was signaled. */
  killed: boolean;
  pid: number;
}

/** PATCH /sessions/:id body. Only the title is editable. */
export interface UpdateSessionRequest {
  /** New human title. 1-200 chars after trim. */
  title: string;
}

/** PATCH /sessions/:id and POST /sessions/:id/restart response. */
export interface UpdateSessionResponse {
  session: SessionRecord;
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
  /** Required for terminate or kill on attached sessions. Must equal the pid. */
  confirmPid?: number;
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
  /** True when more chunks remain after this page. Loop with resumeAfterSeq. */
  hasMore: boolean;
  /** Oldest seq still retained, or null when empty. Older output was evicted. */
  firstSeq: number | null;
  /** False when served from the on-disk log because no live PTY remains. */
  live: boolean;
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

/** GET /events query. Newest first. Terminal bytes are never stored. */
export interface EventsQuery {
  /** Only events for this session. */
  sessionId?: string;
  /** Only events created strictly before this time, for paging back. */
  beforeMs?: number;
  /** Max rows. Integer, 1-500. Defaults to 100. */
  limit?: number;
}

/** GET /events response. Newest first. */
export interface EventsResponse {
  events: import('./event.js').AgentermEvent[];
}

/** One changed path in a git working tree. Letters follow git porcelain. */
export interface GitFileState {
  /** Path relative to the worktree root. */
  path: string;
  /** Index state (modified, added, deleted, renamed, ...) or null. */
  staged: string | null;
  /** Worktree state (modified, deleted, untracked, ...) or null. */
  unstaged: string | null;
}

/** GET /sessions/:id/git response. Nulls and zeros outside a repo. */
export interface GitStatusResponse {
  sessionId: string;
  branch: string | null;
  worktreeRoot: string | null;
  isDirty: boolean;
  stagedCount: number;
  unstagedCount: number;
  /** Changed files, capped at 200. */
  files: GitFileState[];
  /** Lines added versus HEAD across staged and unstaged edits. */
  insertions: number;
  /** Lines removed versus HEAD across staged and unstaged edits. */
  deletions: number;
  sampledAtMs: number;
}

/** GET /sessions/:id/git/diff response for one path. */
export interface GitDiffResponse {
  sessionId: string;
  path: string;
  /** Unified diff text versus HEAD. Untracked files diff against empty. */
  diff: string;
  /** True when the diff was cut at the size cap. */
  truncated: boolean;
}

/** One recent file change seen by the watcher. */
export interface FileChangeRecord {
  /** Path relative to the session cwd. */
  path: string;
  change: 'added' | 'modified' | 'deleted';
  /** Time of the latest change to this path. */
  atMs: number;
  /** Changes to this path since the watcher started. */
  count: number;
}

/** GET /sessions/:id/files response. Latest change per path, newest first. */
export interface FileChangesResponse {
  sessionId: string;
  /** False when the cwd is not watched (not a repo, or home or root dir). */
  watching: boolean;
  changes: FileChangeRecord[];
}

/** Socket message sent from client to daemon on the event stream. */
/**
 * Lifecycle, status, port, and file events reach every client. Terminal
 * bytes only reach clients subscribed to that session id or to '*'.
 */
export type ClientSocketMessage =
  | { kind: 'subscribe'; sessionId: string; sinceSeq?: number }
  | { kind: 'unsubscribe'; sessionId: string }
  | { kind: 'terminal.input'; sessionId: string; data: string };

/** Socket message sent from daemon to clients. */
export type ServerSocketMessage =
  | { kind: 'event'; event: import('./event.js').AgentermEvent }
  | { kind: 'hello'; version: string; serverTimeMs: number }
  | { kind: 'error'; code: string; message: string };
