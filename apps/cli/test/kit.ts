import { AgentermClient } from '@agenterm/core';
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
