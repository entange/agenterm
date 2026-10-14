import type { TaskRecord } from '@agenterm/core';
import type { Signal } from '@agenterm/ui';

/** Compact age: now, 45s, 12m, 3h, 2d. */
export function formatAge(fromMs: number, nowMs = Date.now()): string {
  const seconds = Math.max(0, Math.floor((nowMs - fromMs) / 1000));
  if (seconds < 5) return 'now';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

/** Duration like 850ms, 12.4s, 3m 05s, 2h 10m. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m ${String(Math.floor((ms % 60_000) / 1000)).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** Home-relative path for display: /Users/me/code/app → ~/code/app. */
export function shortPath(cwd: string): string {
  const match = /^(\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)(.*)$/.exec(cwd);
  if (match === null) return cwd;
  return `~${match[2] ?? ''}` || '~';
}

/** Last path segment, for compact labels. */
export function folderName(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? cwd;
}

/** Dot color: green running, red failed, amber lost, gray finished or stopped. */
export function signalOf(task: Pick<TaskRecord, 'status'>): Signal {
  switch (task.status) {
    case 'running':
      return 'ok';
    case 'failed':
      return 'fail';
    case 'lost':
      return 'attn';
    default:
      return 'idle';
  }
}

/** "up 5m" while running, "ran 3m 05s" once ended. */
export function runtimeText(task: Pick<TaskRecord, 'startedAtMs' | 'endedAtMs'>, nowMs = Date.now()): string {
  return task.endedAtMs === null
    ? `up ${formatDuration(nowMs - task.startedAtMs)}`
    : `ran ${formatDuration(task.endedAtMs - task.startedAtMs)}`;
}
