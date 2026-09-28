import { describe, expect, it } from 'vitest';
import { createApp } from '../src/server.js';
import { SessionStore } from '../src/sessionStore.js';

const TOKEN = 'test-token-1234567890abcdef';

function appWithPid(pid: number, command = 'codex', cwd: string | null = '/tmp') {
  return createApp({
    token: TOKEN,
    port: 37241,
    store: new SessionStore(),
    lister: async () => [{ pid, ppid: 1, command, cwd }]
  });
}

describe('POST /sessions/attach', () => {
  it('attaches a known pid with approval in the body', async () => {
    const app = appWithPid(701);
    const res = await app.inject({
      method: 'POST',
      url: '/sessions/attach',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { pid: 701, title: 'outer codex' }
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { session: { pid: number; origin: string; title: string } };
    expect(body.session.pid).toBe(701);
    expect(body.session.origin).toBe('attached');
    expect(body.session.title).toBe('outer codex');
  });

  it('rejects unknown pid with 404', async () => {
    const app = appWithPid(702);
    const res = await app.inject({
      method: 'POST',
      url: '/sessions/attach',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { pid: 9999 }
    });
    expect(res.statusCode).toBe(404);
  });

  it('rejects malformed pid with 400 and never throws', async () => {
    const app = appWithPid(703);
    const res = await app.inject({
      method: 'POST',
      url: '/sessions/attach',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { pid: 0 }
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects duplicate attach with 409', async () => {
    const store = new SessionStore();
    const app = createApp({
      token: TOKEN,
      port: 37241,
      store,
      lister: async () => [{ pid: 704, ppid: 1, command: 'claude', cwd: '/tmp' }]
    });
    const headers = { authorization: `Bearer ${TOKEN}` };
    const first = await app.inject({ method: 'POST', url: '/sessions/attach', headers, payload: { pid: 704 } });
    expect(first.statusCode).toBe(201);
    const second = await app.inject({ method: 'POST', url: '/sessions/attach', headers, payload: { pid: 704 } });
    expect(second.statusCode).toBe(409);
  });
});
