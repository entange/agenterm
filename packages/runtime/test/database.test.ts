import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { desc } from 'drizzle-orm';
import * as schema from '../src/schema.js';
import { openDatabase, rowToSession, sessionToRow, SqliteEvents, SqliteSessions } from '../src/database.js';
import type { SessionRecord } from '@agenterm/core';

function tmpFile(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenterm-db-'));
  return path.join(dir, name);
}

function sampleSession(id: string): SessionRecord {
  return {
    id,
    agentId: 'agent-1',
    provider: 'generic',
    title: 'db round trip',
    cwd: '/tmp',
    worktreeRoot: null,
    branch: 'work',
    origin: 'spawned',
    commandLine: ['/bin/echo', 'hi'],
    resolvedBinaryPath: '/bin/echo',
    pid: 4242,
    lifecycle: 'running',
    overlay: 'unknown',
    overlaySource: 'pty',
    cols: 80,
    rows: 24,
    startedAtMs: 1700000000000,
    endedAtMs: null,
    exitCode: null,
    exitSignal: null
  };
}

describe('database schema', () => {
  it('creates every table with a typed round trip', () => {
    const { raw, db } = openDatabase(tmpFile('schema.db'));
    try {
      db.insert(schema.machines)
        .values({
          id: 'm1',
          hostname: 'host',
          platform: 'darwin',
          arch: 'arm64',
          firstSeenAtMs: 1,
          lastSeenAtMs: 2
        })
        .run();
      db.insert(schema.projects)
        .values({
          id: 'p1',
          machineId: 'm1',
          name: 'demo',
          rootPath: '/work',
          createdAtMs: 1,
          updatedAtMs: 2
        })
        .run();
      db.insert(schema.workspaces)
        .values({
          id: 'w1',
          projectId: 'p1',
          cwd: '/work/app',
          worktreeRoot: '/work',
          branch: 'work',
          isDirty: 0,
          createdAtMs: 1,
          updatedAtMs: 2
        })
        .run();
      db.insert(schema.agents)
        .values({
          id: 'a1',
          workspaceId: 'w1',
          provider: 'claude',
          displayName: 'claude',
          command: 'claude',
          argsJson: '[]',
          envJson: '{}',
          createdAtMs: 1
        })
        .run();
      const session = sampleSession('s-schema');
      new SqliteSessions(db).save(session);
      db.insert(schema.processes)
        .values({
          id: 'pr1',
          sessionId: 's-schema',
          pid: 10,
          ppid: 1,
          command: 'claude',
          cwd: null,
          cpuPercent: 5,
          rssBytes: 1000,
          startedAtMs: null,
          endedAtMs: null,
          exitCode: null,
          sampledAtMs: 3
        })
        .run();
      db.insert(schema.commands)
        .values({
          id: 'c1',
          sessionId: 's-schema',
          text: 'bun test',
          cwd: '/work',
          pid: 10,
          startedAtMs: 3,
          durationMs: 40,
          exitCode: 0,
          outputLineCount: 12
        })
        .run();
      new SqliteEvents(db).append({
        id: 'e1',
        sessionId: 's-schema',
        createdAtMs: 4,
        kind: 'session.created',
        pid: 10,
        origin: 'spawned',
        commandLine: ['claude'],
        cwd: '/work'
      });
      expect(db.select().from(schema.machines).all()).toHaveLength(1);
      expect(db.select().from(schema.projects).all()).toHaveLength(1);
      expect(db.select().from(schema.workspaces).all()).toHaveLength(1);
      expect(db.select().from(schema.agents).all()).toHaveLength(1);
      expect(db.select().from(schema.sessions).all()).toHaveLength(1);
      expect(db.select().from(schema.processes).all()).toHaveLength(1);
      expect(db.select().from(schema.commands).all()).toHaveLength(1);
      expect(db.select().from(schema.events).all()).toHaveLength(1);
      const ordered = db.select().from(schema.sessions).orderBy(desc(schema.sessions.startedAtMs)).all();
      expect(ordered[0]?.id).toBe('s-schema');
    } finally {
      raw.close();
    }
  });
});

describe('SqliteSessions', () => {
  it('round-trips nulls and lists newest first', () => {
    const { raw, db } = openDatabase(tmpFile('sessions.db'));
    try {
      const table = new SqliteSessions(db);
      const first = { ...sampleSession('s1'), startedAtMs: 100 };
      const second = { ...sampleSession('s2'), startedAtMs: 200, branch: null, resolvedBinaryPath: null };
      table.save(first);
      table.save(second);
      expect(table.get('s2')?.branch).toBe(null);
      expect(table.all().map((row) => row.id)).toEqual(['s2', 's1']);
      table.remove('s2');
      expect(table.get('s2')).toBe(null);
    } finally {
      raw.close();
    }
  });

  it('marks rows left live as crashed on replay', () => {
    const { raw, db } = openDatabase(tmpFile('replay.db'));
    try {
      const table = new SqliteSessions(db);
      table.save(sampleSession('live-1'));
      table.save({ ...sampleSession('done-1'), lifecycle: 'exited', endedAtMs: 5, exitCode: 0 });
      expect(table.replayCrashes(99)).toBe(1);
      expect(table.get('live-1')?.lifecycle).toBe('crashed');
      expect(table.get('live-1')?.endedAtMs).toBe(99);
      expect(table.get('done-1')?.lifecycle).toBe('exited');
    } finally {
      raw.close();
    }
  });

  it('keeps row mapping honest both ways', () => {
    const record = sampleSession('map-1');
    const back = rowToSession({ ...sessionToRow(record), commandLineJson: 'broken' });
    expect(back.commandLine).toEqual([]);
    expect(rowToSession(sessionToRow(record))).toEqual(record);
  });
});

describe('SqliteEvents', () => {
  it('appends redacted rows and reads per session', () => {
    const { raw, db } = openDatabase(tmpFile('events.db'));
    try {
      const table = new SqliteEvents(db);
      table.append({
        id: '',
        sessionId: 's1',
        createdAtMs: 1,
        kind: 'agent.status',
        overlay: 'working',
        source: 'harness',
        summary: 'token sk-abcdefgh12345678 here'
      });
      const rows = table.forSession('s1');
      expect(rows).toHaveLength(1);
      expect(rows[0]?.payloadJson).toContain('[REDACTED]');
      expect(rows[0]?.id.length).toBeGreaterThan(0);
    } finally {
      raw.close();
    }
  });

  it('prunes oldest rows past the cap', () => {
    const { raw, db } = openDatabase(tmpFile('prune.db'));
    try {
      const table = new SqliteEvents(db);
      for (let i = 0; i < 5; i++) {
        table.append({
          id: `e${i}`,
          sessionId: 's1',
          createdAtMs: i,
          kind: 'terminal.input',
          seq: i,
          data: 'x'
        });
      }
      expect(table.prune(3, 30, 10)).toBe(2);
      expect(table.forSession('s1', 10).map((row) => row.id)).toEqual(['e2', 'e3', 'e4']);
      expect(table.prune(3, 30, 10)).toBe(0);
    } finally {
      raw.close();
    }
  });

  it('prunes rows older than the retention window and pages newest first', () => {
    const { raw, db } = openDatabase(tmpFile('retention.db'));
    try {
      const table = new SqliteEvents(db);
      const day = 24 * 60 * 60 * 1000;
      const now = 100 * day;
      const stamps = [now - 40 * day, now - 31 * day, now - 2 * day, now - day];
      stamps.forEach((createdAtMs, i) => {
        table.append({ id: `r${i}`, sessionId: 's1', createdAtMs, kind: 'session.detached', pid: 1 });
      });
      expect(table.prune(1000, 30, now)).toBe(2);
      expect(table.recent({ limit: 10 }).map((event) => event.id)).toEqual(['r3', 'r2']);
      expect(table.recent({ beforeMs: now - day }).map((event) => event.id)).toEqual(['r2']);
      expect(raw.pragma('journal_mode', { simple: true })).toBe('wal');
    } finally {
      raw.close();
    }
  });
});
