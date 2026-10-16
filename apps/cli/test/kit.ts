import { AgentermClient, type OutsideProcess } from '@agenterm/core';
import { rig, type FakePty } from '../../../packages/runtime/test/helpers.js';
import type { TaskStore } from '../../../packages/runtime/src/taskStore.js';

export interface DaemonRig {
  client: AgentermClient;
  store: TaskStore;
  fakes: FakePty[];
  last: () => FakePty | undefined;
}

/**
 * A real daemon app (fake terminals, temp data dir) reached through the
 * real client, so CLI and MCP tests exercise the same HTTP contract.
 */
export function daemonRig(options: Parameters<typeof rig>[0] = {}): DaemonRig {
  const r = rig(options);
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const res = await r.app.inject({
      method: (init?.method ?? 'GET') as 'GET',
      url: url.pathname + url.search,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      ...(init?.body === undefined ? {} : { payload: String(init.body) })
    });
    return new Response(res.statusCode === 204 ? null : res.body, {
      status: res.statusCode,
      headers: { 'content-type': 'application/json' }
    });
  }) as typeof fetch;
  const client = new AgentermClient({
    baseUrl: 'http://127.0.0.1:1',
    token: 'test-token-helpers-0123456789abcdef',
    fetchImpl
  });
  return { client, store: r.store, fakes: r.fakes, last: r.last };
}

/** A command outside agenterm, as the daemon lists it. */
export function outsideProcess(overrides: Partial<OutsideProcess> = {}): OutsideProcess {
  return {
    pid: 4821,
    pids: [4821, 4822],
    name: 'node',
    command: 'node server.js --port 4000',
    cwd: '/work/api',
    project: 'api',
    startedBy: null,
    startedByPid: null,
    orphaned: true,
    hidden: false,
    tty: null,
    ports: [4000],
    cpuPercent: 1.4,
    memoryBytes: 52 * 1024 * 1024,
    startedAtMs: Date.now() - 2 * 3600_000,
    ...overrides
  };
}

/** Stands in for the daemon's process scanner: lists these, records what was stopped. */
export function fakeOutside(processes: OutsideProcess[]) {
  const stopped: Array<{ pid: number; force: boolean }> = [];
  const outside = {
    list: async () => ({ processes, scannedAtMs: Date.now() }),
    stop: async (pid: number, options: { force?: boolean } = {}) => {
      const found = processes.find((entry) => entry.pid === pid);
      if (found === undefined) {
        return { ok: false as const, status: 404, code: 'unknown_process', message: `pid ${pid} is not listed` };
      }
      stopped.push({ pid, force: options.force === true });
      return { ok: true as const, process: found, exited: true };
    }
  };
  return { outside, stopped };
}
