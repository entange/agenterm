/**
 * Task status.
 *
 * running: the command is alive in its terminal.
 * exited: it finished on its own with exit code 0.
 * failed: it finished on its own with a non-zero code or a signal.
 * stopped: someone stopped it (the CLI, an agent over MCP, or the app).
 * lost: the daemon went away while it was running, so its fate is unknown.
 */
export type TaskStatus = 'running' | 'exited' | 'failed' | 'stopped' | 'lost';

/**
 * One command running (or that ran) in a real terminal owned by the daemon.
 *
 * Everything except the command is optional for whoever starts it: the
 * folder defaults to where they are, the project comes from git, and
 * startedBy is detected from the process that ran `agenterm`.
 */
export interface TaskRecord {
  /**
   * Short id, chosen by the caller (`--id web`) or generated from the
   * command (`npm-run-dev-3f9a`). Lowercase letters, digits, `.`, `_`, `-`.
   */
  id: string;
  /** Human title. Defaults to the command. */
  title: string;
  /** The shell command line, exactly as given. Secrets are masked. */
  command: string;
  /** Absolute working directory. */
  cwd: string;
  /** Project name: the git repository name, or the folder name. Null for home and root. */
  project: string | null;
  /** Git repository root, or null outside a repository. */
  projectRoot: string | null;
  /** Git branch at start, or null. */
  branch: string | null;
  /** Who started it: an agent name like claude or codex, a terminal app, or a label passed with --agent. */
  startedBy: string | null;
  /** Pid of the process that started it, used for grouping and "stop when it exits". */
  startedByPid: number | null;
  /** OS pid of the command's shell. */
  pid: number;
  status: TaskStatus;
  /** Exit code once ended, or null. */
  exitCode: number | null;
  /** Signal name once ended by a signal, or null. */
  exitSignal: string | null;
  /** TCP ports the task's processes are listening on. */
  ports: number[];
  cols: number;
  rows: number;
  startedAtMs: number;
  endedAtMs: number | null;
}

/** Characters allowed in a task id. Also safe as a folder name. */
export const TASK_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function isRunning(task: Pick<TaskRecord, 'status'>): boolean {
  return task.status === 'running';
}

/** Short human status: running, finished, failed (exit 1), stopped, lost. */
export function statusText(task: Pick<TaskRecord, 'status' | 'exitCode' | 'exitSignal'>): string {
  switch (task.status) {
    case 'running':
      return 'running';
    case 'exited':
      return 'finished';
    case 'failed':
      return task.exitSignal !== null ? `failed (${task.exitSignal})` : `failed (exit ${task.exitCode ?? '?'})`;
    case 'stopped':
      return 'stopped';
    case 'lost':
      return 'lost (daemon restarted)';
  }
}

/**
 * Find a task by reference: exact id, then exact title (any case), then a
 * unique id prefix. Throws an Error that names the candidates otherwise.
 */
export function findTask<T extends Pick<TaskRecord, 'id' | 'title' | 'status'>>(tasks: T[], ref: string): T {
  const wanted = ref.trim();
  if (wanted.length === 0) throw new Error('a task id or title is required');
  const lower = wanted.toLowerCase();
  const byId = tasks.find((task) => task.id === lower);
  if (byId !== undefined) return byId;
  const byTitle = tasks.filter((task) => task.title.toLowerCase() === lower);
  // Several ended runs can share a title; the live one is the one meant.
  const titled = byTitle.length > 1 ? byTitle.filter((task) => task.status === 'running') : byTitle;
  if (titled.length === 1 && titled[0] !== undefined) return titled[0];
  const byPrefix = tasks.filter((task) => task.id.startsWith(lower));
  if (byPrefix.length === 1 && byPrefix[0] !== undefined) return byPrefix[0];
  const candidates = byTitle.length > 1 ? byTitle : byPrefix;
  if (candidates.length > 1) {
    // Sorted, so the message does not depend on list order (tasks started in the same millisecond).
    const ids = candidates.map((task) => task.id).sort();
    throw new Error(`"${wanted}" matches ${candidates.length} tasks: ${ids.join(', ')}`);
  }
  throw new Error(`no task matches "${wanted}"`);
}
