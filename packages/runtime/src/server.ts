import crypto from 'node:crypto';
import fs from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  isSecretEnvKey,
  parseAttachSessionRequest,
  parseDeleteSessionRequest,
  parseListSessionsQuery,
  parseSessionIdParam,
  parseSessionInputRequest,
  parseSessionOutputQuery,
  parseSessionResizeRequest,
  parseSessionSignalRequest,
  parseSpawnSessionRequest,
  redactText,
  type AgentermEvent,
  type SessionSignalName
} from '@agenterm/core';
import { effectiveCommand, PROVIDER_INSTALL_HINTS, resolveBinary } from './binary.js';
import { discoverAgents, type ProcessLister } from './discover.js';
import { EventBus } from './events.js';
import { readGitInfo, sharedCwdSessions, type GitInfo } from './gitInfo.js';
import { DAEMON_VERSION } from './paths.js';
import { PtyManager } from './ptyManager.js';
import { SessionStore } from './sessionStore.js';
import { Supervisor, type SupervisorProbes } from './supervisor.js';

/** Options injected for tests. Production wires the real lister and store. */
export interface CreateAppOptions {
  token: string;
  port: number;
  startedAtMs?: number | undefined;
  store?: SessionStore | undefined;
  lister?: ProcessLister | undefined;
  pty?: PtyManager | undefined;
  supervisor?: Supervisor | undefined;
  bus?: EventBus | undefined;
  dataDir?: string | undefined;
  probes?: SupervisorProbes | undefined;
  gitReader?: ((cwd: string) => Promise<GitInfo>) | undefined;
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

function authOf(request: { headers: Record<string, string | string[] | undefined> }): string | undefined {
  const header = request.headers['authorization'];
  return typeof header === 'string' ? header : undefined;
}

/** Coerce Fastify string query params into the typed output query shape. */
function coerceOutputQuery(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null) return {};
  const record = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of ['tailBytes', 'sinceSeq', 'limit'] as const) {
    const value = record[key];
    if (value === undefined) continue;
    if (typeof value === 'number') {
      out[key] = value;
      continue;
    }
    if (typeof value === 'string' && value.trim().length > 0) {
      const parsed = Number(value);
      if (Number.isInteger(parsed)) out[key] = parsed;
      else out[key] = value;
      continue;
    }
    out[key] = value;
  }
  return out;
}

function cwdExists(cwd: string): boolean {
  try {
    return fs.statSync(cwd).isDirectory();
  } catch {
    return false;
  }
}

const SIGNAL_TO_OS: Record<SessionSignalName, string> = {
  interrupt: 'SIGINT',
  terminate: 'SIGTERM',
  kill: 'SIGKILL'
};

/** Build the Fastify app. Localhost binding happens in index. */
export function createApp(options: CreateAppOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  const dataDir = options.dataDir;
  const store = options.store ?? new SessionStore({ dataDir });
  const lister = options.lister;
  const bus = options.bus ?? new EventBus({ dataDir });
  const startedAtMs = options.startedAtMs ?? Date.now();
  const gitReader = options.gitReader ?? readGitInfo;
  const supervisor =
    options.supervisor ??
    new Supervisor({
      probes: options.probes,
      onPorts: (sessionId, change) => {
        const now = Date.now();
        for (const port of change.opened) {
          bus.publish({
            id: '',
            sessionId,
            createdAtMs: now,
            kind: 'port.opened',
            port: port.port,
            pid: port.pid
          });
        }
        for (const port of change.closed) {
          bus.publish({
            id: '',
            sessionId,
            createdAtMs: now,
            kind: 'port.closed',
            port: port.port,
            pid: port.pid
          });
        }
      }
    });
  const inputSeq = new Map<string, number>();
  const pty = options.pty ?? new PtyManager({ dataDir });
  pty.onOutput = (sessionId, data) => {
    const managed = pty.get(sessionId);
    const seq = managed?.log.latestSeq() ?? 0;
    const event: AgentermEvent = {
      id: '',
      sessionId,
      createdAtMs: Date.now(),
      kind: 'terminal.output',
      seq,
      data
    };
    bus.publish(event);
  };
  pty.onExit = (sessionId, exit) => {
    const record = store.get(sessionId);
    if (record === null) return;
    store.markExited(sessionId, exit.exitCode, exit.signal);
    bus.publish({
      id: '',
      sessionId,
      createdAtMs: Date.now(),
      kind: 'session.exited',
      pid: record.pid,
      exitCode: exit.exitCode,
      exitSignal: exit.signal
    });
  };

  app.addHook('onRequest', async (request, reply) => {
    if (request.url === '/health' && request.method === 'GET') {
      const header = request.headers['authorization'];
      // Health allows missing auth for local liveness checks but returns
      // limited detail without it. Full detail requires the token.
      if (header === undefined) {
        return;
      }
    }
    if (!checkAuth(authOf(request), options.token)) {
      await reply.code(401).send(unauthorized());
      return;
    }
  });

  app.get('/health', async (request) => {
    const authed = checkAuth(authOf(request), options.token);
    void authed;
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

  app.post('/sessions', async (request, reply) => {
    const parsed = parseSpawnSessionRequest(request.body ?? {});
    if (!parsed.ok) {
      await reply.code(400).send({ error: { code: parsed.code, message: parsed.message } });
      return;
    }
    const body = parsed.value;
    const env = body.env ?? {};
    for (const key of Object.keys(env)) {
      if (isSecretEnvKey(key)) {
        await reply
          .code(400)
          .send({ error: { code: 'invalid_env', message: `env key ${key} is on the secrets blocklist` } });
        return;
      }
    }
    if (!cwdExists(body.cwd)) {
      await reply.code(400).send({ error: { code: 'invalid_cwd', message: 'cwd must be an existing directory' } });
      return;
    }
    const command = effectiveCommand(body.provider, body.command);
    if (command === null) {
      await reply
        .code(400)
        .send({ error: { code: 'invalid_command', message: 'generic sessions require an explicit command' } });
      return;
    }
    const resolved = resolveBinary(command);
    if (resolved === null) {
      await reply.code(404).send({
        error: {
          code: 'missing_binary',
          message: `binary ${command} not found on PATH`,
          hint: PROVIDER_INSTALL_HINTS[body.provider]
        }
      });
      return;
    }
    const cols = body.cols ?? 80;
    const rows = body.rows ?? 24;
    const args = body.args ?? [];
    const git = await gitReader(body.cwd);
    const id = crypto.randomUUID();
    const title =
      typeof body.title === 'string' && body.title.trim().length > 0
        ? body.title.trim().slice(0, 200)
        : `${body.provider} ${new Date().toISOString().slice(11, 19)}`;
    let pid: number;
    try {
      const managed = pty.spawn({
        sessionId: id,
        file: resolved,
        args,
        cwd: body.cwd,
        env: { ...env, ['PATH']: process.env['PATH'] ?? '' },
        cols,
        rows
      });
      pid = managed.pid;
    } catch (error) {
      await reply.code(500).send({
        error: {
          code: 'spawn_failed',
          message: error instanceof Error ? redactText(error.message) : 'pty spawn failed'
        }
      });
      return;
    }
    const session = store.createSpawned({
      id,
      provider: body.provider,
      agentId: body.provider,
      title,
      cwd: body.cwd,
      worktreeRoot: git.worktreeRoot,
      branch: git.branch,
      commandLine: [command, ...args],
      resolvedBinaryPath: resolved,
      pid,
      cols,
      rows
    });
    supervisor.track(id, pid);
    bus.publish({
      id: '',
      sessionId: id,
      createdAtMs: Date.now(),
      kind: 'session.created',
      pid,
      origin: 'spawned',
      commandLine: session.commandLine,
      cwd: session.cwd
    });
    const peers = sharedCwdSessions(id, session.cwd, store.list());
    if (peers.length > 0) {
      bus.publish({
        id: '',
        sessionId: id,
        createdAtMs: Date.now(),
        kind: 'workspace.conflict',
        cwd: session.cwd,
        involvedSessionIds: [id, ...peers]
      });
    }
    await reply.code(201).send({ session });
    return;
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
    const attachInput: { pid: number; commandLine: string; cwd: string; title?: string | undefined } = {
      pid: match.pid,
      commandLine: match.commandLine,
      cwd
    };
    if (typeof parsed.value.title === 'string') {
      attachInput.title = parsed.value.title;
    }
    const session = store.createAttached(attachInput);
    bus.publish({
      id: '',
      sessionId: session.id,
      createdAtMs: Date.now(),
      kind: 'session.attached',
      pid: session.pid,
      origin: 'attached'
    });
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
      processes: supervisor.snapshot(session.id),
      ports: supervisor.portsFor(session.id),
      branch: session.branch
    };
  });

  app.delete('/sessions/:id', async (request, reply) => {
    const params = request.params as Record<string, unknown>;
    const idParsed = parseSessionIdParam(params['id']);
    if (!idParsed.ok) {
      await reply.code(400).send({ error: { code: idParsed.code, message: idParsed.message } });
      return;
    }
    const rawBody = request.body;
    const bodyForParse: unknown =
      rawBody === undefined || rawBody === null ? { killTree: false } : rawBody;
    const bodyParsed = parseDeleteSessionRequest(bodyForParse);
    if (!bodyParsed.ok) {
      await reply.code(400).send({ error: { code: bodyParsed.code, message: bodyParsed.message } });
      return;
    }
    const session = store.get(idParsed.value);
    if (session === null) {
      await reply.code(404).send({ error: { code: 'unknown_session', message: 'session id not found' } });
      return;
    }
    let killed = false;
    if (bodyParsed.value.killTree) {
      try {
        await supervisor.killTree(session.pid);
      } catch {
        // Best effort; the row is still removed below.
      }
      if (pty.has(session.id)) {
        try {
          pty.kill(session.id, 'SIGKILL');
        } catch {
          // Leader may already be gone.
        }
      }
      store.markKilled(session.id);
      killed = true;
      bus.publish({
        id: '',
        sessionId: session.id,
        createdAtMs: Date.now(),
        kind: 'session.exited',
        pid: session.pid,
        exitCode: null,
        exitSignal: 'SIGKILL'
      });
    } else if (session.origin === 'spawned' && pty.has(session.id)) {
      try {
        pty.kill(session.id, 'SIGTERM');
      } catch {
        // Leader may already be gone.
      }
      store.markKilled(session.id);
      killed = true;
      bus.publish({
        id: '',
        sessionId: session.id,
        createdAtMs: Date.now(),
        kind: 'session.exited',
        pid: session.pid,
        exitCode: null,
        exitSignal: 'SIGTERM'
      });
    }
    pty.forget(session.id);
    supervisor.untrack(session.id);
    inputSeq.delete(session.id);
    store.remove(session.id);
    bus.publish({
      id: '',
      sessionId: session.id,
      createdAtMs: Date.now(),
      kind: 'session.detached',
      pid: session.pid
    });
    return { detached: true, killed, pid: session.pid };
  });

  app.post('/sessions/:id/input', async (request, reply) => {
    const params = request.params as Record<string, unknown>;
    const idParsed = parseSessionIdParam(params['id']);
    if (!idParsed.ok) {
      await reply.code(400).send({ error: { code: idParsed.code, message: idParsed.message } });
      return;
    }
    const bodyParsed = parseSessionInputRequest(request.body ?? {});
    if (!bodyParsed.ok) {
      await reply.code(400).send({ error: { code: bodyParsed.code, message: bodyParsed.message } });
      return;
    }
    const session = store.get(idParsed.value);
    if (session === null) {
      await reply.code(404).send({ error: { code: 'unknown_session', message: 'session id not found' } });
      return;
    }
    if (!pty.has(session.id)) {
      await reply.code(409).send({
        error: { code: 'no_pty', message: 'attached sessions expose no PTY for input' }
      });
      return;
    }
    const managed = pty.get(session.id);
    if (managed?.exit !== null && managed !== null) {
      await reply.code(409).send({ error: { code: 'exited', message: 'session already exited' } });
      return;
    }
    try {
      pty.write(session.id, bodyParsed.value.data);
    } catch {
      await reply.code(409).send({ error: { code: 'exited', message: 'session already exited' } });
      return;
    }
    const seq = (inputSeq.get(session.id) ?? 0) + 1;
    inputSeq.set(session.id, seq);
    bus.publish({
      id: '',
      sessionId: session.id,
      createdAtMs: Date.now(),
      kind: 'terminal.input',
      seq,
      data: bodyParsed.value.data
    });
    return { acceptedBytes: Buffer.byteLength(bodyParsed.value.data, 'utf8') };
  });

  app.post('/sessions/:id/resize', async (request, reply) => {
    const params = request.params as Record<string, unknown>;
    const idParsed = parseSessionIdParam(params['id']);
    if (!idParsed.ok) {
      await reply.code(400).send({ error: { code: idParsed.code, message: idParsed.message } });
      return;
    }
    const bodyParsed = parseSessionResizeRequest(request.body ?? {});
    if (!bodyParsed.ok) {
      await reply.code(400).send({ error: { code: bodyParsed.code, message: bodyParsed.message } });
      return;
    }
    const session = store.get(idParsed.value);
    if (session === null) {
      await reply.code(404).send({ error: { code: 'unknown_session', message: 'session id not found' } });
      return;
    }
    store.setDims(session.id, bodyParsed.value.cols, bodyParsed.value.rows);
    if (pty.has(session.id)) {
      try {
        pty.resize(session.id, bodyParsed.value.cols, bodyParsed.value.rows);
      } catch {
        // Exited PTYs ignore resizes; dims are still stored.
      }
    }
    return { cols: bodyParsed.value.cols, rows: bodyParsed.value.rows };
  });

  app.post('/sessions/:id/signal', async (request, reply) => {
    const params = request.params as Record<string, unknown>;
    const idParsed = parseSessionIdParam(params['id']);
    if (!idParsed.ok) {
      await reply.code(400).send({ error: { code: idParsed.code, message: idParsed.message } });
      return;
    }
    const bodyParsed = parseSessionSignalRequest(request.body ?? {});
    if (!bodyParsed.ok) {
      await reply.code(400).send({ error: { code: bodyParsed.code, message: bodyParsed.message } });
      return;
    }
    const session = store.get(idParsed.value);
    if (session === null) {
      await reply.code(404).send({ error: { code: 'unknown_session', message: 'session id not found' } });
      return;
    }
    const osSignal = SIGNAL_TO_OS[bodyParsed.value.signal];
    await supervisor.poll().catch(() => undefined);
    const targets = supervisor.subtreePids(session.pid);
    const scope = targets.length > 0 ? targets : [session.pid];
    let leaderSignaled = false;
    for (const pid of scope) {
      try {
        process.kill(pid, osSignal);
        if (pid === session.pid) leaderSignaled = true;
      } catch {
        if (pid === session.pid) {
          try {
            if (pty.has(session.id)) {
              pty.kill(session.id, osSignal);
              leaderSignaled = true;
            }
          } catch {
            // Gone.
          }
        }
      }
    }
    return { signaled: leaderSignaled, pid: session.pid, signal: bodyParsed.value.signal };
  });

  app.get('/sessions/:id/output', async (request, reply) => {
    const params = request.params as Record<string, unknown>;
    const idParsed = parseSessionIdParam(params['id']);
    if (!idParsed.ok) {
      await reply.code(400).send({ error: { code: idParsed.code, message: idParsed.message } });
      return;
    }
    const queryParsed = parseSessionOutputQuery(coerceOutputQuery(request.query));
    if (!queryParsed.ok) {
      await reply.code(400).send({ error: { code: queryParsed.code, message: queryParsed.message } });
      return;
    }
    const session = store.get(idParsed.value);
    if (session === null) {
      await reply.code(404).send({ error: { code: 'unknown_session', message: 'session id not found' } });
      return;
    }
    const managed = pty.get(session.id);
    if (managed === null) {
      await reply.code(409).send({
        error: { code: 'no_pty', message: 'attached sessions expose no PTY scrollback' }
      });
      return;
    }
    const readOptions: { tailBytes: number; sinceSeq?: number | undefined; limit: number } = {
      tailBytes: queryParsed.value.tailBytes ?? 65_536,
      limit: queryParsed.value.limit ?? 200
    };
    if (typeof queryParsed.value.sinceSeq === 'number') {
      readOptions.sinceSeq = queryParsed.value.sinceSeq;
    }
    const page = managed.log.read(readOptions);
    return { sessionId: session.id, chunks: page.chunks, resumeAfterSeq: page.resumeAfterSeq, hasMore: page.hasMore };
  });

  app.get('/sessions/:id/processes', async (request, reply) => {
    const params = request.params as Record<string, unknown>;
    const idParsed = parseSessionIdParam(params['id']);
    if (!idParsed.ok) {
      await reply.code(400).send({ error: { code: idParsed.code, message: idParsed.message } });
      return;
    }
    const session = store.get(idParsed.value);
    if (session === null) {
      await reply.code(404).send({ error: { code: 'unknown_session', message: 'session id not found' } });
      return;
    }
    await supervisor.poll().catch(() => undefined);
    return { sessionId: session.id, processes: supervisor.snapshot(session.id), sampledAtMs: Date.now() };
  });

  app.get('/sessions/:id/ports', async (request, reply) => {
    const params = request.params as Record<string, unknown>;
    const idParsed = parseSessionIdParam(params['id']);
    if (!idParsed.ok) {
      await reply.code(400).send({ error: { code: idParsed.code, message: idParsed.message } });
      return;
    }
    const session = store.get(idParsed.value);
    if (session === null) {
      await reply.code(404).send({ error: { code: 'unknown_session', message: 'session id not found' } });
      return;
    }
    await supervisor.poll().catch(() => undefined);
    return { sessionId: session.id, ports: supervisor.portsFor(session.id), sampledAtMs: Date.now() };
  });

  return app;
}
