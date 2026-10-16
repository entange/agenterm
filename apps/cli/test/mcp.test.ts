import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { handleMcpMessage, TOOLS, type McpContext } from '../src/mcp.js';
import { daemonRig, fakeOutside, outsideProcess } from './kit.js';

function mcp(options: Parameters<typeof daemonRig>[0] = {}) {
  const daemon = daemonRig(options);
  const context: McpContext = {
    client: () => daemon.client,
    version: '0.1.0',
    caller: () => ({ name: 'codex', pid: 777 }),
    cwd: () => os.tmpdir(),
    env: () => ({ PATH: '/agent/bin' }),
    sleep: async () => undefined,
    ensureDaemon: async () => undefined
  };
  let next = 1;
  const send = async (method: string, params?: Record<string, unknown>) => {
    const line = await handleMcpMessage(context, JSON.stringify({ jsonrpc: '2.0', id: next++, method, params }));
    return JSON.parse(line ?? 'null') as {
      result?: { content?: Array<{ text: string }>; isError?: boolean; tools?: Array<{ name: string }> } & Record<
        string,
        unknown
      >;
      error?: { code: number; message: string };
    };
  };
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await send('tools/call', { name, arguments: args });
    return { text: res.result?.content?.[0]?.text ?? '', isError: res.result?.isError === true };
  };
  return { ...daemon, context, send, call };
}

describe('MCP protocol', () => {
  it('initializes, lists the tools, and ignores notifications', async () => {
    const m = mcp();
    const init = await m.send('initialize', { protocolVersion: '2025-06-18' });
    expect(init.result?.['protocolVersion']).toBe('2025-06-18');
    const list = await m.send('tools/list');
    expect(list.result?.tools?.map((tool) => tool.name)).toEqual([
      'run',
      'list',
      'logs',
      'input',
      'stop',
      'remove',
      'processes',
      'kill'
    ]);
    expect(
      await handleMcpMessage(m.context, JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }))
    ).toBe(null);
    expect((await m.send('nope')).error?.code).toBe(-32601);
    expect(JSON.parse((await handleMcpMessage(m.context, '{bad')) ?? '{}').error.code).toBe(-32700);
  });
});

describe('MCP tools', () => {
  it('runs a task as the agent, in its folder, and never twice', async () => {
    const m = mcp();
    const first = await m.call('run', { command: 'npm run dev', id: 'web', wait_seconds: 0 });
    expect(first.text.split('\n')[0]).toBe('started web: npm run dev');
    expect(m.store.get('web')).toMatchObject({ cwd: os.tmpdir(), startedBy: 'codex', startedByPid: 777 });
    expect(m.last()?.spawnEnv['PATH']).toBe('/agent/bin');
    const again = await m.call('run', { command: 'npm run dev' });
    expect(again.text.split('\n')[0]).toBe('already running: web (npm run dev)');
    expect(m.fakes).toHaveLength(1);
  });

  it('reads plain redacted logs, types, stops, and removes', async () => {
    const m = mcp();
    await m.call('run', { command: 'npm run dev', id: 'web', wait_seconds: 0 });
    m.last()?.emitData('\x1b[32mok\x1b[0m 40%\r100%\r\ntoken sk-abcdefghijklmnopqrstuv\r\n');
    const logs = await m.call('logs', { id: 'web' });
    expect(logs.text).toBe('web: running\n100%\ntoken [REDACTED]');
    expect((await m.call('input', { id: 'web', text: 'y' })).text).toBe('sent 2 bytes to web');
    expect(m.last()?.written).toEqual(['y\r']);
    expect((await m.call('stop', { id: 'web' })).text).toBe('web: stopped');
    const list = await m.call('list', {});
    expect(list.text).toMatch(/web\s+stopped/);
    expect((await m.call('remove', { id: 'web' })).text).toBe('removed web');
  });

  it('reports bad input and unknown tasks as tool errors', async () => {
    const m = mcp();
    expect(await m.call('run', { command: 'ls', cwd: 'relative' })).toEqual({
      text: 'cwd must be an absolute path',
      isError: true
    });
    expect(await m.call('stop', { id: 'ghost' })).toEqual({ text: 'no task matches "ghost"', isError: true });
    expect((await m.call('run', { command: 'ls', id: 'bad id', wait_seconds: 0 })).isError).toBe(true);
  });

  it('lists commands outside agenterm and kills one by pid', async () => {
    const { outside, stopped } = fakeOutside([
      outsideProcess(),
      outsideProcess({ pid: 900, pids: [900], startedBy: 'claude', orphaned: false })
    ]);
    const m = mcp({ outside });
    const listed = await m.call('processes', { orphaned: true });
    expect(listed.text).toMatch(/^Orphaned \(1\)/);
    expect(listed.text).toMatch(/4821\s+2h\s+:4000/);
    expect(listed.text).not.toMatch(/claude/);
    await m.client.updateSettings({ hiddenCommands: ['node'] });
    expect((await m.call('processes', {})).text).toBe(
      'nothing is running outside agenterm.\n\n2 hidden (node): all: true shows them.'
    );
    expect((await m.call('processes', { all: true })).text).toMatch(/^Hidden \(2\): kept running on purpose/);
    expect(await m.call('kill', { pid: 4821 })).toEqual({
      text: 'ended 4821 (node server.js --port 4000, 2 processes)',
      isError: false
    });
    expect(stopped).toEqual([{ pid: 4821, force: false }]);
    expect((await m.call('kill', { pid: '4821' })).isError).toBe(true);
    expect(await m.call('kill', { pid: 5 })).toMatchObject({
      isError: true,
      text: expect.stringMatching(/not listed/)
    });
  });

  it('describes every tool with a schema', () => {
    for (const tool of TOOLS) {
      expect(tool.description.length).toBeGreaterThan(20);
      expect(tool.inputSchema['type']).toBe('object');
    }
  });
});
