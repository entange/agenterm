import type { TaskRecord } from '@agenterm/core';
import { describe, expect, it } from 'vitest';
import { buildRows, taskOrder, upsertTask } from './tasks.js';

function task(id: string, patch: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id,
    title: id,
    command: `echo ${id}`,
    cwd: '/srv/app',
    project: 'app',
    projectRoot: '/srv/app',
    branch: null,
    startedBy: 'claude',
    startedByPid: 10,
    pid: 100,
    status: 'running',
    exitCode: null,
    exitSignal: null,
    ports: [],
    cols: 80,
    rows: 24,
    startedAtMs: 1,
    endedAtMs: null,
    ...patch
  };
}

const none = new Set<string>();

describe('task list', () => {
  it('groups by project with running groups first', () => {
    const tasks = [
      task('old', { project: 'site', status: 'exited', startedAtMs: 50 }),
      task('web', { startedAtMs: 10 }),
      task('api', { startedAtMs: 20, status: 'failed' })
    ];
    const rows = buildRows(tasks, { groupBy: 'project', filter: '', collapsed: none });
    expect(rows.map((row) => (row.kind === 'group' ? `#${row.label}` : row.task.id))).toEqual([
      '#app',
      'web',
      'api',
      '#site',
      'old'
    ]);
    expect(rows[0]).toMatchObject({ running: 1, total: 2 });
  });

  it('groups by who started it', () => {
    const rows = buildRows([task('a'), task('b', { startedBy: null })], {
      groupBy: 'agent',
      filter: '',
      collapsed: none
    });
    expect(rows.filter((row) => row.kind === 'group').map((row) => (row.kind === 'group' ? row.label : ''))).toEqual([
      'claude',
      'unknown'
    ]);
  });

  it('hides collapsed groups unless searching', () => {
    const tasks = [task('web'), task('api')];
    const collapsed = new Set(['project:app']);
    expect(taskOrder(buildRows(tasks, { groupBy: 'project', filter: '', collapsed }))).toEqual([]);
    expect(taskOrder(buildRows(tasks, { groupBy: 'project', filter: 'web', collapsed })).map((t) => t.id)).toEqual([
      'web'
    ]);
  });

  it('matches every search word anywhere in the task', () => {
    const tasks = [task('web', { command: 'npm run dev' }), task('api', { command: 'cargo run' })];
    const rows = buildRows(tasks, { groupBy: 'none', filter: 'npm dev', collapsed: none });
    expect(taskOrder(rows).map((t) => t.id)).toEqual(['web']);
  });

  it('replaces a changed task and keeps the order', () => {
    const list = [task('a', { startedAtMs: 2 }), task('b', { startedAtMs: 1 })];
    const next = upsertTask(list, task('a', { startedAtMs: 2, status: 'stopped' }));
    expect(next.map((t) => `${t.id}:${t.status}`)).toEqual(['b:running', 'a:stopped']);
  });
});
