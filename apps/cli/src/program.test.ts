import { AgentermClient, type SessionRecord } from '@agenterm/core';
import { afterEach, describe, expect, it } from 'vitest';
import { buildProgram, formatAge, resolveSessionId, statusLabel, table } from './program.js';

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: '11111111-2222-3333-4444-555555555555',
    agentId: 'claude',
    provider: 'claude',
    title: 'fix login',
    cwd: '/repo',
    worktreeRoot: '/repo',
    branch: 'main',
    origin: 'spawned',
    parentSessionId: null,
    commandLine: ['claude'],
    resolvedBinaryPath: '/bin/claude',
    pid: 4321,
    lifecycle: 'running',
    overlay: 'unknown',
    overlaySource: 'pty',
    cols: 80,
    rows: 24,
    startedAtMs: Date.now() - 90_000,
    endedAtMs: null,
    exitCode: null,
    exitSignal: null,
    ...overrides
  };
}

type Call = { method: string; path: string; body: unknown };

function harness(routes: Record<string, unknown>, answers: string[] = []) {
  const calls: Call[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    calls.push({
      method,
      path: url.pathname + url.search,
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body))
    });
    const key = `${method} ${url.pathname}`;
    const body = routes[key];
    if (body === undefined) {
      return new Response(JSON.stringify({ error: { code: 'not_found', message: `no route ${key}` } }), {
        status: 404
      });
    }
    if (body instanceof Response) return body;
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  const client = new AgentermClient({ baseUrl: 'http://127.0.0.1:1', token: 't', fetchImpl });
  const program = buildProgram({
    client: () => client,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    write: (data) => out.push(data),
    ask: async () => answers.shift() ?? '',
    sleep: async () => undefined
  });
  program.exitOverride();
  const run = (...args: string[]) => program.parseAsync(['node', 'agenterm', ...args]);
  return { run, calls, out, err, client };
}

afterEach(() => {
  process.exitCode = 0;
});

describe('helpers', () => {
  it('formats ages, tables, and status labels', () => {
    expect(formatAge(0, 45_000)).toBe('45s');
    expect(formatAge(0, 3 * 3600_000)).toBe('3h');
    expect(
      table([
        ['A', 'BB'],
        ['CCC', 'D']
      ])
    ).toEqual(['A    BB', 'CCC  D']);
    expect(statusLabel(session({ overlay: 'waiting_permission' }))).toBe('waiting permission');
    expect(statusLabel(session({ lifecycle: 'exited', exitCode: 2 }))).toBe('exited (2)');
    expect(statusLabel(session({ lifecycle: 'killed', exitCode: 0, exitSignal: 'SIGTERM' }))).toBe('killed (SIGTERM)');
  });

  it('resolves unique id prefixes and rejects ambiguous ones', async () => {
    const a = session();
    const b = session({ id: '11119999-2222-3333-4444-555555555555', title: 'other' });
    const { client } = harness({ 'GET /sessions': { sessions: [a, b] } });
    expect((await resolveSessionId(client, '1111111')).id).toBe(a.id);
    await expect(resolveSessionId(client, '1111')).rejects.toThrow(/ambiguous/);
    await expect(resolveSessionId(client, 'ffff')).rejects.toThrow(/no session/);
  });
});

describe('commands', () => {
  it('lists sessions as a table', async () => {
    const { run, out } = harness({ 'GET /sessions': { sessions: [session()] } });
    await run('list');
    expect(out[0]).toMatch(/^ID\s+STATUS\s+AGENT/);
    expect(out[1]).toContain('11111111');
    expect(out[1]).toContain('fix login');
  });

  it('asks before killing and sends killTree only after yes', async () => {
    const live = session();
    const declined = harness({ 'GET /sessions': { sessions: [live] } }, ['n']);
    await declined.run('kill', '1111');
    expect(declined.calls.some((call) => call.method === 'DELETE')).toBe(false);
    const accepted = harness(
      {
        'GET /sessions': { sessions: [live] },
        [`DELETE /sessions/${live.id}`]: { detached: false, killed: true, pid: 4321 }
      },
      ['y']
    );
    await accepted.run('kill', '1111');
    expect(accepted.calls.find((call) => call.method === 'DELETE')?.body).toEqual({ killTree: true });
    expect(accepted.out).toContain('killed pid 4321');
  });

  it('requires the typed pid to kill an attached session', async () => {
    const attached = session({ origin: 'attached' });
    const wrong = harness({ 'GET /sessions': { sessions: [attached] } }, ['999']);
    await wrong.run('kill', '1111');
    expect(wrong.err.join('\n')).toContain('pid did not match');
    const right = harness(
      {
        'GET /sessions': { sessions: [attached] },
        [`DELETE /sessions/${attached.id}`]: { detached: false, killed: true, pid: 4321 }
      },
      ['4321']
    );
    await right.run('kill', '1111');
    expect(right.calls.find((call) => call.method === 'DELETE')?.body).toEqual({ killTree: true, confirmPid: 4321 });
  });

  it('prints API errors with their hint and sets the exit code', async () => {
    const live = session();
    const { run, err } = harness({
      'GET /sessions': { sessions: [live] },
      [`DELETE /sessions/${live.id}`]: new Response(
        JSON.stringify({
          error: { code: 'session_running', message: 'session is still running', hint: 'Kill it first.' }
        }),
        { status: 409 }
      )
    });
    await run('close', '1111');
    expect(err).toEqual(['error: session is still running', 'hint: Kill it first.']);
    expect(process.exitCode).toBe(1);
  });

  it('follows logs until the session stops being live', async () => {
    const live = session();
    let page = 0;
    const pages = [
      { chunks: [{ seq: 1, data: 'a', createdAtMs: 0 }], resumeAfterSeq: 1, hasMore: false, firstSeq: 1, live: true },
      { chunks: [{ seq: 2, data: 'b', createdAtMs: 0 }], resumeAfterSeq: 2, hasMore: false, firstSeq: 1, live: false }
    ];
    const routes: Record<string, unknown> = { 'GET /sessions': { sessions: [live] } };
    const logs = harness(routes);
    Object.defineProperty(routes, `GET /sessions/${live.id}/output`, {
      get: () => new Response(JSON.stringify(pages[Math.min(page++, pages.length - 1)]), { status: 200 }),
      enumerable: true
    });
    await logs.run('logs', '1111', '--follow');
    expect(logs.out.join('')).toBe('ab');
    expect(logs.calls.filter((call) => call.path.includes('/output'))[1]?.path).toContain('sinceSeq=1');
  });
});
