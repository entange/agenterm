import { describe, expect, it } from 'vitest';
import { createApp } from '../src/server.js';
import { SessionStore } from '../src/sessionStore.js';

const TOKEN = 'test-token-1234567890abcdef';

function stubLister() {
  return async () => [];
}

describe('GET /health', () => {
  it('returns liveness only without auth and full detail with it', async () => {
    const app = createApp({ token: TOKEN, port: 37241, store: new SessionStore(), lister: stubLister() });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body['ok']).toBe(true);
    expect(typeof body['version']).toBe('string');
    expect(body['port']).toBe(undefined);
    const authed = await app.inject({ method: 'GET', url: '/health', headers: { authorization: `Bearer ${TOKEN}` } });
    const detail = authed.json() as Record<string, unknown>;
    expect(typeof detail['uptimeSeconds']).toBe('number');
    expect(detail['port']).toBe(37241);
  });

  it('rejects a wrong token of the same length', async () => {
    const app = createApp({ token: TOKEN, port: 37241, store: new SessionStore(), lister: stubLister() });
    const wrong = TOKEN.replace(/.$/, 'x');
    const res = await app.inject({ method: 'GET', url: '/sessions', headers: { authorization: `Bearer ${wrong}` } });
    expect(res.statusCode).toBe(401);
  });

  it('requires auth for protected routes', async () => {
    const app = createApp({ token: TOKEN, port: 37241, store: new SessionStore(), lister: stubLister() });
    const res = await app.inject({ method: 'GET', url: '/discover' });
    expect(res.statusCode).toBe(401);
  });
});
