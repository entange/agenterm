import { describe, expect, it } from 'vitest';
import { AgentermClient } from '../src/client.js';

type Call = { method: string; path: string; body: unknown };

function stub(routes: Record<string, unknown>, calls: Call[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    calls.push({ method, path: url.pathname + url.search, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
    const body = routes[`${method} ${url.pathname}`];
    if (body === undefined) {
      return new Response(JSON.stringify({ error: { code: 'unknown_task', message: 'no task matches', hint: 'list first' } }), {
        status: 404
      });
    }
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
}

describe('AgentermClient', () => {
  it('maps task routes', async () => {
    const calls: Call[] = [];
    const task = { id: 'web', pid: 111 };
    const client = new AgentermClient({
      baseUrl: 'http://127.0.0.1:1/',
      token: 't',
      fetchImpl: stub(
        {
          'POST /tasks': { task, alreadyRunning: false },
          'GET /tasks': { tasks: [task] },
          'POST /tasks/web/stop': { task },
          'DELETE /tasks/web': { removed: true, stopped: false },
          'POST /tasks/web/input': { acceptedBytes: 3 },
          'GET /tasks/web/output': { taskId: 'web', chunks: [], resumeAfterSeq: null, hasMore: false, firstSeq: null, live: true },
          'PATCH /settings': { stopWithAgent: true }
        },
        calls
      )
    });
    expect((await client.run({ command: 'npm run dev', cwd: '/tmp' })).task.pid).toBe(111);
    expect((await client.listTasks()).tasks).toHaveLength(1);
    expect((await client.stop('web', { force: true })).task.id).toBe('web');
    expect((await client.remove('web')).removed).toBe(true);
    expect((await client.sendInput('web', { data: 'y\r' })).acceptedBytes).toBe(3);
    await client.output('web', { sinceSeq: 4 });
    expect((await client.updateSettings({ stopWithAgent: true })).stopWithAgent).toBe(true);
    expect(calls.map((call) => `${call.method} ${call.path}`)).toContain('GET /tasks/web/output?sinceSeq=4');
    expect(calls.find((call) => call.path === '/tasks/web/stop')?.body).toEqual({ force: true });
  });

  it('throws readable errors with the code and hint', async () => {
    const client = new AgentermClient({ baseUrl: 'http://127.0.0.1:1', token: 't', fetchImpl: stub({}) });
    await expect(client.getTask('nope')).rejects.toMatchObject({ code: 'unknown_task', hint: 'list first', status: 404 });
  });

  it('turns a daemon that never answers into a timeout error', async () => {
    const fetchImpl = ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      })) as typeof fetch;
    const client = new AgentermClient({ baseUrl: 'http://127.0.0.1:1', token: 't', fetchImpl, timeoutMs: 30 });
    await expect(client.listTasks()).rejects.toMatchObject({ code: 'timeout', status: 504 });
  });
});
