import type { TaskRecord } from './task.js';

/** Error envelope returned by every route on failure. */
export interface ErrorEnvelope {
  error: {
    /** Machine readable code. Example: unknown_task, invalid_cwd. */
    code: string;
    /** Human readable detail. Redacted, no secrets. */
    message: string;
    /** Optional hint for recovery. */
    hint?: string;
  };
}

/**
 * GET /health. Liveness for anyone on localhost; the detail fields are
 * only present when the request carries the bearer token.
 */
export interface HealthResponse {
  ok: true;
  version: string;
  uptimeSeconds?: number;
  startedAtMs?: number;
  port?: number;
  pid?: number;
  /** Tasks currently running. */
  running?: number;
}

/** GET /tasks. Running first, then newest first. */
export interface ListTasksResponse {
  tasks: TaskRecord[];
}

/** POST /tasks. Start a command, or return the one already running. */
export interface RunTaskRequest {
  /** Shell command line, run with the caller's shell. */
  command: string;
  /** Absolute working directory. Must exist. */
  cwd: string;
  /**
   * Id to give the task. A running task with this id is returned instead
   * of starting a second one; an ended one is replaced.
   */
  id?: string;
  /** Human title. Defaults to the command. */
  title?: string;
  /** Who is starting it. The CLI and MCP server detect this. */
  startedBy?: string;
  startedByPid?: number;
  /**
   * The caller's environment. Used as the command's environment so it
   * sees the same PATH and variables. Kept in memory only.
   */
  env?: Record<string, string>;
  /** Replace a running task with the same id (or command and folder) instead of returning it. */
  restart?: boolean;
  cols?: number;
  rows?: number;
}

export interface RunTaskResponse {
  task: TaskRecord;
  /** True when an identical task was already running and was returned as is. */
  alreadyRunning: boolean;
}

/** GET /tasks/:id, POST /tasks/:id/stop. */
export interface TaskResponse {
  task: TaskRecord;
}

/** POST /tasks/:id/stop. */
export interface StopTaskRequest {
  /**
   * False (default): Ctrl+C, then terminate the whole process tree if it
   * is still running a few seconds later. True: kill the tree right away.
   */
  force?: boolean;
}

/** DELETE /tasks/:id. A running task is stopped first. */
export interface RemoveTaskResponse {
  removed: true;
  /** True when it was still running and had to be stopped. */
  stopped: boolean;
}

/** POST /tasks/clear. Removes every task that is no longer running. */
export interface ClearTasksResponse {
  removed: string[];
}

/** POST /tasks/:id/input. */
export interface TaskInputRequest {
  /** Bytes to type. Never empty. Max 1MB. */
  data: string;
}

export interface TaskInputResponse {
  acceptedBytes: number;
}

/** POST /tasks/:id/resize. */
export interface TaskResizeRequest {
  cols: number;
  rows: number;
}

/** GET /tasks/:id/output query. */
export interface TaskOutputQuery {
  /** Tail length in bytes when sinceSeq is absent. 1-1048576, default 65536. */
  tailBytes?: number;
  /** Return chunks after this sequence number. */
  sinceSeq?: number;
  /** Max chunks. 1-1000, default 200. */
  limit?: number;
}

export interface TaskOutputChunk {
  seq: number;
  data: string;
  createdAtMs: number;
}

/** GET /tasks/:id/output. */
export interface TaskOutputResponse {
  taskId: string;
  chunks: TaskOutputChunk[];
  /** Highest seq returned, or null. Pass as sinceSeq to continue. */
  resumeAfterSeq: number | null;
  /** True when more chunks remain after this page. */
  hasMore: boolean;
  /** Oldest seq still kept, or null when empty. */
  firstSeq: number | null;
  /** False once the task has ended. */
  live: boolean;
}

/** Output heartbeat for one task over the last two minutes. */
export interface TaskActivity {
  /** Output bytes per second, oldest first. */
  samples: number[];
  /** Last visible line of output without escape codes, or null. */
  lastLine: string | null;
  lastOutputAtMs: number | null;
}

/** GET /activity. Tasks with no output are omitted. */
export interface ActivityResponse {
  atMs: number;
  tasks: Record<string, TaskActivity>;
}

/** GET and PATCH /settings. Stored by the daemon. */
export interface Settings {
  /** Stop a task when the program that started it exits. Default false: tasks keep running. */
  stopWithAgent: boolean;
}

/** Live events on the socket. Terminal output only reaches clients subscribed to that task. */
export type AgentermEvent =
  | { kind: 'task.updated'; taskId: string; task: TaskRecord }
  | { kind: 'task.removed'; taskId: string }
  | { kind: 'terminal.output'; taskId: string; seq: number; data: string };

/** Client to daemon socket messages. */
export type ClientSocketMessage =
  | { kind: 'subscribe'; taskId: string; sinceSeq?: number }
  | { kind: 'unsubscribe'; taskId: string }
  | { kind: 'terminal.input'; taskId: string; data: string };

/** Daemon to client socket messages. */
export type ServerSocketMessage =
  | { kind: 'hello'; version: string; serverTimeMs: number }
  | { kind: 'event'; event: AgentermEvent }
  | {
      kind: 'activity';
      /** Output bytes and last line per task since the previous frame, about once a second. */
      tick: { atMs: number; tasks: Record<string, { bytes: number; lastLine: string | null }> };
    }
  | { kind: 'error'; code: string; message: string };
