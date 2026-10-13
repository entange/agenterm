import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { describe, expect, it } from 'vitest';
import { headers, rig } from './helpers.js';

describe('spawn environment', () => {
  it('inherits the login env and strips Electron internals', async () => {
    const { spawn, last } = rig();
    await spawn({ env: { EXTRA: '1' } });
    const env = last()?.spawnEnv ?? {};
    expect(env['HOME']).toBe('/home/agent');
    expect(env['USER']).toBe('agent');
    expect(env['EXTRA']).toBe('1');
    expect(env['TERM']).toBe('xterm-256color');
    expect(env['ELECTRON_RUN_AS_NODE']).toBe(undefined);
    expect(env['AGENTERM_SESSION_ID']).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('kill, signal, and close', () => {
  it('kills a live tree, keeps the row as history, and records the exit once', async () => {
    const { app, spawn, store, seen, killed } = rig();
    const session = await spawn();
    const res = await app.inject({
      method: 'DELETE',
      url: `/sessions/${session.id}`,
      headers,
      payload: { killTree: true }
    });
    expect(res.json()).toEqual({ detached: false, killed: true, pid: session.pid });
    expect(killed).toEqual([session.pid]);
    const row = store.get(session.id);
    expect(row?.lifecycle).toBe('killed');
    expect(row?.exitCode).toBe(137);
    expect(seen.filter((event) => event.kind === 'session.exited')).toHaveLength(1);
  });

  it('never signals a session whose leader already exited', async () => {
    const { app, spawn, last, killed } = rig();
    const session = await spawn();
    last()?.emitExit(0);
    const signal = await app.inject({
      method: 'POST',
      url: `/sessions/${session.id}/signal`,
      headers,
      payload: { signal: 'kill' }
    });
    expect(signal.statusCode).toBe(409);
    const kill = await app.inject({
      method: 'DELETE',
      url: `/sessions/${session.id}`,
      headers,
      payload: { killTree: true }
    });
    expect(kill.statusCode).toBe(200);
    expect((kill.json() as { killed: boolean }).killed).toBe(false);
    expect(killed).toEqual([]);
  });

  it('sends interrupt as Ctrl+C through the PTY', async () => {
    const { app, spawn, last } = rig();
    const session = await spawn();
    const res = await app.inject({
      method: 'POST',
      url: `/sessions/${session.id}/signal`,
      headers,
      payload: { signal: 'interrupt' }
    });
    expect(res.statusCode).toBe(200);
    expect(last()?.written).toEqual(['\x03']);
  });

  it('requires confirmPid to kill or terminate an attached session', async () => {
    const { app } = rig({
      lister: async () => [{ pid: 4242, ppid: 1, command: 'codex', cwd: '/tmp' }],
      pidAlive: () => true
    });
    const attached = await app.inject({ method: 'POST', url: '/sessions/attach', headers, payload: { pid: 4242 } });
    const id = (attached.json() as { session: { id: string; provider: string } }).session.id;
    expect((attached.json() as { session: { provider: string } }).session.provider).toBe('codex');
    const noConfirm = await app.inject({
      method: 'DELETE',
      url: `/sessions/${id}`,
      headers,
      payload: { killTree: true }
    });
    expect(noConfirm.statusCode).toBe(403);
    const wrong = await app.inject({
      method: 'POST',
      url: `/sessions/${id}/signal`,
      headers,
      payload: { signal: 'terminate', confirmPid: 1 }
    });
    expect(wrong.statusCode).toBe(403);
    const detach = await app.inject({
      method: 'DELETE',
      url: `/sessions/${id}`,
      headers,
      payload: { killTree: false }
    });
    expect(detach.json()).toEqual({ detached: true, killed: false, pid: 4242 });
  });

  it('marks attached sessions exited when their pid disappears', async () => {
    let alive = true;
    const { app, store } = rig({
      lister: async () => [{ pid: 4343, ppid: 1, command: 'claude', cwd: '/tmp' }],
      pidAlive: () => alive,
      livenessIntervalMs: 20
    });
    const attached = await app.inject({ method: 'POST', url: '/sessions/attach', headers, payload: { pid: 4343 } });
    const id = (attached.json() as { session: { id: string } }).session.id;
    alive = false;
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(store.get(id)?.lifecycle).toBe('exited');
    await app.close();
  });
});

describe('rename, restart, and history', () => {
  it('renames a session and publishes session.updated', async () => {
    const { app, spawn, seen } = rig();
    const session = await spawn();
    const res = await app.inject({
      method: 'PATCH',
      url: `/sessions/${session.id}`,
      headers,
      payload: { title: '  fix login  ' }
    });
    expect((res.json() as { session: { title: string } }).session.title).toBe('fix login');
    expect(seen.some((event) => event.kind === 'session.updated')).toBe(true);
    const bad = await app.inject({ method: 'PATCH', url: `/sessions/${session.id}`, headers, payload: { title: ' ' } });
    expect(bad.statusCode).toBe(400);
  });

  it('restarts an ended session into a new one and refuses while running', async () => {
    const { app, spawn, last, store } = rig();
    const session = await spawn({ args: ['hi'], title: 'echo hi' });
    const running = await app.inject({ method: 'POST', url: `/sessions/${session.id}/restart`, headers, payload: {} });
    expect(running.statusCode).toBe(409);
    last()?.emitExit(0);
    const res = await app.inject({ method: 'POST', url: `/sessions/${session.id}/restart`, headers, payload: {} });
    expect(res.statusCode).toBe(201);
    const fresh = (res.json() as { session: { id: string; title: string; commandLine: string[] } }).session;
    expect(fresh.id).not.toBe(session.id);
    expect(fresh.title).toBe('echo hi');
    expect(fresh.commandLine).toEqual(['/bin/echo', 'hi']);
    expect(store.get(session.id)).toBe(null);
  });

  it('replays the original env on restart', async () => {
    const { app, spawn, last } = rig();
    const session = await spawn({ env: { EXTRA: 'kept' } });
    last()?.emitExit(0);
    const res = await app.inject({ method: 'POST', url: `/sessions/${session.id}/restart`, headers, payload: {} });
    expect(res.statusCode).toBe(201);
    expect(last()?.spawnEnv['EXTRA']).toBe('kept');
  });

  it('serves scrollback from terminal.log after the PTY is forgotten', async () => {
    const { app, spawn, last, pty, dataDir } = rig();
    const session = await spawn();
    last()?.emitData('line one\r\nline two\r\n');
    last()?.emitExit(0);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fs.existsSync(path.join(dataDir, 'sessions', session.id, 'terminal.log'))).toBe(true);
    await pty.forget(session.id);
    const res = await app.inject({ method: 'GET', url: `/sessions/${session.id}/output`, headers });
    const body = res.json() as { chunks: Array<{ data: string }>; live: boolean };
    expect(body.live).toBe(false);
    expect(body.chunks[0]?.data).toBe('line one\r\nline two\r\n');
  });

  it('removes session files when an ended session is closed', async () => {
    const { app, spawn, last, dataDir } = rig();
    const session = await spawn();
    last()?.emitData('bytes');
    last()?.emitExit(0);
    await app.inject({ method: 'DELETE', url: `/sessions/${session.id}`, headers, payload: { killTree: false } });
    expect(fs.existsSync(path.join(dataDir, 'sessions', session.id))).toBe(false);
  });

  it('lists lifecycle events newest first and never stores terminal bytes', async () => {
    const { app, spawn, last } = rig();
    const session = await spawn();
    last()?.emitData('secret output');
    await app.inject({ method: 'POST', url: `/sessions/${session.id}/input`, headers, payload: { data: 'hunter2\n' } });
    last()?.emitExit(3);
    const res = await app.inject({ method: 'GET', url: `/events?sessionId=${session.id}&limit=10`, headers });
    const kinds = (res.json() as { events: Array<{ kind: string }> }).events.map((event) => event.kind);
    expect(kinds[0]).toBe('session.exited');
    expect(kinds).toContain('session.created');
    expect(kinds).not.toContain('terminal.output');
    expect(kinds).not.toContain('terminal.input');
    const bad = await app.inject({ method: 'GET', url: '/events?limit=9999', headers });
    expect(bad.statusCode).toBe(400);
  });
});

describe('git and files routes', () => {
  it('reports git status, per-file diffs, and watched file changes', async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agenterm-repo-')));
    const git = simpleGit(dir);
    await git.init();
    await git.addConfig('user.name', 't');
    await git.addConfig('user.email', 't@example.com');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
    await git.add('a.txt');
    await git.commit('first');
    const { app, spawn } = rig({ gitReader: async () => ({ branch: 'main', worktreeRoot: dir }) });
    const session = await spawn({ cwd: dir });
    await new Promise((resolve) => setTimeout(resolve, 400));
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\n');
    const status = await app.inject({ method: 'GET', url: `/sessions/${session.id}/git`, headers });
    const body = status.json() as { isDirty: boolean; files: Array<{ path: string; unstaged: string }> };
    expect(body.isDirty).toBe(true);
    expect(body.files).toEqual([{ path: 'a.txt', staged: null, unstaged: 'modified' }]);
    const diff = await app.inject({ method: 'GET', url: `/sessions/${session.id}/git/diff?path=a.txt`, headers });
    expect((diff.json() as { diff: string }).diff).toContain('+two');
    const escape = await app.inject({ method: 'GET', url: `/sessions/${session.id}/git/diff?path=../x`, headers });
    expect(escape.statusCode).toBe(400);
    const deadline = Date.now() + 5000;
    let files: { watching: boolean; changes: Array<{ path: string }> } = { watching: false, changes: [] };
    while (Date.now() < deadline) {
      const res = await app.inject({ method: 'GET', url: `/sessions/${session.id}/files`, headers });
      files = res.json() as typeof files;
      if (files.changes.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(files.watching).toBe(true);
    expect(files.changes[0]?.path).toBe('a.txt');
    await app.close();
  });
});
