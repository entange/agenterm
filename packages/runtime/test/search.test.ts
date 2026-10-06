import { describe, expect, it } from 'vitest';
import { searchTerminalText } from '../src/search.js';
import { headers, rig } from './helpers.js';

describe('output search', () => {
  it('matches visible text case-insensitively, after redraws, with secrets redacted', () => {
    const raw = 'compiling 10%\rcompiling 100%\r\n\x1b[31mError\x1b[0m: token sk-abcdefghijklmnop failed\r\nok\r\n';
    expect(searchTerminalText(raw, 'error', 10)).toEqual([{ line: 2, text: 'Error: token [REDACTED] failed' }]);
    expect(searchTerminalText(raw, '10%', 10)).toEqual([]);
    expect(searchTerminalText('a\na\na', 'a', 2).map((m) => m.line)).toEqual([2, 3]);
  });

  it('searches live and ended sessions through the API', async () => {
    const r = rig();
    const live = await r.spawn({ title: 'live' });
    r.last()?.emitData('first line\r\nCannot find module ./db\r\n');
    const ended = await r.spawn({ title: 'ended' });
    r.last()?.emitData('cannot FIND module react\r\n');
    r.last()?.emitExit(1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await r.pty.forget(ended.id);
    const res = await r.app.inject({ method: 'GET', url: '/search?q=find%20module', headers });
    const body = res.json() as { matches: Array<{ sessionId: string; text: string }> };
    expect(body.matches.map((m) => m.sessionId).sort()).toEqual([live.id, ended.id].sort());
    const bad = await r.app.inject({ method: 'GET', url: '/search?q=x', headers });
    expect(bad.statusCode).toBe(400);
  });
});
