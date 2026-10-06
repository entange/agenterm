import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import {
  isSecretEnvKey,
  parseAttachSessionRequest,
  parseDeleteSessionRequest,
  parseEventsQuery,
  parseListSessionsQuery,
  parseSessionIdParam,
  parseSessionInputRequest,
  parseSessionOutputQuery,
  parseSessionResizeRequest,
  parseSessionSignalRequest,
  parseSpawnSessionRequest,
  parseUpdateSessionRequest,
  redactText,
  type AgentProvider,
  type FileChangeRecord,
  type OverlaySource,
  type SessionOverlayStatus,
  type SessionRecord,
  type SessionSignalName
} from '@agenterm/core';
import { ActivityMeter } from './activity.js';
import { AgentHooks, agentHooksEnabled, claudeHookStatus, codexNotifyStatus } from './agentHooks.js';
import { parseOtlpLogs, UsageLedger } from './usage.js';
import { checkBearer } from './auth.js';
import { effectiveCommand, PROVIDER_INSTALL_HINTS, resolveBinary } from './binary.js';
import { CommandTracker } from './commands.js';
import { type SqliteCommands } from './database.js';
import { discoverAgents, processCwd, type ProcessLister } from './discover.js';
import { buildSpawnEnv } from './env.js';
import { EventBus } from './events.js';
import { FileWatch } from './fileWatch.js';
import { readGitInfo, sharedCwdSessions, type GitInfo } from './gitInfo.js';
import { readGitDiff, readGitStatus, type GitStatus } from './gitStatus.js';
import { HarnessWatch, harnessWatchEnabled } from './harnessWatch.js';
import { DAEMON_VERSION, terminalLogPath } from './paths.js';
import { PtyManager } from './ptyManager.js';
import { isLiveSession, SessionStore } from './sessionStore.js';
import { Supervisor, type SupervisorProbes } from './supervisor.js';
import { searchTerminalText } from './search.js';
import { readLogTail } from './terminal.js';

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
  gitStatusReader?: ((cwd: string) => Promise<GitStatus>) | undefined;
  watch?: HarnessWatch | undefined;
  fileWatch?: FileWatch | undefined;
  commandsDb?: SqliteCommands | undefined;
  /** Base env for spawns. Defaults to the daemon's own (login) env. */
  baseEnv?: NodeJS.ProcessEnv | undefined;
  /** Resolves an attached pid's cwd. Defaults to lsof or /proc. */
  cwdResolver?: ((pid: number) => Promise<string | null>) | undefined;
  /** Liveness check for attached leaders. Defaults to signal 0. */
  pidAlive?: ((pid: number) => boolean) | undefined;
  /** Attached-leader liveness poll. Defaults to 2000 ms. */
  livenessIntervalMs?: number | undefined;
  /** Agent status hooks. Defaults to on unless AGENTERM_AGENT_HOOKS=0. */
  hooks?: AgentHooks | undefined;
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Daemon helpers shared with the event stream. */
    agenterm: {
      /** Typing into a waiting agent means the user answered it. */
      noteInput: (sessionId: string, data: string) => void;
      /** Output heartbeat, drained into one socket frame per second. */
      activity: ActivityMeter;
    };
  }
}

type Failure = { status: number; code: string; message: string; hint?: string | undefined };

async function fail(reply: FastifyReply, failure: Failure): Promise<void> {
  const error: Record<string, string> = { code: failure.code, message: failure.message };
  if (failure.hint !== undefined) error['hint'] = failure.hint;
  await reply.code(failure.status).send({ error });
}

function authOf(request: FastifyRequest): string | undefined {
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
    if (typeof value === 'string' && value.trim().length > 0) {
      const parsed = Number(value);
      out[key] = Number.isInteger(parsed) ? parsed : value;
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

/**
 * macOS reports pty exhaustion as a bare "posix_spawnp failed". Count the
 * allocated pty device nodes to tell that apart from other spawn errors.
 */
function ptysExhausted(): boolean {
  if (process.platform !== 'darwin') return false;
  try {
    return fs.readdirSync('/dev').filter((name) => name.startsWith('ttys')).length >= 505;
  } catch {
    return false;
  }
}

function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the pid exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Directories never worth a recursive watcher, even inside a repo. */
function watchableCwd(cwd: string, worktreeRoot: string | null): boolean {
  if (worktreeRoot === null) return false;
  const resolved = path.resolve(cwd);
  return resolved !== path.parse(resolved).root && resolved !== os.homedir();
}

const SIGNAL_TO_OS: Record<SessionSignalName, NodeJS.Signals> = {
  interrupt: 'SIGINT',
  terminate: 'SIGTERM',
  kill: 'SIGKILL'
};

/** Recent file changes kept per session for the Files tab. */
const MAX_FILE_CHANGES = 300;

interface SpawnInput {
  provider: AgentProvider;
  command?: string | undefined;
  args: string[];
  cwd: string;
  title?: string | undefined;
  cols: number;
  rows: number;
  env: Record<string, string>;
  statusHooks: boolean;
  parentSessionId?: string | null | undefined;
}

/** Build the Fastify app. Localhost binding happens in index. */
export function createApp(options: CreateAppOptions): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });
  const dataDir = options.dataDir;
  const store = options.store ?? new SessionStore({ dataDir });
  const lister = options.lister;
  const bus = options.bus ?? new EventBus({ dataDir });
  const startedAtMs = options.startedAtMs ?? Date.now();
  const gitReader = options.gitReader ?? readGitInfo;
  const gitStatusReader = options.gitStatusReader ?? readGitStatus;
  const baseEnv = options.baseEnv ?? process.env;
  const cwdResolver = options.cwdResolver ?? processCwd;
  const pidAlive = options.pidAlive ?? defaultPidAlive;
  const supervisor =
    options.supervisor ??
    new Supervisor({
      probes: options.probes,
      onPorts: (sessionId, change) => {
        const now = Date.now();
        for (const port of change.opened) {
          bus.publish({ id: '', sessionId, createdAtMs: now, kind: 'port.opened', port: port.port, pid: port.pid });
        }
        for (const port of change.closed) {
          bus.publish({ id: '', sessionId, createdAtMs: now, kind: 'port.closed', port: port.port, pid: port.pid });
        }
      }
    });
  const inputSeq = new Map<string, number>();
  const trackers = new Map<string, CommandTracker>();
  const fileChanges = new Map<string, Map<string, FileChangeRecord>>();
  const commandsDb = options.commandsDb;
  const watch = options.watch ?? new HarnessWatch({ enabled: harnessWatchEnabled(), dataDir, store, bus });
  const fileWatch = options.fileWatch ?? new FileWatch();
  const pty = options.pty ?? new PtyManager({ dataDir });
  const activity = new ActivityMeter();
  const usage = new UsageLedger();
  const hooks = options.hooks ?? new AgentHooks({ port: options.port, enabled: agentHooksEnabled() });

  /** Set the overlay and publish agent.status when it actually changes. */
  const applyOverlay = (
    sessionId: string,
    overlay: SessionOverlayStatus,
    source: OverlaySource,
    summary: string | null
  ): void => {
    const before = store.get(sessionId);
    if (before === null || before.overlay === overlay) return;
    const updated = store.setOverlay(sessionId, overlay, source);
    if (updated === null || updated.overlay !== overlay) return;
    bus.publish({ id: '', sessionId, createdAtMs: Date.now(), kind: 'agent.status', overlay, source, summary });
  };

  const noteInput = (sessionId: string, data: string): void => {
    const session = store.get(sessionId);
    if (session === null || !hooks.hasHooks(sessionId)) return;
    // Enter, a single key like "1" or "y", or Escape answers a prompt. Terminal
    // reports (focus, cursor position) and arrow keys while choosing do not.
    const answer = data.includes('\r') || /^[\x20-\x7e]$/.test(data) || data === '\x1b';
    const answeredPrompt = session.overlay === 'waiting_permission' && answer;
    const submittedReply = session.overlay === 'waiting_input' && data.includes('\r');
    if (answeredPrompt || submittedReply) applyOverlay(sessionId, 'working', 'pty', null);
  };
  app.decorate('agenterm', { noteInput, activity });

  fileWatch.onChange = (change) => {
    const session = store.get(change.sessionId);
    if (session === null) return;
    const relative = path.relative(session.cwd, change.path).split(path.sep).join('/');
    const shown = relative.length > 0 && !relative.startsWith('..') ? relative : change.path;
    const now = Date.now();
    const perSession = fileChanges.get(change.sessionId) ?? new Map<string, FileChangeRecord>();
    const prior = perSession.get(shown);
    perSession.delete(shown);
    perSession.set(shown, { path: shown, change: change.change, atMs: now, count: (prior?.count ?? 0) + 1 });
    while (perSession.size > MAX_FILE_CHANGES) {
      const oldest = perSession.keys().next().value;
      if (oldest === undefined) break;
      perSession.delete(oldest);
    }
    fileChanges.set(change.sessionId, perSession);
    bus.publish({
      id: '',
      sessionId: change.sessionId,
      createdAtMs: now,
      kind: 'file.changed',
      path: shown,
      change: change.change
    });
  };

  /** True while the session leader can still receive signals or input. */
  const isLive = (session: SessionRecord): boolean => {
    if (!isLiveSession(session)) return false;
    if (session.origin === 'spawned') {
      const managed = pty.get(session.id);
      return managed !== null && managed.exit === null;
    }
    return pidAlive(session.pid);
  };

  const startTracking = (session: SessionRecord): void => {
    supervisor.track(session.id, session.pid);
    watch.track(session.id);
    if (watchableCwd(session.cwd, session.worktreeRoot)) {
      fileWatch.track(session.id, session.cwd);
    }
  };

  const stopTracking = (sessionId: string): void => {
    supervisor.untrack(sessionId);
    watch.untrack(sessionId);
    fileWatch.untrack(sessionId);
  };

  pty.onOutput = (sessionId, data) => {
    const managed = pty.get(sessionId);
    const seq = managed?.log.latestSeq() ?? 0;
    bus.publish({ id: '', sessionId, createdAtMs: Date.now(), kind: 'terminal.output', seq, data });
    activity.record(sessionId, data);
    try {
      trackers.get(sessionId)?.feed(data);
    } catch {
      // Heuristic input never breaks the stream.
    }
  };

  pty.onExit = (sessionId, exit) => {
    const record = store.get(sessionId);
    const exited = pty.get(sessionId);
    if (exited !== null) {
      // With a disk mirror, the ended session's ring is freed once flushed; scrollback comes from terminal.log.
      void exited.log.close().then(() => {
        if (dataDir !== undefined) exited.log.release();
      });
    }
    hooks.forget(sessionId);
    stopTracking(sessionId);
    try {
      trackers.get(sessionId)?.closeAll();
    } catch {
      // Heuristic input never breaks the stream.
    }
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

  // Attached leaders have no PTY exit callback; poll their pids instead.
  const liveness = setInterval(() => {
    for (const session of store.list()) {
      if (session.origin !== 'attached' || !isLiveSession(session)) continue;
      if (pidAlive(session.pid)) continue;
      stopTracking(session.id);
      store.markExited(session.id, null, null);
      bus.publish({
        id: '',
        sessionId: session.id,
        createdAtMs: Date.now(),
        kind: 'session.exited',
        pid: session.pid,
        exitCode: null,
        exitSignal: null
      });
    }
  }, options.livenessIntervalMs ?? 2000);
  liveness.unref();
  app.addHook('onClose', async () => {
    clearInterval(liveness);
    await fileWatch.close();
  });

  /** Parse the :id param and load the row, replying 400 or 404 on failure. */
  const loadSession = async (request: FastifyRequest, reply: FastifyReply): Promise<SessionRecord | null> => {
    const params = request.params as Record<string, unknown>;
    const parsed = parseSessionIdParam(params['id']);
    if (!parsed.ok) {
      await fail(reply, { status: 400, code: parsed.code, message: parsed.message });
      return null;
    }
    const session = store.get(parsed.value);
    if (session === null) {
      await fail(reply, { status: 404, code: 'unknown_session', message: 'session id not found' });
      return null;
    }
    return session;
  };

  const publishConflicts = (session: SessionRecord): void => {
    const live = store.list().filter((entry) => isLiveSession(entry));
    const peers = sharedCwdSessions(session.id, session.cwd, live);
    if (peers.length === 0) return;
    bus.publish({
      id: '',
      sessionId: session.id,
      createdAtMs: Date.now(),
      kind: 'workspace.conflict',
      cwd: session.cwd,
      involvedSessionIds: [session.id, ...peers]
    });
  };

  /** Shared by POST /sessions and restart. */
  const spawnSession = async (input: SpawnInput): Promise<{ session: SessionRecord } | Failure> => {
    if (!cwdExists(input.cwd)) {
      return { status: 400, code: 'invalid_cwd', message: 'cwd must be an existing directory' };
    }
    const command = effectiveCommand(input.provider, input.command);
    if (command === null) {
      return { status: 400, code: 'invalid_command', message: 'generic sessions require an explicit command' };
    }
    const env = buildSpawnEnv(baseEnv, input.env);
    const resolved = resolveBinary(command, env['PATH'], input.cwd);
    if (resolved === null) {
      return {
        status: 404,
        code: 'missing_binary',
        message: `binary ${command} not found on PATH`,
        hint: PROVIDER_INSTALL_HINTS[input.provider]
      };
    }
    const git = await gitReader(input.cwd);
    const id = crypto.randomUUID();
    const title =
      typeof input.title === 'string' && input.title.trim().length > 0
        ? input.title.trim().slice(0, 200)
        : `${input.provider === 'generic' ? path.basename(command) : input.provider} · ${path.basename(input.cwd) || input.cwd}`;
    const launch = hooks.prepare({
      sessionId: id,
      provider: input.provider,
      args: input.args,
      requested: input.statusHooks,
      env
    });
    let pid: number;
    try {
      const managed = pty.spawn({
        sessionId: id,
        file: resolved,
        args: launch.args,
        cwd: input.cwd,
        env: { ...env, ...launch.env },
        cols: input.cols,
        rows: input.rows
      });
      pid = managed.pid;
    } catch (error) {
      hooks.forget(id);
      const message = error instanceof Error ? redactText(error.message) : 'pty spawn failed';
      if (/forkpty|posix_openpt|out of pty|no more pty|EAGAIN/i.test(message) || ptysExhausted()) {
        return {
          status: 503,
          code: 'pty_limit',
          message: 'The system ran out of pseudo-terminals.',
          hint:
            process.platform === 'darwin'
              ? 'macOS allows 511 by default. Close ended sessions, or raise it with: sudo sysctl -w kern.tty.ptmx_max=999'
              : 'Close ended sessions or raise the pty limit (/proc/sys/kernel/pty/max).'
        };
      }
      return { status: 500, code: 'spawn_failed', message };
    }
    const session = store.createSpawned({
      id,
      provider: input.provider,
      agentId: input.provider,
      title,
      cwd: input.cwd,
      worktreeRoot: git.worktreeRoot,
      branch: git.branch,
      commandLine: [command, ...input.args].map((part) => redactText(part)),
      resolvedBinaryPath: resolved,
      pid,
      cols: input.cols,
      rows: input.rows,
      parentSessionId:
        input.parentSessionId !== undefined &&
        input.parentSessionId !== null &&
        store.get(input.parentSessionId) !== null
          ? input.parentSessionId
          : null
    });
    // The PTY may have exited during the git read; settle that before tracking.
    const managed = pty.get(id);
    if (managed?.exit !== null && managed?.exit !== undefined) {
      store.markExited(id, managed.exit.exitCode, managed.exit.signal);
    } else {
      startTracking(session);
    }
    trackers.set(
      id,
      new CommandTracker({
        sessionId: id,
        cwd: session.cwd,
        pid,
        save: commandsDb === undefined ? undefined : (record) => commandsDb.save(record)
      })
    );
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
    publishConflicts(session);
    return { session: store.get(id) ?? session };
  };

  /** Drop every in-memory trace of a session and remove its row and files. */
  const forgetSession = async (session: SessionRecord): Promise<void> => {
    // Wait for the terminal mirror to close so deleting the folder cannot race its last write.
    await pty.forget(session.id);
    stopTracking(session.id);
    trackers.delete(session.id);
    inputSeq.delete(session.id);
    fileChanges.delete(session.id);
    activity.forget(session.id);
    usage.forget(session.id);
    hooks.forget(session.id);
    store.remove(session.id);
  };

  app.addHook('onRequest', async (request, reply) => {
    if (request.method === 'GET' && request.url === '/health') return;
    // Agent status and telemetry pushes carry their own per-session token, checked in the route.
    if (request.method === 'POST' && (request.url.startsWith('/ingest/') || request.url.startsWith('/otel/'))) return;
    if (!checkBearer(authOf(request), options.token)) {
      await fail(reply, { status: 401, code: 'unauthorized', message: 'missing or invalid bearer token' });
    }
  });

  app.get('/health', async (request) => {
    if (!checkBearer(authOf(request), options.token)) {
      return { ok: true as const, version: DAEMON_VERSION };
    }
    return {
      ok: true as const,
      version: DAEMON_VERSION,
      uptimeSeconds: Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000)),
      startedAtMs,
      port: options.port,
      pid: process.pid,
      liveSessions: store.list().filter((session) => isLive(session)).length,
      harnessWatch: watch.isEnabled()
    };
  });

  app.get('/discover', async () => {
    const candidates = await discoverAgents(lister);
    const byPid = new Map(
      store
        .list()
        .filter((session) => isLiveSession(session))
        .map((session) => [session.pid, session.id] as const)
    );
    const resolved = await Promise.all(
      candidates.map(async (candidate) => ({
        ...candidate,
        cwd: candidate.cwd ?? (await cwdResolver(candidate.pid)),
        sessionId: byPid.get(candidate.pid) ?? null
      }))
    );
    return { candidates: resolved, scannedAtMs: Date.now() };
  });

  app.get('/activity', async () => activity.snapshot());

  app.get('/usage', async () => ({ sessions: usage.all() }));

  // Search retained output across sessions: live rings, or terminal.log for ended ones.
  app.get('/search', async (request, reply) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    const q = typeof query['q'] === 'string' ? query['q'].trim() : '';
    if (q.length < 2 || q.length > 200) {
      await fail(reply, { status: 400, code: 'invalid_query', message: 'q must be 2-200 characters' });
      return;
    }
    const limit = Math.min(500, Math.max(1, Number(query['limit']) || 100));
    const only = typeof query['sessionId'] === 'string' ? query['sessionId'] : null;
    const matches: Array<{ sessionId: string; line: number; text: string }> = [];
    let truncated = false;
    for (const session of store.list()) {
      if (only !== null && session.id !== only) continue;
      const managed = pty.get(session.id);
      const text =
        managed !== null && !managed.log.isReleased()
          ? managed.log.text()
          : dataDir !== undefined
            ? readLogTail(terminalLogPath(session.id, dataDir), 2 * 1024 * 1024)
            : null;
      if (text === null) continue;
      for (const match of searchTerminalText(text, q, limit)) {
        if (matches.length >= limit) {
          truncated = true;
          break;
        }
        matches.push({ sessionId: session.id, ...match });
      }
      if (truncated) break;
    }
    return { query: q, matches, truncated };
  });

  // OTLP/HTTP JSON sink for Claude Code telemetry. Only logs carry usage; metrics are acknowledged and dropped.
  app.post('/otel/:id/v1/:signal', async (request, reply) => {
    const params = request.params as Record<string, unknown>;
    const idParsed = parseSessionIdParam(params['id']);
    const header = request.headers['x-agenterm-token'];
    if (!idParsed.ok || !hooks.verify(idParsed.value, typeof header === 'string' ? header : undefined)) {
      await fail(reply, { status: 401, code: 'unauthorized', message: 'invalid ingest token' });
      return;
    }
    if (params['signal'] === 'logs' && usage.apply(idParsed.value, parseOtlpLogs(request.body))) {
      const totals = usage.get(idParsed.value);
      if (totals !== null) {
        bus.publish({
          id: '',
          sessionId: idParsed.value,
          createdAtMs: Date.now(),
          kind: 'session.usage',
          costUsd: totals.costUsd,
          inputTokens: totals.inputTokens,
          outputTokens: totals.outputTokens
        });
      }
    }
    return {};
  });

  app.get('/events', async (request, reply) => {
    const parsed = parseEventsQuery(request.query ?? {});
    if (!parsed.ok) {
      await fail(reply, { status: 400, code: parsed.code, message: parsed.message });
      return;
    }
    return { events: bus.history(parsed.value) };
  });

  app.get('/sessions', async (request, reply) => {
    const parsed = parseListSessionsQuery(request.query ?? {});
    if (!parsed.ok) {
      await fail(reply, { status: 400, code: parsed.code, message: parsed.message });
      return;
    }
    return { sessions: store.list(parsed.value) };
  });

  app.post('/sessions', async (request, reply) => {
    const parsed = parseSpawnSessionRequest(request.body ?? {});
    if (!parsed.ok) {
      await fail(reply, { status: 400, code: parsed.code, message: parsed.message });
      return;
    }
    const body = parsed.value;
    const env = body.env ?? {};
    for (const key of Object.keys(env)) {
      if (isSecretEnvKey(key)) {
        await fail(reply, { status: 400, code: 'invalid_env', message: `env key ${key} is on the secrets blocklist` });
        return;
      }
    }
    const result = await spawnSession({
      provider: body.provider,
      command: body.command,
      args: body.args ?? [],
      cwd: body.cwd,
      title: body.title,
      cols: body.cols ?? 80,
      rows: body.rows ?? 24,
      env,
      statusHooks: body.statusHooks ?? true,
      parentSessionId: body.parentSessionId
    });
    if ('status' in result) {
      await fail(reply, result);
      return;
    }
    await reply.code(201).send(result);
  });

  app.post('/sessions/attach', async (request, reply) => {
    const parsed = parseAttachSessionRequest(request.body ?? {});
    if (!parsed.ok) {
      await fail(reply, { status: 400, code: parsed.code, message: parsed.message });
      return;
    }
    const candidates = await discoverAgents(lister);
    const match = candidates.find((entry) => entry.pid === parsed.value.pid);
    if (match === undefined) {
      await fail(reply, {
        status: 404,
        code: 'unknown_pid',
        message: 'pid is not a recognized agent process',
        hint: 'Run GET /discover to list candidates, then attach with explicit approval.'
      });
      return;
    }
    if (store.hasPid(match.pid)) {
      await fail(reply, { status: 409, code: 'already_attached', message: 'pid is already attached to a session' });
      return;
    }
    const resolvedCwd = parsed.value.cwd ?? match.cwd ?? (await cwdResolver(match.pid));
    const cwd = resolvedCwd !== null && cwdExists(resolvedCwd) ? resolvedCwd : '/';
    const git = cwd === '/' ? { branch: null, worktreeRoot: null } : await gitReader(cwd);
    const session = store.createAttached({
      pid: match.pid,
      commandLine: match.commandLine,
      cwd,
      provider: match.provider,
      title: parsed.value.title,
      branch: git.branch,
      worktreeRoot: git.worktreeRoot
    });
    startTracking(session);
    bus.publish({
      id: '',
      sessionId: session.id,
      createdAtMs: Date.now(),
      kind: 'session.attached',
      pid: session.pid,
      origin: 'attached'
    });
    publishConflicts(session);
    await reply.code(201).send({ session });
  });

  app.get('/sessions/:id', async (request, reply) => {
    const session = await loadSession(request, reply);
    if (session === null) return;
    return {
      session,
      processes: supervisor.snapshot(session.id),
      ports: supervisor.portsFor(session.id),
      branch: session.branch
    };
  });

  app.patch('/sessions/:id', async (request, reply) => {
    const session = await loadSession(request, reply);
    if (session === null) return;
    const parsed = parseUpdateSessionRequest(request.body ?? {});
    if (!parsed.ok) {
      await fail(reply, { status: 400, code: parsed.code, message: parsed.message });
      return;
    }
    const updated = store.setTitle(session.id, parsed.value.title) ?? session;
    bus.publish({
      id: '',
      sessionId: session.id,
      createdAtMs: Date.now(),
      kind: 'session.updated',
      title: updated.title
    });
    return { session: updated };
  });

  app.delete('/sessions/:id', async (request, reply) => {
    const session = await loadSession(request, reply);
    if (session === null) return;
    const rawBody = request.body;
    const parsed = parseDeleteSessionRequest(rawBody === undefined || rawBody === null ? { killTree: false } : rawBody);
    if (!parsed.ok) {
      await fail(reply, { status: 400, code: parsed.code, message: parsed.message });
      return;
    }
    const live = isLive(session);
    if (parsed.value.killTree && live) {
      if (session.origin === 'attached' && parsed.value.confirmPid !== session.pid) {
        await fail(reply, {
          status: 403,
          code: 'confirm_pid_required',
          message: `killing an attached session requires confirmPid=${session.pid}`
        });
        return;
      }
      // Mark first so the PTY exit callback keeps the killed lifecycle.
      store.markKilled(session.id);
      try {
        await supervisor.killTree(session.pid);
      } catch {
        // Fall through to the owned handle.
      }
      if (pty.get(session.id)?.exit === null) {
        try {
          pty.kill(session.id, 'SIGKILL');
        } catch {
          // Leader already gone.
        }
      }
      if (session.origin === 'attached') {
        stopTracking(session.id);
        bus.publish({
          id: '',
          sessionId: session.id,
          createdAtMs: Date.now(),
          kind: 'session.exited',
          pid: session.pid,
          exitCode: null,
          exitSignal: 'SIGKILL'
        });
      }
      return { detached: false, killed: true, pid: session.pid };
    }
    if (live && session.origin === 'spawned') {
      await fail(reply, {
        status: 409,
        code: 'session_running',
        message: 'session is still running',
        hint: 'Kill it first (killTree: true), then close it.'
      });
      return;
    }
    // Publish before removal so the event's jsonl mirror does not recreate the deleted folder.
    bus.publish({ id: '', sessionId: session.id, createdAtMs: Date.now(), kind: 'session.detached', pid: session.pid });
    await forgetSession(session);
    return { detached: true, killed: false, pid: session.pid };
  });

  app.post('/sessions/:id/restart', async (request, reply) => {
    const session = await loadSession(request, reply);
    if (session === null) return;
    if (session.origin !== 'spawned') {
      await fail(reply, { status: 409, code: 'not_spawned', message: 'only spawned sessions can restart' });
      return;
    }
    if (isLive(session)) {
      await fail(reply, {
        status: 409,
        code: 'session_running',
        message: 'session is still running',
        hint: 'Kill it first, then restart.'
      });
      return;
    }
    if (session.commandLine.some((part) => part.includes('[REDACTED]'))) {
      await fail(reply, {
        status: 409,
        code: 'restart_unsafe',
        message: 'this command line held a secret that was redacted, so it cannot be replayed',
        hint: 'Start a new session with the full command instead.'
      });
      return;
    }
    const [command, ...args] = session.commandLine;
    const result = await spawnSession({
      provider: session.provider,
      // Keep a custom binary for agents too (for example a pinned claude path).
      command: command !== undefined && command !== effectiveCommand(session.provider) ? command : undefined,
      args,
      cwd: session.cwd,
      title: session.title,
      cols: session.cols,
      rows: session.rows,
      env: {},
      statusHooks: true,
      parentSessionId: session.parentSessionId
    });
    if ('status' in result) {
      await fail(reply, result);
      return;
    }
    bus.publish({ id: '', sessionId: session.id, createdAtMs: Date.now(), kind: 'session.detached', pid: session.pid });
    await forgetSession(session);
    await reply.code(201).send(result);
  });

  app.post('/sessions/:id/input', async (request, reply) => {
    const session = await loadSession(request, reply);
    if (session === null) return;
    const parsed = parseSessionInputRequest(request.body ?? {});
    if (!parsed.ok) {
      await fail(reply, { status: 400, code: parsed.code, message: parsed.message });
      return;
    }
    const managed = pty.get(session.id);
    if (managed === null) {
      await fail(reply, { status: 409, code: 'no_pty', message: 'this session exposes no PTY for input' });
      return;
    }
    if (managed.exit !== null) {
      await fail(reply, { status: 409, code: 'exited', message: 'session already exited' });
      return;
    }
    try {
      pty.write(session.id, parsed.value.data);
    } catch {
      await fail(reply, { status: 409, code: 'exited', message: 'session already exited' });
      return;
    }
    noteInput(session.id, parsed.value.data);
    const seq = (inputSeq.get(session.id) ?? 0) + 1;
    inputSeq.set(session.id, seq);
    bus.publish({
      id: '',
      sessionId: session.id,
      createdAtMs: Date.now(),
      kind: 'terminal.input',
      seq,
      data: parsed.value.data
    });
    return { acceptedBytes: Buffer.byteLength(parsed.value.data, 'utf8') };
  });

  app.post('/sessions/:id/resize', async (request, reply) => {
    const session = await loadSession(request, reply);
    if (session === null) return;
    const parsed = parseSessionResizeRequest(request.body ?? {});
    if (!parsed.ok) {
      await fail(reply, { status: 400, code: parsed.code, message: parsed.message });
      return;
    }
    const { cols, rows } = parsed.value;
    if (session.cols !== cols || session.rows !== rows) {
      store.setDims(session.id, cols, rows);
    }
    if (pty.get(session.id)?.exit === null) {
      try {
        pty.resize(session.id, cols, rows);
      } catch {
        // Exited PTYs ignore resizes; dims are still stored.
      }
    }
    return { cols, rows };
  });

  app.post('/sessions/:id/signal', async (request, reply) => {
    const session = await loadSession(request, reply);
    if (session === null) return;
    const parsed = parseSessionSignalRequest(request.body ?? {});
    if (!parsed.ok) {
      await fail(reply, { status: 400, code: parsed.code, message: parsed.message });
      return;
    }
    const { signal, confirmPid } = parsed.value;
    if (!isLive(session)) {
      await fail(reply, { status: 409, code: 'not_running', message: 'session is not running' });
      return;
    }
    if (session.origin === 'attached' && signal !== 'interrupt' && confirmPid !== session.pid) {
      await fail(reply, {
        status: 403,
        code: 'confirm_pid_required',
        message: `signaling an attached session requires confirmPid=${session.pid}`
      });
      return;
    }
    if (signal === 'interrupt' && pty.get(session.id) !== null) {
      // Ctrl+C through the PTY reaches the foreground job, like a real keypress.
      pty.write(session.id, '\x03');
      return { signaled: true, pid: session.pid, signal };
    }
    const osSignal = SIGNAL_TO_OS[signal];
    const targets =
      signal === 'interrupt'
        ? [session.pid]
        : (await supervisor.poll().catch(() => undefined), supervisor.subtreePids(session.pid));
    let leaderSignaled = false;
    for (const pid of targets) {
      try {
        process.kill(pid, osSignal);
        if (pid === session.pid) leaderSignaled = true;
      } catch {
        // Already gone.
      }
    }
    if (!leaderSignaled && pty.get(session.id)?.exit === null) {
      try {
        pty.kill(session.id, osSignal);
        leaderSignaled = true;
      } catch {
        // Gone.
      }
    }
    return { signaled: leaderSignaled, pid: session.pid, signal };
  });

  app.get('/sessions/:id/output', async (request, reply) => {
    const session = await loadSession(request, reply);
    if (session === null) return;
    const parsed = parseSessionOutputQuery(coerceOutputQuery(request.query));
    if (!parsed.ok) {
      await fail(reply, { status: 400, code: parsed.code, message: parsed.message });
      return;
    }
    const managed = pty.get(session.id);
    if (managed !== null && !managed.log.isReleased()) {
      const page = managed.log.read({
        tailBytes: parsed.value.tailBytes,
        sinceSeq: parsed.value.sinceSeq,
        limit: parsed.value.limit
      });
      return { sessionId: session.id, ...page, live: managed.exit === null };
    }
    const tail =
      session.origin === 'spawned' && dataDir !== undefined
        ? readLogTail(terminalLogPath(session.id, dataDir), parsed.value.tailBytes)
        : null;
    if (tail === null) {
      await fail(reply, {
        status: 409,
        code: 'no_pty',
        message:
          session.origin === 'attached'
            ? 'attached sessions expose no PTY scrollback'
            : 'no scrollback was kept for this session'
      });
      return;
    }
    // A dead session has one immutable chunk; any cursor past it is caught up.
    const chunks =
      tail.length > 0 && (parsed.value.sinceSeq ?? 0) < 1
        ? [{ seq: 1, data: tail, createdAtMs: session.endedAtMs ?? session.startedAtMs }]
        : [];
    return {
      sessionId: session.id,
      chunks,
      resumeAfterSeq: chunks.length > 0 ? 1 : null,
      hasMore: false,
      firstSeq: tail.length > 0 ? 1 : null,
      live: false
    };
  });

  app.get('/sessions/:id/processes', async (request, reply) => {
    const session = await loadSession(request, reply);
    if (session === null) return;
    await supervisor.poll().catch(() => undefined);
    return { sessionId: session.id, processes: supervisor.snapshot(session.id), sampledAtMs: Date.now() };
  });

  app.get('/sessions/:id/ports', async (request, reply) => {
    const session = await loadSession(request, reply);
    if (session === null) return;
    await supervisor.poll().catch(() => undefined);
    return { sessionId: session.id, ports: supervisor.portsFor(session.id), sampledAtMs: Date.now() };
  });

  app.get('/sessions/:id/commands', async (request, reply) => {
    const session = await loadSession(request, reply);
    if (session === null) return;
    const rawLimit = (request.query as Record<string, unknown> | undefined)?.['limit'];
    let limit = 100;
    if (rawLimit !== undefined) {
      const parsed = typeof rawLimit === 'number' ? rawLimit : Number(rawLimit);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 500) {
        await fail(reply, { status: 400, code: 'invalid_limit', message: 'limit must be an integer 1-500' });
        return;
      }
      limit = parsed;
    }
    const tracker = trackers.get(session.id);
    if (tracker !== undefined) {
      return { sessionId: session.id, commands: tracker.rows().reverse().slice(0, limit) };
    }
    return { sessionId: session.id, commands: commandsDb?.forSession(session.id, limit) ?? [] };
  });

  app.post('/ingest/:provider/:id', async (request, reply) => {
    const params = request.params as Record<string, unknown>;
    const idParsed = parseSessionIdParam(params['id']);
    const provider = params['provider'];
    if (!idParsed.ok || (provider !== 'claude' && provider !== 'codex')) {
      await fail(reply, { status: 404, code: 'unknown_ingest', message: 'no such ingest endpoint' });
      return;
    }
    if (!hooks.verify(idParsed.value, authOf(request))) {
      await fail(reply, { status: 401, code: 'unauthorized', message: 'invalid ingest token' });
      return;
    }
    const status = provider === 'claude' ? claudeHookStatus(request.body) : codexNotifyStatus(request.body);
    if (status !== null) applyOverlay(idParsed.value, status.overlay, 'hooks', status.summary);
    await reply.code(204).send();
  });

  app.get('/sessions/:id/git', async (request, reply) => {
    const session = await loadSession(request, reply);
    if (session === null) return;
    const status = session.cwd === '/' ? null : await gitStatusReader(session.cwd);
    const base = status ?? {
      branch: null,
      worktreeRoot: null,
      isDirty: false,
      stagedCount: 0,
      unstagedCount: 0,
      files: [],
      insertions: 0,
      deletions: 0
    };
    return { sessionId: session.id, ...base, sampledAtMs: Date.now() };
  });

  app.get('/sessions/:id/git/diff', async (request, reply) => {
    const session = await loadSession(request, reply);
    if (session === null) return;
    const file = (request.query as Record<string, unknown> | undefined)?.['path'];
    if (typeof file !== 'string' || file.length === 0) {
      await fail(reply, { status: 400, code: 'invalid_path', message: 'path query must be a worktree-relative file' });
      return;
    }
    const result = await readGitDiff(session.cwd, file);
    if (result === null) {
      await fail(reply, {
        status: 400,
        code: 'invalid_path',
        message: 'path is outside the worktree or not in a repo'
      });
      return;
    }
    return { sessionId: session.id, ...result };
  });

  app.get('/sessions/:id/files', async (request, reply) => {
    const session = await loadSession(request, reply);
    if (session === null) return;
    const changes = [...(fileChanges.get(session.id)?.values() ?? [])].reverse();
    return { sessionId: session.id, watching: fileWatch.isTracking(session.id), changes };
  });

  return app;
}
