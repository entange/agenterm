import { AgentermClient, type SessionRecord } from '@agenterm/core';
import { describe, expect, it } from 'vitest';
import { handleMcpMessage, plainText } from './mcp.js';

const live: SessionRecord = {
  id: 'aaaaaaaa-1111-2222-3333-444444444444',
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
  pid: 4242,
  lifecycle: 'running',
  overlay: 'waiting_input',
  overlaySource: 'hooks',
  cols: 80,
  rows: 24,
  startedAtMs: 0,
  endedAtMs: null,
  exitCode: null,
  exitSignal: null
};

function client(calls: Array<{ method: string; path: string; body?: unknown }>) {
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    calls.push({
      method,
      path: url.pathname + url.search,
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body))
    });
    const routes: Record<string, unknown> = {
      'GET /sessions': { sessions: [live] },
      [`GET /sessions/${live.id}/output`]: {
        sessionId: live.id,
        chunks: [{ seq: 7, data: '\x1b[32mok\x1b[0m 40%\r100%\r\ntoken sk-abcdefghijklmnop\r\n', createdAtMs: 0 }],
        resumeAfterSeq: 7,
        hasMore: false,
        firstSeq: 1,
        live: true
      },
      [`POST /sessions/${live.id}/input`]: { acceptedBytes: 6 },
      [`DELETE /sessions/${live.id}`]: { detached: false, killed: true, pid: 4242 }
    };
    const body = routes[`${method} ${url.pathname}`];
    return body === undefined
      ? new Response(JSON.stringify({ error: { code: 'nope', message: 'missing' } }), { status: 404 })
      : new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  return new AgentermClient({ baseUrl: 'http://127.0.0.1:1', token: 't', fetchImpl });
}

async function call(
  name: string,
  args: Record<string, unknown>,
  calls: Array<{ method: string; path: string; body?: unknown }> = []
) {
  const line = await handleMcpMessage(
    client(calls),
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    '0.1.0'
  );
  return JSON.parse(line ?? '{}') as { result: { content: Array<{ text: string }>; isError?: boolean } };
}

describe('MCP bridge', () => {
  it('negotiates the protocol and lists tools', async () => {
    const init = JSON.parse(
      (await handleMcpMessage(
        client([]),
        JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-03-26' } }),
        '0.1.0'
      )) ?? ''
    ) as { result: { protocolVersion: string; capabilities: unknown } };
    expect(init.result.protocolVersion).toBe('2025-03-26');
    const list = JSON.parse(
      (await handleMcpMessage(client([]), '{"jsonrpc":"2.0","id":2,"method":"tools/list"}', '0.1.0')) ?? ''
    ) as {
      result: { tools: Array<{ name: string }> };
    };
    expect(list.result.tools.map((tool) => tool.name)).toContain('read_output');
    expect(await handleMcpMessage(client([]), '{"jsonrpc":"2.0","method":"notifications/initialized"}', '0.1.0')).toBe(
      null
    );
    expect(await handleMcpMessage(client([]), 'not json', '0.1.0')).toContain('-32700');
    for (const line of ['null', '123', '[]', '{"id":1}']) {
      expect(await handleMcpMessage(client([]), line, '0.1.0')).toContain('-32600');
    }
  });

  it('reads output as plain redacted text with a resume cursor', async () => {
    const out = await call('read_output', { session_id: 'aaaa' });
    const text = out.result.content[0]?.text ?? '';
    expect(text.startsWith('100%')).toBe(true);
    expect(text).not.toContain('\x1b');
    expect(text).not.toContain('sk-abcdefghijklmnop');
    expect(text).toContain('[next since_seq: 7]');
  });

  it('types input with Enter and refuses kills without the right pid', async () => {
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    await call('send_input', { session_id: live.id, text: 'yes' }, calls);
    expect(calls.find((entry) => entry.method === 'POST')?.body).toEqual({ data: 'yes\r' });
    const refused = await call('kill_session', { session_id: live.id, confirm_pid: 1 }, calls);
    expect(refused.result.isError).toBe(true);
    expect(calls.some((entry) => entry.method === 'DELETE')).toBe(false);
    const killed = await call('kill_session', { session_id: live.id, confirm_pid: 4242 }, calls);
    expect(killed.result.content[0]?.text).toContain('Killed');
    expect(calls.find((entry) => entry.method === 'DELETE')?.body).toEqual({ killTree: true, confirmPid: 4242 });
  });

  it('reports unknown sessions as tool errors, not protocol errors', async () => {
    const out = await call('get_session', { session_id: 'ffff' });
    expect(out.result.isError).toBe(true);
    expect(out.result.content[0]?.text).toContain('no session matches');
  });

  it('collapses carriage-return redraws', () => {
    expect(plainText('a 10%\ra 90%\r\nnext')).toBe('a 90%\nnext');
  });
});
