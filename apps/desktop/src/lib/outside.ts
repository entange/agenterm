import type { OutsideProcess } from '@agenterm/core';
import { folderName } from './format.js';

/** Commands outside agenterm under one starter: an app, an agent, or nobody (orphaned). */
export interface OutsideGroup {
  key: string;
  label: string;
  processes: OutsideProcess[];
}

function matches(entry: OutsideProcess, filter: string): boolean {
  const words = filter
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length > 0);
  if (words.length === 0) return true;
  const haystack = [
    String(entry.pid),
    entry.name,
    entry.command,
    entry.cwd ?? '',
    entry.project ?? '',
    entry.startedBy ?? 'orphaned',
    ...entry.ports.map((port) => `:${port}`)
  ]
    .join(' ')
    .toLowerCase();
  return words.every((word) => haystack.includes(word));
}

/**
 * Groups for the sidebar: orphaned first, since nothing else will end
 * them, then by who started them, busiest first. Newest first inside each.
 */
export function groupOutside(processes: OutsideProcess[], filter: string): OutsideGroup[] {
  const groups = new Map<string, OutsideProcess[]>();
  for (const entry of processes) {
    if (!matches(entry, filter)) continue;
    const label = entry.startedBy ?? 'Orphaned';
    const key = entry.orphaned ? 'orphaned' : `by:${label}`;
    const list = groups.get(key);
    if (list === undefined) groups.set(key, [entry]);
    else list.push(entry);
  }
  return [...groups.entries()]
    .map(([key, list]) => ({
      key,
      label: key === 'orphaned' ? 'Orphaned' : (list[0]?.startedBy ?? key),
      processes: list.slice().sort((a, b) => b.startedAtMs - a.startedAtMs)
    }))
    .sort((a, b) => {
      const orphaned = Number(b.key === 'orphaned') - Number(a.key === 'orphaned');
      if (orphaned !== 0) return orphaned;
      return b.processes.length - a.processes.length || a.label.localeCompare(b.label);
    });
}

/** Display label: the project and program, so `vite` in `app` reads "app · vite". */
export function outsideLabel(entry: OutsideProcess): string {
  const where = entry.project ?? (entry.cwd === null || entry.cwd === '/' ? null : folderName(entry.cwd));
  return where === null || where === entry.name ? entry.name : `${where} · ${entry.name}`;
}

function quote(text: string): string {
  return /^[\w@%+=:,./-]+$/.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`;
}

/**
 * The `agenterm run` line that would run this command as a task instead,
 * or null when the command line had secrets masked and cannot be rerun as shown.
 */
export function runInstead(entry: OutsideProcess): string | null {
  if (entry.command.includes('[REDACTED]')) return null;
  const id = outsideLabel(entry)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const folder = entry.cwd === null ? '' : ` -C ${quote(entry.cwd)}`;
  return `agenterm run --id ${id || 'task'}${folder} ${quote(entry.command)}`;
}

/** 52MB, 1.2GB. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}
