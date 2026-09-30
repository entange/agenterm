import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { databaseFile, openDatabase, SqliteEvents, SqliteSessions } from '../src/database.js';
import { EventBus } from '../src/events.js';
import { SessionStore } from '../src/sessionStore.js';
import type { SessionRecord } from '@agenterm/core';

function scratchDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agenterm-store-'));
}

function sampleSession(id: string): SessionRecord {
  return {
    id,
    agentId: 'agent-1',
    provider: 'generic',
    title: 'persisted',
    cwd: '/tmp',
    worktreeRoot: null,
    branch: null,
    origin: 'spawned',
    commandLine: ['/bin/echo'],
    resolvedBinaryPath: '/bin/echo',
    pid: 777,
    lifecycle: 'running',
    overlay: 'unknown',
    overlaySource: 'pty',
    cols: 80,
    rows: 24,
    startedAtMs: 100,
    endedAtMs: null,
    exitCode: null,
    exitSignal: null
  };
}

describe('SessionStore with SQLite', () => {
  it('writes through and reloads rows across instances', () => {
    const dir = scratchDir();
    const first = openDatabase(databaseFile(dir));
    try {
      const store = new SessionStore({ dataDir: dir, table: new SqliteSessions(first.db) });
      store.createSpawned({ ...sampleSession('keep-1'), title: 'persisted' });
      expect(store.get('keep-1')?.title).toBe('persisted');
    } finally {
      first.raw.close();
    }
    const second = openDatabase(databaseFile(dir));
    try {
      const reopened = new SessionStore({ dataDir: dir, table: new SqliteSessions(second.db) });
      // Restart replay marks the live row crashed, matching daemon semantics.
      expect(reopened.get('keep-1')?.lifecycle).toBe('crashed');
      expect(fs.existsSync(path.join(dir, 'sessions', 'keep-1', 'metadata.json'))).toBe(true);
    } finally {
      second.raw.close();
    }
  });

  it('removes rows from SQLite on detach', () => {
    const dir = scratchDir();
    const opened = openDatabase(databaseFile(dir));
    try {
      const table = new SqliteSessions(opened.db);
      const store = new SessionStore({ table });
      store.createSpawned(sampleSession('gone-1'));
      store.remove('gone-1');
      expect(table.get('gone-1')).toBe(null);
    } finally {
      opened.raw.close();
    }
  });
});

describe('EventBus with SQLite', () => {
  it('mirrors published events into the table', () => {
    const dir = scratchDir();
    const opened = openDatabase(databaseFile(dir));
    try {
      const table = new SqliteEvents(opened.db);
      const bus = new EventBus({ dataDir: dir, table });
      bus.publish({
        id: '',
        sessionId: 's1',
        createdAtMs: 7,
        kind: 'session.created',
        pid: 1,
        origin: 'spawned',
        commandLine: ['x'],
        cwd: '/tmp'
      });
      const rows = table.forSession('s1');
      expect(rows).toHaveLength(1);
      expect(rows[0]?.kind).toBe('session.created');
    } finally {
      opened.raw.close();
    }
  });
});
