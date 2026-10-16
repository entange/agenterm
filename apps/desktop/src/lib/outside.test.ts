import type { OutsideProcess } from '@agenterm/core';
import { describe, expect, it } from 'vitest';
import { canMove, groupOutside, outsideLabel, runInstead, taskIdFor } from './outside.js';

function entry(pid: number, patch: Partial<OutsideProcess> = {}): OutsideProcess {
  return {
    pid,
    pids: [pid],
    name: 'vite',
    command: 'node /app/node_modules/.bin/vite',
    cwd: '/work/app',
    project: 'app',
    startedBy: 'iTerm',
    startedByPid: 10,
    orphaned: false,
    tty: 'ttys001',
    ports: [5173],
    cpuPercent: 0,
    memoryBytes: 0,
    startedAtMs: pid,
    ...patch
  };
}

describe('groupOutside', () => {
  const list = [
    entry(1),
    entry(2, { startedBy: 'claude' }),
    entry(3, { startedBy: 'claude' }),
    entry(4, { startedBy: null, orphaned: true }),
    entry(5, { startedBy: null, orphaned: true, name: 'cloudflared', ports: [] })
  ];

  it('puts orphans first, then the busiest starter, newest first inside', () => {
    expect(groupOutside(list, '').map((group) => [group.label, group.processes.map((p) => p.pid)])).toEqual([
      ['Orphaned', [5, 4]],
      ['claude', [3, 2]],
      ['iTerm', [1]]
    ]);
  });

  it('filters by name, starter, folder, or port', () => {
    expect(groupOutside(list, 'cloudflared').flatMap((group) => group.processes.map((p) => p.pid))).toEqual([5]);
    expect(groupOutside(list, 'orphaned :5173').flatMap((group) => group.processes.map((p) => p.pid))).toEqual([4]);
  });
});

describe('labels and rerunning', () => {
  it('names a command by its project and program', () => {
    expect(outsideLabel(entry(1))).toBe('app · vite');
    expect(outsideLabel(entry(1, { project: null, cwd: null }))).toBe('vite');
    expect(outsideLabel(entry(1, { project: null, cwd: '/' }))).toBe('vite');
  });

  it('builds the agenterm run line, unless secrets were masked', () => {
    expect(runInstead(entry(1, { cwd: '/work/my app' }))).toBe(
      "agenterm run --id app-vite -C '/work/my app' 'node /app/node_modules/.bin/vite'"
    );
    expect(runInstead(entry(1, { command: 'cloudflared --token [REDACTED]' }))).toBe(null);
  });

  it('moves into agenterm only with a folder and no masked secrets', () => {
    expect(taskIdFor(entry(1))).toBe('app-vite');
    expect(canMove(entry(1))).toBe(true);
    expect(canMove(entry(1, { cwd: null }))).toBe(false);
    expect(canMove(entry(1, { command: 'cloudflared --token [REDACTED]' }))).toBe(false);
  });
});
