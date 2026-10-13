import { describe, expect, it } from 'vitest';
import { AgentermClient } from '../src/client.js';

function stubFetch(routes: Record<string, unknown>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    const body = routes[path];
    if (body === undefined) {
      return new Response(JSON.stringify({ error: { code: 'not_found', message: 'missing' } }), {
        status: 404,
        headers: { ['Content-Type']: 'application/json' }
      });
    }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { ['Content-Type']: 'application/json' }
    });
  }) as typeof fetch;
}

describe('AgentermClient session methods', () => {
  it('maps spawn, input, resize, signal, output, and delete envelopes', async () => {
    const session = { id: 's1', pid: 111 };
    const client = new AgentermClient({
      baseUrl: 'http://127.0.0.1:1',
      token: 't',
      fetchImpl: stubFetch({
        ['/sessions']: { session },
        [`/sessions/s1/input`]: { acceptedBytes: 5 },
        [`/sessions/s1/resize`]: { cols: 120, rows: 30 },
        [`/sessions/s1/signal`]: { signaled: true, pid: 111, signal: 'interrupt' },
        [`/sessions/s1/output`]: { sessionId: 's1', chunks: [], resumeAfterSeq: null, hasMore: false },
        [`/sessions/s1/processes`]: { sessionId: 's1', processes: [], sampledAtMs: 0 },
        [`/sessions/s1/ports`]: { sessionId: 's1', ports: [], sampledAtMs: 0 },
        [`/sessions/s1`]: { detached: true, killed: false, pid: 111 }
      })
    });
    const spawned = await client.spawn({ provider: 'generic', command: '/bin/echo', cwd: '/tmp' });
    expect(spawned.session.pid).toBe(111);
    expect((await client.sendInput('s1', { data: 'hi' })).acceptedBytes).toBe(5);
    expect((await client.resize('s1', { cols: 120, rows: 30 })).cols).toBe(120);
    expect((await client.signal('s1', { signal: 'interrupt' })).signaled).toBe(true);
    expect((await client.output('s1')).chunks).toEqual([]);
    expect((await client.processes('s1')).processes).toEqual([]);
    expect((await client.ports('s1')).ports).toEqual([]);
    expect((await client.deleteSession('s1', { killTree: false })).detached).toBe(true);
  });

  it('throws readable errors on failure envelopes', async () => {
    const client = new AgentermClient({
      baseUrl: 'http://127.0.0.1:1',
      token: 't',
      fetchImpl: stubFetch({})
    });
    await expect(client.spawn({ provider: 'generic', command: 'x', cwd: '/tmp' })).rejects.toThrow('missing');
  });
});

describe('client timeouts', () => {
  it('turns a daemon that never answers into a timeout error', async () => {
    const fetchImpl = ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      })) as typeof fetch;
    const client = new AgentermClient({ baseUrl: 'http://127.0.0.1:1', token: 't', fetchImpl, timeoutMs: 30 });
    await expect(client.listSessions()).rejects.toMatchObject({ code: 'timeout', status: 504 });
  });
});
