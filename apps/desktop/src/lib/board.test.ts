import type { SessionRecord } from '@agenterm/core';
import { describe, expect, it } from 'vitest';
import { attentionOf, type Attention } from '../../shared/attention.js';
import { buildRows, ENDED_PREVIEW } from './board.js';

const NOW = 10_000_000;

function make(id: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: `${id}0000000-0000-0000-0000-000000000000`.slice(0, 36),
    agentId: 'claude',
    provider: 'claude',
    title: id,
    cwd: '/repo/a',
    worktreeRoot: '/repo/a',
    branch: 'main',
    origin: 'spawned',
    parentSessionId: null,
    commandLine: ['claude'],
    resolvedBinaryPath: null,
    pid: 1,
    lifecycle: 'running',
    overlay: 'unknown',
    overlaySource: 'pty',
    cols: 80,
    rows: 24,
    startedAtMs: NOW - 1000,
    endedAtMs: null,
    exitCode: null,
    exitSignal: null,
    ...overrides
  };
}

function attentionFor(sessions: SessionRecord[]): Map<string, Attention> {
  return new Map(sessions.map((session) => [session.id, attentionOf(session, { nowMs: NOW })]));
}

const options = { groupBy: 'status' as const, collapsed: new Set<string>(), filter: '', showAllEnded: false };

describe('buildRows', () => {
  it('groups by status with needs-you first and nests children under parents', () => {
    const parent = make('p');
    const child = make('c', { parentSessionId: parent.id, startedAtMs: NOW });
    const waiting = make('w', { overlay: 'waiting_permission' });
    const sessions = [child, parent, waiting];
    const rows = buildRows(sessions, attentionFor(sessions), options);
    expect(
      rows.map((row) =>
        row.kind === 'group' ? row.label : row.kind === 'session' ? `${row.session.title}@${row.depth}` : 'more'
      )
    ).toEqual(['Needs you', 'w@0', 'Quiet', 'p@0', 'c@1']);
    const parentRow = rows.find((row) => row.kind === 'session' && row.session.title === 'p');
    expect(parentRow?.kind === 'session' && parentRow.children).toBe(1);
  });

  it('collapses groups and parents, and caps ended sessions', () => {
    const parent = make('p');
    const child = make('c', { parentSessionId: parent.id });
    const ended = Array.from({ length: ENDED_PREVIEW + 3 }, (_, i) =>
      make(`e${i}`, { lifecycle: 'exited', exitCode: 0 })
    );
    const sessions = [parent, child, ...ended];
    const rows = buildRows(sessions, attentionFor(sessions), {
      ...options,
      collapsed: new Set([`parent:${parent.id}`])
    });
    expect(rows.some((row) => row.kind === 'session' && row.session.title === 'c')).toBe(false);
    expect(rows[rows.length - 1]).toEqual({ kind: 'more', key: 'more:ended', hidden: 3 });
    const folded = buildRows(sessions, attentionFor(sessions), { ...options, collapsed: new Set(['group:ended']) });
    expect(folded.filter((row) => row.kind === 'session')).toHaveLength(2);
  });

  it('groups by project with folders that need you first, and filters', () => {
    const a = make('a1', { cwd: '/repo/a', worktreeRoot: '/repo/a' });
    const b = make('b1', { cwd: '/repo/b', worktreeRoot: '/repo/b', overlay: 'waiting_input' });
    const sessions = [a, b];
    const rows = buildRows(sessions, attentionFor(sessions), { ...options, groupBy: 'project' });
    expect(rows.filter((row) => row.kind === 'group').map((row) => (row.kind === 'group' ? row.label : ''))).toEqual([
      'b',
      'a'
    ]);
    const filtered = buildRows(sessions, attentionFor(sessions), { ...options, filter: 'b1' });
    expect(filtered.filter((row) => row.kind === 'session')).toHaveLength(1);
  });

  it('stays fast with 500 sessions', () => {
    const sessions = Array.from({ length: 500 }, (_, i) =>
      make(`s${i}`, {
        cwd: `/repo/${i % 20}`,
        worktreeRoot: `/repo/${i % 20}`,
        parentSessionId: i % 5 === 0 ? null : null
      })
    );
    const attention = attentionFor(sessions);
    const started = performance.now();
    for (let i = 0; i < 20; i++)
      buildRows(sessions, attention, { ...options, groupBy: i % 2 === 0 ? 'status' : 'project' });
    expect((performance.now() - started) / 20).toBeLessThan(15);
  });
});
