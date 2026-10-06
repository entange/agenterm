import { describe, expect, it } from 'vitest';
import { AgentHooks } from '../src/agentHooks.js';
import { Supervisor } from '../src/supervisor.js';
import { headers, rig } from './helpers.js';

describe('review regressions', () => {
  it('keeps the user OTEL configuration from the login env', async () => {
    const r = rig({
      hooks: new AgentHooks({ port: 1 }),
      baseEnv: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318' }
    });
    await r.spawn({ provider: 'claude', command: '/bin/echo' });
    const env = r.last()?.spawnEnv ?? {};
    expect(env['OTEL_EXPORTER_OTLP_ENDPOINT']).toBe('http://collector:4318');
    expect(env['OTEL_EXPORTER_OTLP_LOGS_ENDPOINT']).toBe(undefined);
  });

  it('refuses to restart a command line that held a redacted secret', async () => {
    const r = rig();
    const session = await r.spawn({ args: ['--token', 'sk-abcdefghijklmnopqrstuv'] });
    r.last()?.emitExit(0);
    const res = await r.app.inject({ method: 'POST', url: `/sessions/${session.id}/restart`, headers, payload: {} });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe('restart_unsafe');
  });

  it('only treats real answers as answering a permission prompt', async () => {
    const hooks = new AgentHooks({ port: 1 });
    const r = rig({ hooks });
    const session = await r.spawn({ provider: 'claude', command: '/bin/echo' });
    r.store.setOverlay(session.id, 'waiting_permission', 'hooks');
    const send = (data: string) =>
      r.app.inject({ method: 'POST', url: `/sessions/${session.id}/input`, headers, payload: { data } });
    await send('\x1b[I');
    await send('\x1b[B');
    expect(r.store.get(session.id)?.overlay).toBe('waiting_permission');
    await send('1');
    expect(r.store.get(session.id)?.overlay).toBe('working');
  });

  it('keeps the previous snapshot when a probe fails', async () => {
    let fail = false;
    const opened: number[] = [];
    const closed: number[] = [];
    const supervisor = new Supervisor({
      probes: {
        processes: async () => {
          if (fail) throw new Error('ps timed out');
          return [{ pid: 10, ppid: 1, command: 'srv', cpuPercent: 0, rssBytes: 0 }];
        },
        sockets: async () => [{ port: 3000, pid: 10, address: '127.0.0.1' }]
      },
      onPorts: (_id, change) => {
        opened.push(...change.opened.map((p) => p.port));
        closed.push(...change.closed.map((p) => p.port));
      }
    });
    supervisor.track('s', 10);
    await supervisor.poll();
    fail = true;
    await supervisor.poll();
    expect(opened).toEqual([3000]);
    expect(closed).toEqual([]);
    expect(supervisor.portsFor('s').map((p) => p.port)).toEqual([3000]);
  });
});
