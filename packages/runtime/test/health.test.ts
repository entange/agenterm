import { describe, expect, it } from 'vitest';
import { createApp } from '../src/server.js';
import { SessionStore } from '../src/sessionStore.js';

const TOKEN = 'test-token-1234567890abcdef';

function stubLister() {
  return async () => [];
}

describe('GET /health', () => {
  it('returns version and uptime without auth for liveness', async () => {
    const app = createApp({ token: TOKEN, port: 37241, store: new SessionStore(), lister: stubLister() });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body['ok']).toBe(true);
    expect(typeof body['version']).toBe('string');
    expect(typeof body['uptimeSeconds']).toBe('number');
  });

  it('requires auth for protected routes', async () => {
    const app = createApp({ token: TOKEN, port: 37241, store: new SessionStore(), lister: stubLister() });
    const res = await app.inject({ method: 'GET', url: '/discover' });
    expect(res.statusCode).toBe(401);
  });
});
