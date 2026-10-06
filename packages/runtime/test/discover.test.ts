import { describe, expect, it } from 'vitest';
import { agentOf, matchAgentCandidates, parsePsOutput } from '../src/discover.js';
import { createApp } from '../src/server.js';
import { SessionStore } from '../src/sessionStore.js';

const TOKEN = 'test-token-1234567890abcdef';

describe('matchAgentCandidates', () => {
  it('finds known binaries and skips others', () => {
    const out = matchAgentCandidates([
      { pid: 101, ppid: 1, command: 'claude --help', cwd: '/tmp' },
      { pid: 102, ppid: 1, command: '/usr/local/bin/codex', cwd: null },
      { pid: 103, ppid: 1, command: 'node server.js', cwd: '/tmp' },
      { pid: -5, ppid: 1, command: 'claude', cwd: '/tmp' }
    ]);
    expect(out.map((entry) => entry.pid)).toEqual([101, 102]);
  });

  it('sorts by pid in sorted order', () => {
    const out = matchAgentCandidates([
      { pid: 300, ppid: 1, command: 'opencode', cwd: null },
      { pid: 200, ppid: 1, command: 'gemini', cwd: null }
    ]);
    expect(out[0]?.pid).toBe(200);
  });
});

describe('agentOf', () => {
  it('matches executables and interpreter-launched packages', () => {
    expect(agentOf('claude --resume')?.provider).toBe('claude');
    expect(agentOf('/opt/homebrew/bin/codex exec')?.provider).toBe('codex');
    expect(agentOf('node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js')?.provider).toBe('claude');
    expect(agentOf('node /Users/me/.npm/bin/gemini.js')?.provider).toBe('gemini');
    expect(agentOf('C:\\tools\\opencode.exe serve')?.provider).toBe('opencode');
  });

  it('rejects look-alikes and GUI app bundles', () => {
    expect(agentOf('/Applications/Claude.app/Contents/MacOS/Claude')).toBe(null);
    expect(agentOf('/Users/me/.codex/x/Codex Computer Use.app/Contents/MacOS/Helper --flag')).toBe(null);
    expect(agentOf('vim claude-notes.md')).toBe(null);
    expect(agentOf('node server.js --name claude')).toBe(null);
    expect(agentOf('claudette')).toBe(null);
  });

  it('redacts tokens in candidate command lines', () => {
    const [found] = matchAgentCandidates([
      { pid: 9, ppid: 1, command: 'claude --mcp-config {"headers":{"Authorization":"Bearer abcdefghijklmnop"}}', cwd: null }
    ]);
    expect(found?.commandLine).not.toContain('abcdefghijklmnop');
  });

  it('parses ps output with spaced arguments', () => {
    expect(parsePsOutput('  12     1 claude --add-dir /a b\n   x\n')).toEqual([
      { pid: 12, ppid: 1, command: 'claude --add-dir /a b', cwd: null }
    ]);
  });
});

describe('GET /discover', () => {
  it('lists candidates with auth', async () => {
    const app = createApp({
      token: TOKEN,
      port: 37241,
      store: new SessionStore(),
      lister: async () => [{ pid: 501, ppid: 1, command: 'claude', cwd: '/tmp' }]
    });
    const res = await app.inject({
      method: 'GET',
      url: '/discover',
      headers: { authorization: `Bearer ${TOKEN}` }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { candidates: Array<{ pid: number }> };
    expect(body.candidates).toHaveLength(1);
    expect(body.candidates[0]?.pid).toBe(501);
  });
});
