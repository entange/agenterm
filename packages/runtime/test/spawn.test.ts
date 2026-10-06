import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentermEvent } from '@agenterm/core';
import { openDatabase, SqliteCommands } from '../src/database.js';
import { EventBus } from '../src/events.js';
import type { PtyHandle } from '../src/ptyManager.js';
import { PtyManager } from '../src/ptyManager.js';
import { createApp } from '../src/server.js';
import { SessionStore } from '../src/sessionStore.js';
import { Supervisor } from '../src/supervisor.js';

const TOKEN = 'test-token-spawn-flow-0123456789abcdef';

interface FakePty extends PtyHandle {
  written: string[];
  emitData: (data: string) => void;
  emitExit: (code: number) => void;
}

function makeFakePty(pid: number): FakePty {
  let dataCb: ((data: string) => void) | null = null;
  let exitCb: ((event: { exitCode: number; signal?: number }) => void) | null = null;
  const fake: FakePty = {
    pid,
    written: [],
    onData: (cb) => {
      dataCb = cb;
    },
    onExit: (cb) => {
      exitCb = cb;
    },
    write: (data) => {
      fake.written.push(data);
    },
    resize: () => undefined,
    kill: () => {
      exitCb?.({ exitCode: 143, signal: 15 });
    },
    emitData: (data) => {
      dataCb?.(data);
    },
    emitExit: (code) => {
      exitCb?.({ exitCode: code });
    }
  };
  return fake;
}

function riggedApp() {
  let pid = 50000;
  let last: FakePty | null = null;
  const pty = new PtyManager({
    spawnFn: (file, args, opts) => {
      last = makeFakePty(pid++);
      void file;
      void args;
      void opts;
      return last;
    }
  });
  const store = new SessionStore();
  const bus = new EventBus();
  const seen: AgentermEvent[] = [];
  bus.onEvent((event) => seen.push(event));
  const supervisor = new Supervisor({
    probes: { processes: async () => [], sockets: async () => [] }
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenterm-spawn-'));
  const opened = openDatabase(path.join(dir, 'test.db'));
  const commandsDb = new SqliteCommands(opened.db);
  const app = createApp({
    token: TOKEN,
    port: 37241,
    store,
    lister: async () => [],
    pty,
    supervisor,
    bus,
    commandsDb,
    gitReader: async () => ({ branch: null, worktreeRoot: null })
  });
  return {
    app,
    pty,
    store,
    bus,
    seen,
    commandsDb,
    lastFake: () => last as FakePty | null
  };
}

const headers = { authorization: `Bearer ${TOKEN}` };

describe('POST /sessions spawn flow', () => {
  it('spawns echo, streams fake output, and pages with resume', async () => {
    const { app, seen, lastFake } = riggedApp();
    const spawnRes = await app.inject({
      method: 'POST',
      url: '/sessions',
      headers,
      payload: {
        provider: 'generic',
        command: '/bin/echo',
        args: ['hello'],
        cwd: '/tmp',
        title: 'echo flow',
        cols: 80,
        rows: 24,
        env: {}
      }
    });
    expect(spawnRes.statusCode).toBe(201);
    const spawned = spawnRes.json() as { session: { id: string; pid: number; origin: string } };
    expect(spawned.session.origin).toBe('spawned');
    expect(seen.map((e) => e.kind)).toContain('session.created');

    const id = spawned.session.id;
    const empty = await app.inject({ method: 'GET', url: `/sessions/${id}/output`, headers });
    expect(empty.statusCode).toBe(200);
    expect((empty.json() as { chunks: unknown[] }).chunks).toEqual([]);

    lastFake()?.emitData('hello-pty-bytes');
    const page = await app.inject({ method: 'GET', url: `/sessions/${id}/output`, headers });
    expect(page.statusCode).toBe(200);
    const pageBody = page.json() as { chunks: Array<{ seq: number; data: string }>; resumeAfterSeq: number | null; hasMore: boolean };
    expect(pageBody.chunks).toHaveLength(1);
    expect(pageBody.chunks[0]?.data).toBe('hello-pty-bytes');
    expect(pageBody.resumeAfterSeq).toBe(1);
    expect(seen.filter((e) => e.kind === 'terminal.output')).toHaveLength(1);

    const resumed = await app.inject({
      method: 'GET',
      url: `/sessions/${id}/output?sinceSeq=1`,
      headers
    });
    expect((resumed.json() as { chunks: unknown[] }).chunks).toEqual([]);
  });

  it('writes input, resizes, and deletes with detach', async () => {
    const { app, pty, store, seen, lastFake } = riggedApp();
    const spawnRes = await app.inject({
      method: 'POST',
      url: '/sessions',
      headers,
      payload: { provider: 'generic', command: '/bin/echo', cwd: '/tmp', env: {} }
    });
    const id = (spawnRes.json() as { session: { id: string } }).session.id;

    const inputRes = await app.inject({
      method: 'POST',
      url: `/sessions/${id}/input`,
      headers,
      payload: { data: 'ping\n' }
    });
    expect(inputRes.statusCode).toBe(200);
    expect(lastFake()?.written).toEqual(['ping\n']);
    expect(seen.map((e) => e.kind)).toContain('terminal.input');

    const resizeRes = await app.inject({
      method: 'POST',
      url: `/sessions/${id}/resize`,
      headers,
      payload: { cols: 120, rows: 30 }
    });
    expect(resizeRes.statusCode).toBe(200);
    expect(store.get(id)?.cols).toBe(120);

    const refused = await app.inject({
      method: 'DELETE',
      url: `/sessions/${id}`,
      headers,
      payload: { killTree: false }
    });
    expect(refused.statusCode).toBe(409);
    expect((refused.json() as { error: { code: string } }).error.code).toBe('session_running');

    lastFake()?.emitExit(0);
    const delRes = await app.inject({
      method: 'DELETE',
      url: `/sessions/${id}`,
      headers,
      payload: { killTree: false }
    });
    expect(delRes.statusCode).toBe(200);
    expect((delRes.json() as { detached: boolean }).detached).toBe(true);
    expect(store.get(id)).toBe(null);
    expect(pty.has(id)).toBe(false);
    expect(seen.map((e) => e.kind)).toContain('session.detached');
  });

  it('records exits and rejects input after exit', async () => {
    const { app, store, seen, lastFake } = riggedApp();
    const spawnRes = await app.inject({
      method: 'POST',
      url: '/sessions',
      headers,
      payload: { provider: 'generic', command: '/bin/echo', cwd: '/tmp', env: {} }
    });
    const id = (spawnRes.json() as { session: { id: string } }).session.id;
    lastFake()?.emitExit(0);
    expect(store.get(id)?.lifecycle).toBe('exited');
    expect(seen.map((e) => e.kind)).toContain('session.exited');

    const inputRes = await app.inject({
      method: 'POST',
      url: `/sessions/${id}/input`,
      headers,
      payload: { data: 'late\n' }
    });
    expect(inputRes.statusCode).toBe(409);
  });

  it('rejects input and output for attached sessions without a PTY', async () => {
    const attachApp = createApp({
      token: TOKEN,
      port: 37241,
      store: new SessionStore(),
      lister: async () => [{ pid: 61001, ppid: 1, command: 'codex', cwd: '/tmp' }],
      pty: new PtyManager(),
      supervisor: new Supervisor({ probes: { processes: async () => [], sockets: async () => [] } }),
      bus: new EventBus(),
      gitReader: async () => ({ branch: null, worktreeRoot: null })
    });
    const attached = await attachApp.inject({
      method: 'POST',
      url: '/sessions/attach',
      headers,
      payload: { pid: 61001 }
    });
    const id = (attached.json() as { session: { id: string } }).session.id;
    const inputRes = await attachApp.inject({
      method: 'POST',
      url: `/sessions/${id}/input`,
      headers,
      payload: { data: 'x\n' }
    });
    expect(inputRes.statusCode).toBe(409);
    const outRes = await attachApp.inject({ method: 'GET', url: `/sessions/${id}/output`, headers });
    expect(outRes.statusCode).toBe(409);
  });

  it('rejects secret env keys', async () => {
    const { app } = riggedApp();
    const res = await app.inject({
      method: 'POST',
      url: '/sessions',
      headers,
      payload: { provider: 'generic', command: '/bin/echo', cwd: '/tmp', env: { ['OPENAI_API_KEY']: 'x' } }
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns missing_binary with a hint', async () => {
    const { app } = riggedApp();
    const res = await app.inject({
      method: 'POST',
      url: '/sessions',
      headers,
      payload: { provider: 'generic', command: '/bin/agenterm-no-such-bin', cwd: '/tmp', env: {} }
    });
    expect(res.statusCode).toBe(404);
    const body = res.json() as { error: { code: string; hint?: string } };
    expect(body.error.code).toBe('missing_binary');
    expect(typeof body.error.hint).toBe('string');
  });

  it('rejects unknown cwd', async () => {
    const { app } = riggedApp();
    const res = await app.inject({
      method: 'POST',
      url: '/sessions',
      headers,
      payload: { provider: 'generic', command: '/bin/echo', cwd: '/tmp/agenterm-no-such-dir', env: {} }
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /sessions/:id/commands', () => {
  it('clusters prompt-anchored output into command rows', async () => {
    const { app, lastFake, commandsDb } = riggedApp();
    const spawnRes = await app.inject({
      method: 'POST',
      url: '/sessions',
      headers,
      payload: { provider: 'generic', command: '/bin/sh', cwd: '/tmp', env: {} }
    });
    expect(spawnRes.statusCode).toBe(201);
    const id = (spawnRes.json() as { session: { id: string } }).session.id;
    lastFake()?.emitData('sh-3.2$ bun test\nok 12 pass\nsh-3.2$ echo done\n');
    const res = await app.inject({ method: 'GET', url: `/sessions/${id}/commands`, headers });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { sessionId: string; commands: Array<{ text: string; durationMs: number | null; exitCode: number | null }> };
    expect(body.sessionId).toBe(id);
    expect(body.commands.map((row) => row.text)).toEqual(['echo done', 'bun test']);
    expect(body.commands[1]?.exitCode).toBe(null);
    expect(commandsDb.forSession(id).length).toBeGreaterThan(0);
  });

  it('rejects bad limits and unknown sessions', async () => {
    const { app } = riggedApp();
    const bad = await app.inject({ method: 'GET', url: '/sessions/00000000-0000-0000-0000-000000000000/commands?limit=9999', headers });
    expect([400, 404].includes(bad.statusCode)).toBe(true);
    const missing = await app.inject({ method: 'GET', url: '/sessions/00000000-0000-0000-0000-000000000000/commands', headers });
    expect(missing.statusCode).toBe(404);
  });
});
