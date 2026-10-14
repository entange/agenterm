import os from 'node:os';
import * as pty from 'node-pty';
import { terminalLogPath } from './paths.js';
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
  taskId: string;
}

export interface PtyExit {
  exitCode: number;
  signal: string | null;
}

export interface ManagedPty {
  taskId: string;
  pid: number;
  log: TerminalLog;
  exit: PtyExit | null;
}

/** Map node-pty's numeric signal to a name. Zero and absent mean a normal exit. */
export function signalName(signal: number | undefined): string | null {
  if (signal === undefined || signal === 0) return null;
  for (const [name, value] of Object.entries(os.constants.signals)) {
    if (value === signal) return name;
  }
  return String(signal);
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
 * Spawns a command in a real pseudo-terminal, funnels output into the
 * per-task ring plus file mirror, and reports exits with code and signal.
 * A PTY that was forgotten (its task removed or restarted under the same
 * id) stops reporting, so it can never touch its successor.
 */
export class PtyManager {
  private readonly tasks = new Map<string, { handle: PtyHandle; record: ManagedPty }>();
  private readonly spawnFn: SpawnFn;
  private readonly dataDir: string | undefined;
  private readonly maxBytes: number;
  onOutput: ((taskId: string, data: string) => void) | undefined;
  onExit: ((taskId: string, exit: PtyExit) => void) | undefined;

  constructor(
    options: {
      spawnFn?: SpawnFn | undefined;
      dataDir?: string | undefined;
      maxBytes?: number | undefined;
      onOutput?: ((taskId: string, data: string) => void) | undefined;
      onExit?: ((taskId: string, exit: PtyExit) => void) | undefined;
    } = {}
  ) {
    this.spawnFn = options.spawnFn ?? defaultSpawn;
    this.dataDir = options.dataDir;
    this.maxBytes = options.maxBytes ?? 1024 * 1024;
    this.onOutput = options.onOutput;
    this.onExit = options.onExit;
  }

  spawn(spec: SpawnSpec): ManagedPty {
    if (this.tasks.has(spec.taskId)) {
      throw new Error(`task ${spec.taskId} already owns a PTY`);
    }
    // spec.env is already composed by buildSpawnEnv; only terminal identity is forced here.
    const env: Record<string, string> = {
      ...spec.env,
      ['TERM']: 'xterm-256color',
      ['COLORTERM']: 'truecolor',
      ['AGENTERM']: '1',
      ['AGENTERM_TASK_ID']: spec.taskId
    };
    const handle = this.spawnFn(spec.file, spec.args, {
      cwd: spec.cwd,
      env,
      cols: spec.cols,
      rows: spec.rows,
      name: 'xterm-256color'
    });
    const logOptions: { maxBytes: number; file?: string | undefined } = { maxBytes: this.maxBytes };
    if (typeof this.dataDir === 'string') {
      logOptions.file = terminalLogPath(spec.taskId, this.dataDir);
    }
    const record: ManagedPty = {
      taskId: spec.taskId,
      pid: handle.pid,
      log: new TerminalLog(logOptions),
      exit: null
    };
    const current = (): boolean => this.tasks.get(spec.taskId)?.record === record;
    handle.onData((data: string) => {
      if (!current()) return;
      record.log.append(data);
      this.onOutput?.(spec.taskId, data);
    });
    handle.onExit((event: { exitCode: number; signal?: number }) => {
      record.exit = { exitCode: event.exitCode, signal: signalName(event.signal) };
      if (current()) this.onExit?.(spec.taskId, record.exit);
    });
    this.tasks.set(spec.taskId, { handle, record });
    return record;
  }

  get(taskId: string): ManagedPty | null {
    return this.tasks.get(taskId)?.record ?? null;
  }

  has(taskId: string): boolean {
    return this.tasks.has(taskId);
  }

  write(taskId: string, data: string): void {
    const entry = this.tasks.get(taskId);
    if (entry === undefined) {
      throw new Error(`task ${taskId} has no owned PTY`);
    }
    entry.handle.write(data);
  }

  resize(taskId: string, cols: number, rows: number): void {
    const entry = this.tasks.get(taskId);
    if (entry === undefined) {
      throw new Error(`task ${taskId} has no owned PTY`);
    }
    entry.handle.resize(cols, rows);
  }

  /** End the PTY leader. Tree cleanup is the supervisor kill-tree path. */
  kill(taskId: string, signal = 'SIGTERM'): void {
    const entry = this.tasks.get(taskId);
    if (entry === undefined) {
      throw new Error(`task ${taskId} has no owned PTY`);
    }
    entry.handle.kill(signal);
  }

  /** Drop the task's PTY record. Resolves after its log file is closed. */
  forget(taskId: string): Promise<void> {
    const entry = this.tasks.get(taskId);
    if (entry === undefined) return Promise.resolve();
    this.tasks.delete(taskId);
    return entry.record.log.close();
  }
}
