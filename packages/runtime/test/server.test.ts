import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TaskRecord } from '@agenterm/core';
import { OutsideScanner, type ProcRow } from '../src/outside.js';
import { projectOf } from '../src/project.js';
import { createApp, shellFor, slugOf } from '../src/server.js';
import { TaskStore } from '../src/taskStore.js';
import { headers, rig, TOKEN } from './helpers.js';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('health and auth', () => {
  it('returns liveness without auth and detail with it', async () => {
    const app = createApp({ token: TOKEN, port: 37241, store: new TaskStore() });
    const open = (await app.inject({ method: 'GET', url: '/health' })).json() as Record<string, unknown>;
    expect(open['ok']).toBe(true);
    expect(open['port']).toBe(undefined);
    const detail = (await app.inject({ method: 'GET', url: '/health', headers })).json() as Record<string, unknown>;
    expect(detail['port']).toBe(37241);
    expect(detail['running']).toBe(0);
    await app.close();
  });

  it('rejects a wrong token on every other route', async () => {
    const app = createApp({ token: TOKEN, port: 37241, store: new TaskStore() });
    const wrong = { authorization: `Bearer ${TOKEN.replace(/.$/, 'x')}` };
    expect((await app.inject({ method: 'GET', url: '/tasks', headers: wrong })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/settings' })).statusCode).toBe(401);
    await app.close();
  });
});

describe('run', () => {
  it('runs the command through the shell with the caller env and a readable id', async () => {
    const r = rig();
    const { task, alreadyRunning } = await r.run({ env: { PATH: '/caller/bin', SHELL: '/bin/bash', EXTRA: '1' } });
    expect(alreadyRunning).toBe(false);
    expect(task.id).toMatch(/^npm-run-dev-[0-9a-f]{4}$/);
    expect(task.title).toBe('npm run dev');
    expect(task.status).toBe('running');
    const fake = r.last();
    expect(fake?.file).toBe('/bin/bash');
    expect(fake?.spawnArgs).toEqual(['-c', 'npm run dev']);
    expect(fake?.spawnEnv['PATH']).toBe('/caller/bin');
    expect(fake?.spawnEnv['EXTRA']).toBe('1');
    expect(fake?.spawnEnv['HOME']).toBe(undefined);
    expect(fake?.spawnEnv['AGENTERM_TASK_ID']).toBe(task.id);
    expect(fake?.spawnEnv['TERM']).toBe('xterm-256color');
  });

  it('falls back to the daemon env and strips Electron internals', async () => {
    const r = rig();
    await r.run();
    const env = r.last()?.spawnEnv ?? {};
    expect(env['HOME']).toBe('/home/agent');
    expect(env['ELECTRON_RUN_AS_NODE']).toBe(undefined);
    expect(r.last()?.file).toBe('/bin/zsh');
  });

  it('records who started it and the project', async () => {
    const r = rig({ gitReader: async () => ({ branch: 'main', worktreeRoot: '/work/shop' }) });
    const task = await r.spawn({ startedBy: 'claude', startedByPid: 4242, title: 'web server' });
    expect(task).toMatchObject({
      title: 'web server',
      startedBy: 'claude',
      startedByPid: 4242,
      project: 'shop',
      projectRoot: '/work/shop',
      branch: 'main'
    });
    expect(task.id).toMatch(/^web-server-/);
  });

  it('masks secrets in the stored command', async () => {
    const r = rig();
    const task = await r.spawn({ command: 'deploy --token=ghp_abcdefghijklmnop1234' });
    expect(task.command).toBe('deploy --token=[REDACTED]');
    expect(r.last()?.spawnArgs[1]).toBe('deploy --token=ghp_abcdefghijklmnop1234');
  });

  it('rejects a missing folder and bad ids', async () => {
    const r = rig();
    const missing = await r.app.inject({
      method: 'POST',
      url: '/tasks',
      headers,
      payload: { command: 'ls', cwd: '/definitely/not/here' }
    });
    expect((missing.json() as { error: { code: string } }).error.code).toBe('invalid_cwd');
    const bad = await r.app.inject({
      method: 'POST',
      url: '/tasks',
      headers,
      payload: { command: 'ls', cwd: '/', id: 'a b' }
    });
    expect(bad.statusCode).toBe(400);
  });
});

describe('one task per id or command', () => {
  it('returns the running task for the same id instead of starting another', async () => {
    const r = rig();
    const first = await r.run({ id: 'Web' });
    expect(first.task.id).toBe('web');
    const second = await r.run({ id: 'web', command: 'something else' });
    expect(second.alreadyRunning).toBe(true);
    expect(second.task.command).toBe('npm run dev');
    expect(r.fakes).toHaveLength(1);
  });

  it('returns the running task for the same command in the same folder', async () => {
    const r = rig();
    const first = await r.run();
    const again = await r.run();
    expect(again.alreadyRunning).toBe(true);
    expect(again.task.id).toBe(first.task.id);
    const elsewhere = await r.run({ cwd: '/' });
    expect(elsewhere.alreadyRunning).toBe(false);
    expect(r.fakes).toHaveLength(2);
  });

  it('starts one task when two identical runs race', async () => {
    const r = rig();
    const [a, b] = await Promise.all([r.run({ id: 'api' }), r.run({ id: 'api' })]);
    expect(r.fakes).toHaveLength(1);
    expect([a.alreadyRunning, b.alreadyRunning].sort()).toEqual([false, true]);
    const [c, d] = await Promise.all([r.run({ command: 'make watch' }), r.run({ command: 'make watch' })]);
    expect(c.task.id).toBe(d.task.id);
    expect(r.fakes).toHaveLength(2);
  });

  it('restart replaces the running task and keeps its id', async () => {
    const r = rig();
    const first = await r.run({ id: 'web' });
    r.last()?.emitData('old output');
    const second = await r.run({ id: 'web', restart: true, command: 'npm start' });
    expect(second.alreadyRunning).toBe(false);
    expect(second.task.id).toBe('web');
    expect(second.task.command).toBe('npm start');
    expect(second.task.pid).not.toBe(first.task.pid);
    expect(r.fakes[0]?.written).toEqual(['\x03']);
    const out = (await r.app.inject({ method: 'GET', url: '/tasks/web/output', headers })).json() as {
      chunks: Array<{ data: string }>;
    };
    expect(out.chunks).toEqual([]);
    const byCommand = await r.run({ command: 'npm start', restart: true });
    expect(byCommand.task.id).toBe('web');
    expect(r.fakes).toHaveLength(3);
  });

  it('reuses the id of a task that already ended', async () => {
    const r = rig();
    await r.run({ id: 'build' });
    r.last()?.emitExit(0);
    const again = await r.run({ id: 'build' });
    expect(again.alreadyRunning).toBe(false);
    expect(again.task.status).toBe('running');
    expect(r.store.list()).toHaveLength(1);
  });
});

describe('exit, stop, and remove', () => {
  it('records finished and failed exits', async () => {
    const r = rig();
    const ok = await r.spawn({ id: 'ok' });
    r.last()?.emitExit(0);
    const bad = await r.spawn({ id: 'bad' });
    r.last()?.emitExit(2);
    expect(r.store.get(ok.id)).toMatchObject({ status: 'exited', exitCode: 0 });
    expect(r.store.get(bad.id)).toMatchObject({ status: 'failed', exitCode: 2 });
    expect(r.seen.filter((event) => event.kind === 'task.updated')).toHaveLength(4);
  });

  it('stops with Ctrl+C first and records stopped', async () => {
    const r = rig();
    const task = await r.spawn();
    const res = await r.app.inject({ method: 'POST', url: `/tasks/${task.id}/stop`, headers });
    expect((res.json() as { task: TaskRecord }).task.status).toBe('stopped');
    expect(r.last()?.written).toEqual(['\x03']);
    expect(r.killed).toEqual([]);
  });

  it('terminates the tree when Ctrl+C is ignored, or right away with force', async () => {
    const r = rig({ ignoreInterrupt: true });
    const a = await r.spawn({ id: 'a' });
    await r.app.inject({ method: 'POST', url: '/tasks/a/stop', headers });
    expect(r.killed).toEqual([{ pid: a.pid, force: false }]);
    expect(r.store.get('a')?.status).toBe('stopped');
    const b = await r.spawn({ id: 'b' });
    await r.app.inject({ method: 'POST', url: '/tasks/b/stop', headers, payload: { force: true } });
    expect(r.killed[1]).toEqual({ pid: b.pid, force: true });
    expect(r.fakes[1]?.written).toEqual([]);
  });

  it('removes a running task: stops it, deletes the row and its files', async () => {
    const r = rig();
    const task = await r.spawn();
    r.last()?.emitData('bytes');
    expect(fs.existsSync(path.join(r.dataDir, 'tasks', task.id))).toBe(true);
    const res = await r.app.inject({ method: 'DELETE', url: `/tasks/${task.id}`, headers });
    expect(res.json()).toEqual({ removed: true, stopped: true });
    expect(r.store.get(task.id)).toBe(null);
    expect(r.table.get(task.id)).toBe(null);
    expect(fs.existsSync(path.join(r.dataDir, 'tasks', task.id))).toBe(false);
    expect(r.seen.at(-1)).toEqual({ kind: 'task.removed', taskId: task.id });
    expect((await r.app.inject({ method: 'GET', url: `/tasks/${task.id}`, headers })).statusCode).toBe(404);
  });

  it('clear removes only ended tasks', async () => {
    const r = rig();
    await r.spawn({ id: 'done' });
    r.last()?.emitExit(0);
    await r.spawn({ id: 'live' });
    const res = await r.app.inject({ method: 'POST', url: '/tasks/clear', headers });
    expect(res.json()).toEqual({ removed: ['done'] });
    expect(r.store.list().map((task) => task.id)).toEqual(['live']);
  });
});

describe('terminal', () => {
  it('takes input and resize while running, and refuses both after', async () => {
    const r = rig();
    const task = await r.spawn();
    const input = await r.app.inject({
      method: 'POST',
      url: `/tasks/${task.id}/input`,
      headers,
      payload: { data: 'y\r' }
    });
    expect(input.json()).toEqual({ acceptedBytes: 2 });
    expect(r.last()?.written).toEqual(['y\r']);
    const resize = await r.app.inject({
      method: 'POST',
      url: `/tasks/${task.id}/resize`,
      headers,
      payload: { cols: 100, rows: 40 }
    });
    expect((resize.json() as { task: TaskRecord }).task).toMatchObject({ cols: 100, rows: 40 });
    r.last()?.emitExit(0);
    const late = await r.app.inject({
      method: 'POST',
      url: `/tasks/${task.id}/input`,
      headers,
      payload: { data: 'x' }
    });
    expect((late.json() as { error: { code: string } }).error.code).toBe('not_running');
  });

  it('pages live output and serves ended output from disk', async () => {
    const r = rig();
    const task = await r.spawn();
    r.last()?.emitData('one\r\n');
    r.last()?.emitData('two\r\n');
    const page = (
      await r.app.inject({ method: 'GET', url: `/tasks/${task.id}/output?sinceSeq=1`, headers })
    ).json() as {
      chunks: Array<{ seq: number; data: string }>;
      live: boolean;
    };
    expect(page.chunks).toEqual([expect.objectContaining({ seq: 2, data: 'two\r\n' })]);
    expect(page.live).toBe(true);
    r.last()?.emitExit(0);
    await wait(80);
    expect(r.pty.get(task.id)?.log.isReleased()).toBe(true);
    const ended = (await r.app.inject({ method: 'GET', url: `/tasks/${task.id}/output`, headers })).json() as {
      chunks: Array<{ data: string }>;
      live: boolean;
    };
    expect(ended.live).toBe(false);
    expect(ended.chunks[0]?.data).toBe('one\r\ntwo\r\n');
  });
});

describe('processes outside agenterm', () => {
  const row = (pid: number, ppid: number, args: string, uid = process.getuid?.() ?? 501): ProcRow => ({
    pid,
    ppid,
    uid,
    elapsedSeconds: 60,
    tty: null,
    cpuPercent: 0,
    rssBytes: 0,
    comm: args.split(' ')[0] ?? '',
    args
  });
  const outside = new OutsideScanner({
    ownPids: [],
    gitReader: async () => ({ branch: null, worktreeRoot: null }),
    probes: {
      processes: async () => [row(1, 0, '/sbin/launchd', 0), row(40, 1, 'node left-behind.js')],
      sockets: async () => [{ port: 4000, pid: 40, address: '127.0.0.1' }],
      launchdJobs: async () => null,
      isService: () => false,
      cwds: async () => new Map([[40, '/work/api']])
    }
  });

  it('lists them and refuses to stop a pid that is not one of them', async () => {
    const app = createApp({ token: TOKEN, port: 37241, store: new TaskStore(), outside });
    const list = (await app.inject({ method: 'GET', url: '/processes', headers })).json() as {
      processes: Array<Record<string, unknown>>;
    };
    expect(list.processes).toEqual([
      expect.objectContaining({ pid: 40, orphaned: true, ports: [4000], cwd: '/work/api', project: 'api' })
    ]);
    const unknown = await app.inject({ method: 'POST', url: '/processes/41/stop', headers, payload: {} });
    expect(unknown.statusCode).toBe(404);
    expect((unknown.json() as { error: { code: string } }).error.code).toBe('unknown_process');
    const bad = await app.inject({ method: 'POST', url: '/processes/abc/stop', headers, payload: {} });
    expect(bad.statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/processes' })).statusCode).toBe(401);
    await app.close();
  });
});

describe('settings', () => {
  it('keeps tasks running by default and persists the setting', async () => {
    const r = rig();
    expect((await r.app.inject({ method: 'GET', url: '/settings', headers })).json()).toEqual({ stopWithAgent: false });
    const patched = await r.app.inject({
      method: 'PATCH',
      url: '/settings',
      headers,
      payload: { stopWithAgent: true }
    });
    expect(patched.json()).toEqual({ stopWithAgent: true });
    expect(JSON.parse(fs.readFileSync(path.join(r.dataDir, 'settings.json'), 'utf8'))).toEqual({ stopWithAgent: true });
    const bad = await r.app.inject({ method: 'PATCH', url: '/settings', headers, payload: { stopWithAgent: 'yes' } });
    expect(bad.statusCode).toBe(400);
  });

  it('stops a task when its starter exits only when asked to', async () => {
    const alive = new Set<number>([4242]);
    const r = rig({ pidAlive: (pid) => alive.has(pid), livenessIntervalMs: 10 });
    const task = await r.spawn({ startedByPid: 4242 });
    alive.delete(4242);
    await wait(60);
    expect(r.store.get(task.id)?.status).toBe('running');
    await r.app.inject({ method: 'PATCH', url: '/settings', headers, payload: { stopWithAgent: true } });
    await wait(100);
    expect(r.store.get(task.id)?.status).toBe('stopped');
    await r.app.close();
  });
});

describe('scale', () => {
  it('lists hundreds of tasks quickly, running first', async () => {
    const r = rig();
    for (let i = 0; i < 300; i++) await r.spawn({ id: `t${i}` });
    r.fakes[0]?.emitExit(0);
    const started = performance.now();
    const res = await r.app.inject({ method: 'GET', url: '/tasks', headers });
    const tasks = (res.json() as { tasks: TaskRecord[] }).tasks;
    expect(tasks).toHaveLength(300);
    expect(tasks.at(-1)?.id).toBe('t0');
    expect(performance.now() - started).toBeLessThan(200);
  });
});

describe('helpers', () => {
  it('builds ids from the readable part of a command', () => {
    expect(slugOf('npm run dev')).toBe('npm-run-dev');
    expect(slugOf('PORT=3000 /usr/bin/python3 -m http.server 8000')).toBe('python3-http-server-8000');
    expect(slugOf('  ')).toBe('');
  });

  it('names the project after the repo or folder, never home', () => {
    expect(projectOf('/work/shop/web', '/work/shop')).toBe('shop');
    expect(projectOf('/tmp/scratch', null)).toBe('scratch');
    expect(projectOf(os.homedir(), null)).toBe(null);
    expect(projectOf('/', null)).toBe(null);
  });

  it('uses the caller shell only when it is POSIX', () => {
    expect(shellFor('ls', { SHELL: '/bin/zsh' })).toEqual({ file: '/bin/zsh', args: ['-c', 'ls'] });
    expect(shellFor('ls', { SHELL: '/opt/homebrew/bin/fish' }).file).toBe('/bin/sh');
    expect(shellFor('ls', {}).file).toBe('/bin/sh');
  });
});
