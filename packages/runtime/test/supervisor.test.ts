import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { Supervisor } from '../src/supervisor.js';

const stubProbes = {
  processes: async () => [
    { pid: 10, ppid: 1, command: 'agentermd', cpuPercent: 1, rssBytes: 1000 },
    { pid: 11, ppid: 10, command: 'claude', cpuPercent: 5, rssBytes: 2000 },
    { pid: 12, ppid: 11, command: 'npm run dev', cpuPercent: 9, rssBytes: 3000 },
    { pid: 20, ppid: 1, command: 'unrelated', cpuPercent: 0, rssBytes: 500 }
  ],
  sockets: async () => [
    { port: 3000, pid: 12, address: '127.0.0.1' },
    { port: 4000, pid: 20, address: '127.0.0.1' }
  ]
};

describe('Supervisor with stub probes', () => {
  it('builds subtree membership scoped to the leader', async () => {
    const sup = new Supervisor({ probes: stubProbes });
    sup.track('s1', 10);
    await sup.poll();
    expect(sup.subtreePids(10).sort((a, b) => a - b)).toEqual([10, 11, 12]);
    expect(sup.childrenOf(11)).toEqual([12]);
  });

  it('joins listening sockets back to owning sessions', async () => {
    const sup = new Supervisor({ probes: stubProbes });
    sup.track('s1', 10);
    await sup.poll();
    const ports = sup.portsFor('s1');
    expect(ports).toEqual([{ port: 3000, pid: 12, sessionId: 's1', address: '127.0.0.1' }]);
  });

  it('reports port open and close changes', async () => {
    const changes: Array<{ opened: number[]; closed: number[] }> = [];
    let round = 0;
    const sup = new Supervisor({
      probes: {
        processes: stubProbes.processes,
        sockets: async () => (round === 0 ? [] : [{ port: 5000, pid: 11, address: '127.0.0.1' }])
      },
      onPorts: (_id, change) =>
        changes.push({ opened: change.opened.map((p) => p.port), closed: change.closed.map((p) => p.port) })
    });
    sup.track('s1', 10);
    await sup.poll();
    round = 1;
    await sup.poll();
    expect(changes).toEqual([{ opened: [5000], closed: [] }]);
    round = 0;
    await sup.poll();
    expect(changes[1]).toEqual({ opened: [], closed: [5000] });
  });

  it('snapshots carry real pid detail', async () => {
    const sup = new Supervisor({ probes: stubProbes });
    sup.track('s1', 11);
    await sup.poll();
    const rows = sup.snapshot('s1');
    expect(rows.map((r) => r.pid)).toEqual([11, 12]);
    expect(rows[0]?.command).toBe('claude');
    expect(rows[0]?.ppid).toBe(10);
  });

  it('untrack clears session state', async () => {
    const sup = new Supervisor({ probes: stubProbes });
    sup.track('s1', 10);
    await sup.poll();
    sup.untrack('s1');
    expect(sup.snapshot('s1')).toEqual([]);
    expect(sup.portsFor('s1')).toEqual([]);
  });
});

describe('Supervisor killTree with a live sleeper', () => {
  it('ends the leader and frees it', async () => {
    const child = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
    const sup = new Supervisor({ intervalMs: 50 });
    sup.track('live', child.pid ?? 0);
    await sup.poll();
    const signaled = await sup.killTree(child.pid ?? 0);
    expect(signaled).toContain(child.pid ?? 0);
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    sup.stop();
    sup.untrack('live');
  }, 15000);

  it('returns empty for an already-dead pid', async () => {
    const sup = new Supervisor({ probes: { processes: async () => [], sockets: async () => [] } });
    const gone = await sup.killTree(4_100_000);
    expect(gone).toEqual([]);
  });
});
