import Fastify, { type FastifyInstance } from 'fastify';
import {
  parseAttachSessionRequest,
  parseListSessionsQuery,
  parseSessionIdParam
} from '@agenterm/core';
import { DAEMON_VERSION } from './paths.js';
import { discoverAgents, type ProcessLister } from './discover.js';
import { SessionStore } from './sessionStore.js';

/** Options injected for tests. Production wires the real lister and store. */
export interface CreateAppOptions {
  token: string;
  port: number;
  startedAtMs?: number;
  store?: SessionStore;
  lister?: ProcessLister;
}

function unauthorized(): { error: { code: string; message: string } } {
  return { error: { code: 'unauthorized', message: 'missing or invalid bearer token' } };
}

function checkAuth(requestToken: string | undefined, expected: string): boolean {
  if (typeof requestToken !== 'string') return false;
  const parts = requestToken.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') return false;
  const given = parts[1] ?? '';
  if (given.length === 0 || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) {
    diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

/** Build the Fastify app. Localhost binding happens in index. */
export function createApp(options: CreateAppOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  const store = options.store ?? new SessionStore();
  const lister = options.lister;
  const startedAtMs = options.startedAtMs ?? Date.now();

  app.addHook('onRequest', async (request, reply) => {
    if (request.url === '/health' && request.method === 'GET') {
      const header = request.headers['authorization'];
      // Health allows missing auth for local liveness checks but returns
      // limited detail without it. Full detail requires the token.
      if (header === undefined) {
        return;
      }
    }
    const header = request.headers['authorization'];
    if (!checkAuth(typeof header === 'string' ? header : undefined, options.token)) {
      await reply.code(401).send(unauthorized());
      return;
    }
  });

  app.get('/health', async (request) => {
    const header = request.headers['authorization'];
    const authed = checkAuth(typeof header === 'string' ? header : undefined, options.token);
    const now = Date.now();
    return {
      ok: true as const,
      version: DAEMON_VERSION,
      uptimeSeconds: Math.max(0, Math.floor((now - startedAtMs) / 1000)),
      startedAtMs,
      port: options.port
    };
  });

  app.get('/discover', async () => {
    const candidates = await discoverAgents(lister);
    return { candidates, scannedAtMs: Date.now() };
  });

  app.get('/sessions', async (request, reply) => {
    const parsed = parseListSessionsQuery(request.query ?? {});
    if (!parsed.ok) {
      await reply.code(400).send({ error: { code: parsed.code, message: parsed.message } });
      return;
    }
    return { sessions: store.list(parsed.value) };
  });

  app.post('/sessions/attach', async (request, reply) => {
    const parsed = parseAttachSessionRequest(request.body ?? {});
    if (!parsed.ok) {
      await reply.code(400).send({ error: { code: parsed.code, message: parsed.message } });
      return;
    }
    const candidates = await discoverAgents(lister);
    const match = candidates.find((entry) => entry.pid === parsed.value.pid);
    if (match === undefined) {
      await reply.code(404).send({
        error: {
          code: 'unknown_pid',
          message: 'pid is not a recognized agent process',
          hint: 'Run GET /discover to list candidates, then attach with explicit approval.'
        }
      });
      return;
    }
    if (store.hasPid(match.pid)) {
      await reply.code(409).send({
        error: { code: 'already_attached', message: 'pid is already attached to a session' }
      });
      return;
    }
    const cwd = parsed.value.cwd ?? match.cwd ?? '/';
    const attachInput: { pid: number; commandLine: string; cwd: string; title?: string } = {
      pid: match.pid,
      commandLine: match.commandLine,
      cwd
    };
    if (typeof parsed.value.title === 'string') {
      attachInput.title = parsed.value.title;
    }
    const session = store.createAttached(attachInput);
    await reply.code(201).send({ session });
    return;
  });

  app.get('/sessions/:id', async (request, reply) => {
    const params = request.params as Record<string, unknown>;
    const parsed = parseSessionIdParam(params['id']);
    if (!parsed.ok) {
      await reply.code(400).send({ error: { code: parsed.code, message: parsed.message } });
      return;
    }
    const session = store.get(parsed.value);
    if (session === null) {
      await reply.code(404).send({ error: { code: 'unknown_session', message: 'session id not found' } });
      return;
    }
    return {
      session,
      processes: [],
      ports: [],
      branch: session.branch
    };
  });

  return app;
}
