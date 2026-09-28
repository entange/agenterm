import { describe, expect, it } from 'vitest';
import { matchAgentCandidates } from '../src/discover.js';
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
