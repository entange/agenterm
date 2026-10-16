import type { OutsideProcess } from '@agenterm/core';
import { describe, expect, it } from 'vitest';
import { newOrphans, orphanMessage } from './orphans.js';

function entry(pid: number, patch: Partial<OutsideProcess> = {}): OutsideProcess {
  return {
    pid,
    pids: [pid],
    name: 'vite',
    command: 'node /app/node_modules/.bin/vite',
    cwd: '/work/app',
    project: 'app',
    startedBy: 'claude',
    startedByPid: 10,
    orphaned: false,
    hidden: false,
    tty: null,
    ports: [5173],
    cpuPercent: 0,
    memoryBytes: 0,
    startedAtMs: 1000 + pid,
    ...patch
  };
}

const orphan = { startedBy: null, startedByPid: null, orphaned: true };
const seen = (...entries: OutsideProcess[]) => new Map(entries.map((e) => [`${e.pid}:${e.startedAtMs}`, e]));

describe('newOrphans', () => {
  it('finds commands left behind since the last look, and who left them', () => {
    const before = seen(entry(1), entry(2, orphan), entry(3, { startedBy: 'zsh' }));
    const found = newOrphans(before, [
      entry(1, orphan),
      entry(2, orphan),
      entry(3, { startedBy: 'zsh' }),
      entry(4, orphan)
    ]);
    expect(found.map((o) => [o.entry.pid, o.leftBy])).toEqual([
      [1, 'claude'],
      [4, null]
    ]);
  });

  it('skips hidden commands, and a reused pid counts as new', () => {
    const before = seen(entry(1, orphan), entry(2));
    const found = newOrphans(before, [
      entry(1, { ...orphan, startedAtMs: 9999 }),
      entry(2, { ...orphan, hidden: true })
    ]);
    expect(found.map((o) => [o.entry.pid, o.leftBy])).toEqual([[1, null]]);
  });
});

describe('orphanMessage', () => {
  it('names one command, its starter, and its port', () => {
    expect(orphanMessage([{ entry: entry(1, orphan), leftBy: 'claude' }])).toEqual({
      title: 'vite was left running',
      body: 'claude exited, and nothing will stop it. It holds :5173.'
    });
  });

  it('sums up several', () => {
    expect(
      orphanMessage([
        { entry: entry(1, orphan), leftBy: 'codex' },
        { entry: entry(2, { ...orphan, name: 'tsc', ports: [] }), leftBy: null }
      ])
    ).toEqual({ title: '2 commands were left running', body: 'codex exited: vite, tsc.' });
    expect(
      orphanMessage([
        { entry: entry(1, orphan), leftBy: null },
        { entry: entry(2, orphan), leftBy: null }
      ])
    ).toEqual({ title: '2 commands were left running', body: 'What started them exited: vite.' });
  });
});
