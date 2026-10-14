import { isRunning, type TaskRecord } from '@agenterm/core';
import { folderName } from './format.js';

export type GroupBy = 'project' | 'agent' | 'none';

export type ListRow =
  | { kind: 'group'; key: string; label: string; running: number; total: number; collapsed: boolean }
  | { kind: 'task'; task: TaskRecord };

/** Running first, then newest first. The same order the daemon and `agenterm ls` use. */
export function sortTasks(tasks: TaskRecord[]): TaskRecord[] {
  return tasks.slice().sort((a, b) => {
    const running = Number(isRunning(b)) - Number(isRunning(a));
    return running !== 0 ? running : b.startedAtMs - a.startedAtMs;
  });
}

/** Put one changed task into a sorted list, or add it. */
export function upsertTask(tasks: TaskRecord[], task: TaskRecord): TaskRecord[] {
  return sortTasks([task, ...tasks.filter((entry) => entry.id !== task.id)]);
}

function matches(task: TaskRecord, filter: string): boolean {
  const words = filter
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length > 0);
  if (words.length === 0) return true;
  const haystack = [
    task.id,
    task.title,
    task.command,
    task.cwd,
    task.project ?? '',
    task.startedBy ?? '',
    task.branch ?? ''
  ]
    .join(' ')
    .toLowerCase();
  return words.every((word) => haystack.includes(word));
}

/** Group label for a task. */
export function groupOf(task: TaskRecord, groupBy: GroupBy): string {
  if (groupBy === 'agent') return task.startedBy ?? 'unknown';
  return task.project ?? folderName(task.cwd);
}

/**
 * Flat rows for the sidebar: group headers and the tasks under them.
 * Groups with something running come first, then the most recently
 * started; tasks inside a group keep running-first, newest-first order.
 */
export function buildRows(
  tasks: TaskRecord[],
  options: { groupBy: GroupBy; filter: string; collapsed: ReadonlySet<string> }
): ListRow[] {
  const visible = sortTasks(tasks).filter((task) => matches(task, options.filter));
  if (options.groupBy === 'none') return visible.map((task) => ({ kind: 'task', task }));
  const groups = new Map<string, TaskRecord[]>();
  for (const task of visible) {
    const label = groupOf(task, options.groupBy);
    const list = groups.get(label);
    if (list === undefined) groups.set(label, [task]);
    else list.push(task);
  }
  const ordered = [...groups.entries()].sort(([, a], [, b]) => {
    const running = Number(b.some(isRunning)) - Number(a.some(isRunning));
    if (running !== 0) return running;
    return Math.max(...b.map((task) => task.startedAtMs)) - Math.max(...a.map((task) => task.startedAtMs));
  });
  const rows: ListRow[] = [];
  for (const [label, list] of ordered) {
    const key = `${options.groupBy}:${label}`;
    // A search shows every match, even inside collapsed groups.
    const collapsed = options.filter.trim().length === 0 && options.collapsed.has(key);
    rows.push({ kind: 'group', key, label, running: list.filter(isRunning).length, total: list.length, collapsed });
    if (!collapsed) for (const task of list) rows.push({ kind: 'task', task });
  }
  return rows;
}

/** Tasks in the order the sidebar shows them, for ⌘1-9 and next/previous. */
export function taskOrder(rows: ListRow[]): TaskRecord[] {
  return rows.flatMap((row) => (row.kind === 'task' ? [row.task] : []));
}
