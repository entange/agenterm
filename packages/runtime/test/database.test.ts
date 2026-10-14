import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type { TaskRecord } from '@agenterm/core';
import { openDatabase, TaskTable } from '../src/database.js';
import { TaskStore } from '../src/taskStore.js';

function tempFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agenterm-db-')), 'agenterm.db');
}

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'web',
    title: 'npm run dev',
    command: 'npm run dev',
    cwd: '/work/shop',
    project: 'shop',
    projectRoot: '/work/shop',
    branch: 'main',
    startedBy: 'claude',
    startedByPid: 4242,
    pid: 900,
    status: 'running',
    exitCode: null,
    exitSignal: null,
    ports: [],
    cols: 120,
    rows: 32,
    startedAtMs: 1000,
    endedAtMs: null,
    ...overrides
  };
}

describe('TaskTable', () => {
  it('round-trips a task, upserts, and lists newest first', () => {
    const table = new TaskTable(openDatabase(tempFile()));
    table.put(task());
    table.put(task({ id: 'api', startedAtMs: 2000, startedBy: null, startedByPid: null, project: null }));
    expect(table.get('web')).toEqual(task());
    table.put(task({ status: 'failed', exitCode: 1, endedAtMs: 3000 }));
    expect(table.get('web')).toMatchObject({ status: 'failed', exitCode: 1, endedAtMs: 3000 });
    expect(table.list().map((row) => row.id)).toEqual(['api', 'web']);
    table.delete('api');
    expect(table.get('api')).toBe(null);
  });

  it('marks tasks left running by a previous daemon as lost', () => {
    const file = tempFile();
    const first = new TaskTable(openDatabase(file));
    first.put(task());
    first.put(task({ id: 'done', status: 'exited', exitCode: 0, endedAtMs: 5 }));
    const table = new TaskTable(openDatabase(file));
    expect(table.markLost(9000)).toEqual(['web']);
    expect(table.get('web')).toMatchObject({ status: 'lost', endedAtMs: 9000 });
    expect(table.get('done')?.status).toBe('exited');
    expect(new TaskStore(table).list().map((row) => row.status)).toEqual(['lost', 'exited']);
  });

  it('drops tables from session-based builds and keeps the file private', () => {
    const file = tempFile();
    const old = new Database(file);
    old.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY)');
    old.exec('CREATE TABLE events (id TEXT PRIMARY KEY)');
    old.close();
    const raw = openDatabase(file);
    const tables = (
      raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
    ).map((row) => row.name);
    expect(tables).toEqual(['tasks']);
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });
});
