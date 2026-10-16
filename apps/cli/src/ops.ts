import {
  findTask,
  isRunning,
  plainText,
  statusText,
  type AgentermClient,
  type OutsideProcess,
  type RunTaskResponse,
  type TaskRecord
} from '@agenterm/core';
import type { Caller } from './caller.js';

/**
 * What the CLI and the MCP server share: starting a task with the
 * caller's details filled in, and the text both print back. Agents see the
 * same words whichever way they call.
 */

export interface StartOptions {
  command: string;
  cwd: string;
  id?: string | undefined;
  title?: string | undefined;
  /** Who started it. Overrides detection. */
  agent?: string | undefined;
  restart?: boolean | undefined;
  env?: Record<string, string> | undefined;
}

/** Only string values; process.env can hold undefined. */
export function cleanEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (typeof value === 'string') out[key] = value;
  return out;
}

export function startTask(
  client: AgentermClient,
  options: StartOptions,
  caller: Caller | null
): Promise<RunTaskResponse> {
  const startedBy = options.agent ?? caller?.name;
  return client.run({
    command: options.command,
    cwd: options.cwd,
    ...(options.id === undefined ? {} : { id: options.id }),
    ...(options.title === undefined ? {} : { title: options.title }),
    ...(startedBy === undefined ? {} : { startedBy }),
    ...(caller === null ? {} : { startedByPid: caller.pid }),
    ...(options.restart === true ? { restart: true } : {}),
    ...(options.env === undefined ? {} : { env: options.env })
  });
}

/** Compact age like 45s, 12m, 3h, 2d. */
export function formatAge(fromMs: number, nowMs = Date.now()): string {
  const seconds = Math.max(0, Math.floor((nowMs - fromMs) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

export function shortPath(cwd: string, home = process.env['HOME']): string {
  return home !== undefined && home.length > 1 && (cwd === home || cwd.startsWith(`${home}/`))
    ? `~${cwd.slice(home.length)}`
    : cwd;
}

function truncate(text: string, width: number): string {
  return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`;
}

/** Left-aligned columns sized to content. The last column is never padded. */
export function table(rows: string[][]): string[] {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  }
  return rows.map((row) =>
    row
      .map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i] ?? 0)))
      .join('  ')
      .trimEnd()
  );
}

function ports(task: TaskRecord): string {
  return task.ports.map((port) => `:${port}`).join(' ');
}

/** One-line facts about a task: status, pid or exit, ports, folder. */
export function taskFacts(task: TaskRecord, nowMs = Date.now()): string {
  const parts = [isRunning(task) ? `running ${formatAge(task.startedAtMs, nowMs)}` : statusText(task)];
  if (isRunning(task)) parts.push(`pid ${task.pid}`);
  if (task.ports.length > 0) parts.push(ports(task));
  parts.push(shortPath(task.cwd));
  if (task.startedBy !== null) parts.push(`by ${task.startedBy}`);
  return parts.join(' · ');
}

/** What `run` prints, before any output. */
export function runSummary({ task, alreadyRunning }: RunTaskResponse): string[] {
  if (alreadyRunning) {
    return [
      `already running: ${task.id} (${task.command})`,
      `  ${taskFacts(task)}`,
      `  Not started again. Use the same id to check on it; pass restart to replace it.`
    ];
  }
  return [`started ${task.id}: ${task.command}`, `  ${taskFacts(task)}`];
}

/** Table for `ls`. */
export function taskTable(tasks: TaskRecord[], nowMs = Date.now()): string[] {
  if (tasks.length === 0) return ['no tasks. Start one with: agenterm run "<command>"'];
  return table([
    ['ID', 'STATUS', 'AGE', 'BY', 'PORTS', 'FOLDER', 'COMMAND'],
    ...tasks.map((task) => [
      task.id,
      statusText(task),
      formatAge(task.startedAtMs, nowMs),
      task.startedBy ?? '-',
      task.ports.length > 0 ? ports(task) : '-',
      truncate(shortPath(task.cwd), 40),
      truncate(task.command, 60)
    ])
  ]);
}

/** Memory like 512KB, 48MB, 1.2GB. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}

/** Table for `ps`: commands running outside agenterm. */
export function processTable(processes: OutsideProcess[], nowMs = Date.now()): string[] {
  return table([
    ['PID', 'AGE', 'BY', 'PORTS', 'CPU', 'MEM', 'FOLDER', 'COMMAND'],
    ...processes.map((entry) => [
      String(entry.pid),
      formatAge(entry.startedAtMs, nowMs),
      entry.startedBy ?? 'orphaned',
      entry.ports.length > 0 ? entry.ports.map((port) => `:${port}`).join(' ') : '-',
      `${Math.round(entry.cpuPercent)}%`,
      formatBytes(entry.memoryBytes),
      entry.cwd === null ? '-' : truncate(shortPath(entry.cwd), 40),
      truncate(entry.command, 60)
    ])
  ]);
}

export async function resolveTask(client: AgentermClient, ref: string): Promise<TaskRecord> {
  const { tasks } = await client.listTasks();
  return findTask(tasks, ref);
}

/** Last lines of a task's output as plain text. */
export async function tailLines(client: AgentermClient, taskId: string, lines: number): Promise<string[]> {
  const page = await client.output(taskId, { tailBytes: Math.min(1_048_576, Math.max(16_384, lines * 400)) });
  const text = plainText(page.chunks.map((chunk) => chunk.data).join(''));
  const all = text.replace(/\n+$/, '').split('\n');
  return all.length === 1 && all[0] === '' ? [] : all.slice(-lines);
}

/**
 * Wait a moment after a start so a caller sees whether the command came
 * up or failed straight away. Returns early when the task ends.
 */
export async function settle(
  client: AgentermClient,
  task: TaskRecord,
  waitMs: number,
  sleep: (ms: number) => Promise<void>
): Promise<TaskRecord> {
  let current = task;
  for (let waited = 0; waited < waitMs && isRunning(current); waited += 250) {
    await sleep(250);
    current = (await client.getTask(task.id)).task;
  }
  return current;
}

/** The block printed after a run settles: status change plus recent output. */
export function settledReport(task: TaskRecord, lines: string[]): string[] {
  const out: string[] = [];
  if (!isRunning(task)) out.push(`  ended: ${statusText(task)}`);
  if (lines.length > 0) {
    out.push('--- output ---', ...lines);
  } else {
    out.push('  (no output yet)');
  }
  return out;
}
