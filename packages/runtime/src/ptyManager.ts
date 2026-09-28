import * as pty from 'node-pty';
import { stripSecretEnv } from '@agenterm/core';
import { TerminalLog } from './terminal.js';

/** Minimal PTY surface used by the manager. Matches node-pty shape. */
export interface PtyHandle {
  pid: number;
  onData: (callback: (data: string) => void) => void;
  onExit: (callback: (event: { exitCode: number; signal?: number }) => void) => void;
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  kill: (signal?: string) => void;
}

export type SpawnFn = (
  file: string,
  args: string[],
  options: { cwd: string; env: Record<string, string>; cols: number; rows: number; name: string }
) => PtyHandle;

export interface SpawnSpec {
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
  sessionId: string;
}

export interface PtyExit {
  exitCode: number;
  signal: string | null;
}

export interface ManagedPty {
  sessionId: string;
  pid: number;
  log: TerminalLog;
  exit: PtyExit | null;
}

function defaultSpawn(
  file: string,
  args: string[],
  options: { cwd: string; env: Record<string, string>; cols: number; rows: number; name: string }
): PtyHandle {
  const handle = pty.spawn(file, args, {
    name: options.name,
    cwd: options.cwd,
    env: options.env as Record<string, string>,
    cols: options.cols,
    rows: options.rows
  });
  return handle as unknown as PtyHandle;
}

/**
 * PTY owner. Only the daemon may hold PTYs.
 *
 * Spawns the agent binary in a real pseudo-terminal, funnels output into
 * the per-session ring plus file mirror, and reports exits with code and
 * signal. Attached sessions never receive a PTY.
 */
export class PtyManager {
  private readonly sessions = new Map<string, { handle: PtyHandle; record: ManagedPty }>();
  private readonly spawnFn: SpawnFn;
  private readonly dataDir: string | undefined;
  private readonly maxBytes: number;
  onOutput: ((sessionId: string, data: string) => void) | undefined;
  onExit: ((sessionId: string, exit: PtyExit) => void) | undefined;

  constructor(
    options: {
      spawnFn?: SpawnFn | undefined;
      dataDir?: string | undefined;
      maxBytes?: number | undefined;
      onOutput?: ((sessionId: string, data: string) => void) | undefined;
      onExit?: ((sessionId: string, exit: PtyExit) => void) | undefined;
    } = {}
  ) {
    this.spawnFn = options.spawnFn ?? defaultSpawn;
    this.dataDir = options.dataDir;
    this.maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
    this.onOutput = options.onOutput;
    this.onExit = options.onExit;
  }

  spawn(spec: SpawnSpec): ManagedPty {
    if (this.sessions.has(spec.sessionId)) {
      throw new Error(`session ${spec.sessionId} already owns a PTY`);
    }
    const safeEnv = stripSecretEnv(spec.env);
    const env: Record<string, string> = {
      ...safeEnv,
      ['TERM']: 'xterm-256color',
      ['AGENTERM']: '1',
      ['AGENTERM_SESSION_ID']: spec.sessionId
    };
    const handle = this.spawnFn(spec.file, spec.args, {
      cwd: spec.cwd,
      env,
      cols: spec.cols,
      rows: spec.rows,
      name: 'xterm-256color'
    });
    const logOptions: { maxBytes: number; dir?: string | undefined; sessionId?: string | undefined } = {
      maxBytes: this.maxBytes
    };
    if (typeof this.dataDir === 'string') {
      logOptions.dir = this.dataDir;
      logOptions.sessionId = spec.sessionId;
    }
    const record: ManagedPty = {
      sessionId: spec.sessionId,
      pid: handle.pid,
      log: new TerminalLog(logOptions),
      exit: null
    };
    handle.onData((data: string) => {
      record.log.append(data);
      this.onOutput?.(spec.sessionId, data);
    });
    handle.onExit((event: { exitCode: number; signal?: number }) => {
      record.exit = { exitCode: event.exitCode, signal: event.signal === undefined ? null : String(event.signal) };
      this.onExit?.(spec.sessionId, record.exit);
    });
    this.sessions.set(spec.sessionId, { handle, record });
    return record;
  }

  get(sessionId: string): ManagedPty | null {
    return this.sessions.get(sessionId)?.record ?? null;
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  write(sessionId: string, data: string): void {
    const entry = this.sessions.get(sessionId);
    if (entry === undefined) {
      throw new Error(`session ${sessionId} has no owned PTY`);
    }
    entry.handle.write(data);
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const entry = this.sessions.get(sessionId);
    if (entry === undefined) {
      throw new Error(`session ${sessionId} has no owned PTY`);
    }
    entry.handle.resize(cols, rows);
  }

  /** End the PTY leader. Tree cleanup is the supervisor kill-tree path. */
  kill(sessionId: string, signal = 'SIGTERM'): void {
    const entry = this.sessions.get(sessionId);
    if (entry === undefined) {
      throw new Error(`session ${sessionId} has no owned PTY`);
    }
    entry.handle.kill(signal);
  }

  forget(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (entry === undefined) return;
    entry.record.log.close();
    this.sessions.delete(sessionId);
  }
}
