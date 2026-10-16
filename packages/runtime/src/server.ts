import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import {
  API_VERSION,
  isRunning,
  parsePid,
  parseRunTaskRequest,
  parseSettingsPatch,
  parseStopProcessRequest,
  parseStopTaskRequest,
  parseTaskId,
  parseTaskInputRequest,
  parseTaskOutputQuery,
  parseTaskResizeRequest,
  redactText,
  type RunTaskRequest,
  type RunTaskResponse,
  type Settings,
  type TaskRecord
} from '@agenterm/core';
import { ActivityMeter } from './activity.js';
import { checkBearer } from './auth.js';
import { buildSpawnEnv } from './env.js';
import { EventBus } from './events.js';
import { readGitInfo, type GitInfo } from './gitInfo.js';
import { DAEMON_VERSION, settingsPath, taskDir, terminalLogPath } from './paths.js';
import { OutsideScanner } from './outside.js';
import { projectOf } from './project.js';
import { PtyManager } from './ptyManager.js';
import { loadSettings, saveSettings } from './settings.js';
import { Supervisor } from './supervisor.js';
import { TaskStore } from './taskStore.js';
import { readLogTailAsync } from './terminal.js';

/** Options injected for tests. Production wires the real store and supervisor. */
export interface CreateAppOptions {
  token: string;
  port: number;
  startedAtMs?: number | undefined;
  store?: TaskStore | undefined;
  pty?: PtyManager | undefined;
  supervisor?: Supervisor | undefined;
  /** Finds commands running outside agenterm. */
  outside?: Pick<OutsideScanner, 'list' | 'stop'> | undefined;
  bus?: EventBus | undefined;
  /** Where terminal logs and settings live. Absent keeps everything in memory. */
  dataDir?: string | undefined;
  gitReader?: ((cwd: string) => Promise<GitInfo>) | undefined;
  /** Env for tasks whose caller sent none. Defaults to the daemon's own (login) env. */
  baseEnv?: NodeJS.ProcessEnv | undefined;
  /** Liveness check for the program that started a task. Defaults to signal 0. */
  pidAlive?: ((pid: number) => boolean) | undefined;
  /** How often to check whether starters are still alive. Defaults to 2000 ms. */
  livenessIntervalMs?: number | undefined;
  /** How long a stop waits after Ctrl+C before terminating the tree. Defaults to 3000 ms. */
  stopGraceMs?: number | undefined;
  /** How long a stop waits for the exit before answering anyway. Defaults to 10000 ms. */
  stopTimeoutMs?: number | undefined;
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Daemon helpers shared with the event stream and shutdown. */
    agenterm: {
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

/**
 * The shell that runs a command line. The user's own shell when it is a
 * POSIX one, so aliases-free syntax like `a && b` and `$VAR` work as they
 * would in their terminal; plain sh otherwise (fish and nu differ).
 */
export function shellFor(command: string, env: Record<string, string>): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    return { file: env['ComSpec'] ?? 'cmd.exe', args: ['/d', '/s', '/c', command] };
  }
  const shell = env['SHELL'] ?? '';
  const name = path.basename(shell);
  const file = shell.startsWith('/') && ['bash', 'zsh', 'sh'].includes(name) ? shell : '/bin/sh';
  return { file, args: ['-c', command] };
}

/** Lowercase words of a title or command, joined with dashes. Empty when nothing usable. */
export function slugOf(text: string): string {
  const words: string[] = [];
  for (const raw of text.trim().split(/\s+/)) {
    if (raw.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(raw)) continue;
    const word = path
      .basename(raw)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    if (word.length > 0) words.push(word);
    if (words.length === 3) break;
  }
  return words.join('-').slice(0, 32).replace(/-+$/, '');
}

type Result<T> = { ok: true; status: number; value: T } | ({ ok: false } & Failure);

const UNKNOWN_HINT = 'Run `agenterm ls` to see task ids.';

/**
 * Build the daemon HTTP app.
 *
 * Every route except GET /health needs the bearer token. A task is a
 * command running in a PTY the daemon owns; its row survives restarts
 * and its output is mirrored to tasks/<id>/terminal.log.
 */
export function createApp(options: CreateAppOptions): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 8 * 1024 * 1024 });
  const startedAtMs = options.startedAtMs ?? Date.now();
  const dataDir = options.dataDir;
  const store = options.store ?? new TaskStore();
  const pty = options.pty ?? new PtyManager({ dataDir });
  const bus = options.bus ?? new EventBus();
  const gitReader = options.gitReader ?? readGitInfo;
  const pidAlive = options.pidAlive ?? defaultPidAlive;
  const stopGraceMs = options.stopGraceMs ?? 3000;
  const stopTimeoutMs = options.stopTimeoutMs ?? 10_000;
  const activity = new ActivityMeter();
  const settingsFile = dataDir === undefined ? undefined : settingsPath(dataDir);
  let settings: Settings = loadSettings(settingsFile);

  const supervisor =
    options.supervisor ??
    new Supervisor({
      onPorts: (taskId) => {
        const task = store.get(taskId);
        if (task !== null && isRunning(task)) publish(task);
      }
    });

  const outside = options.outside ?? new OutsideScanner({ gitReader });

  /** Command lines as given, for dedupe. Rows only keep the masked form. */
  const rawCommands = new Map<string, string>();
  /** Tasks being stopped on request; their exit is recorded as stopped. */
  const stopping = new Set<string>();
  const exitWaiters = new Map<string, Array<() => void>>();

  const view = (task: TaskRecord): TaskRecord =>
    isRunning(task) ? { ...task, ports: supervisor.portsFor(task.id) } : task;

  const publish = (task: TaskRecord): void => {
    bus.publish({ kind: 'task.updated', taskId: task.id, task: view(task) });
  };

  pty.onOutput = (taskId, data) => {
    const seq = pty.get(taskId)?.log.latestSeq() ?? 0;
    bus.publish({ kind: 'terminal.output', taskId, seq, data });
    activity.record(taskId, data);
  };

  pty.onExit = (taskId, exit) => {
    const managed = pty.get(taskId);
    if (managed !== null && dataDir !== undefined) {
      // The ended task's ring is freed once flushed; scrollback comes from terminal.log.
      void managed.log.close().then(() => managed.log.release());
    }
    supervisor.untrack(taskId);
    rawCommands.delete(taskId);
    const stopped = stopping.delete(taskId);
    const task = store.get(taskId);
    if (task !== null && isRunning(task)) {
      const clean = exit.exitCode === 0 && exit.signal === null;
      publish(
        store.put({
          ...task,
          status: stopped ? 'stopped' : clean ? 'exited' : 'failed',
          exitCode: exit.exitCode,
          exitSignal: exit.signal,
          ports: [],
          endedAtMs: Date.now()
        })
      );
    }
    for (const resolve of exitWaiters.get(taskId) ?? []) resolve();
    exitWaiters.delete(taskId);
  };

  /** Resolves when the task's PTY exits, or after the timeout. True when it exited. */
  const waitForExit = (taskId: string, timeoutMs: number): Promise<boolean> => {
    const managed = pty.get(taskId);
    if (managed === null || managed.exit !== null) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      const list = exitWaiters.get(taskId) ?? [];
      list.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
      exitWaiters.set(taskId, list);
    });
  };

  /**
   * Stop a running task. Graceful: Ctrl+C first, as a person would, then
   * terminate the whole process tree if it is still up. Force: kill the
   * tree right away. Resolves with the final record.
   */
  const stopTask = async (task: TaskRecord, force: boolean): Promise<TaskRecord> => {
    if (!isRunning(task) || pty.get(task.id) === null) return store.get(task.id) ?? task;
    stopping.add(task.id);
    if (force) {
      await supervisor.killTree(task.pid, { force: true });
    } else {
      try {
        pty.write(task.id, '\x03');
      } catch {
        // Gone already.
      }
      if (!(await waitForExit(task.id, stopGraceMs))) await supervisor.killTree(task.pid);
    }
    if (!(await waitForExit(task.id, stopTimeoutMs))) {
      try {
        pty.kill(task.id, 'SIGKILL');
      } catch {
        // Gone already.
      }
      await waitForExit(task.id, 1000);
    }
    return store.get(task.id) ?? task;
  };

  /** Drop every trace of a task: PTY record, row, and its folder on disk. */
  const forgetTask = async (taskId: string): Promise<void> => {
    // Wait for the terminal mirror to close so deleting the folder cannot race its last write.
    await pty.forget(taskId);
    supervisor.untrack(taskId);
    activity.forget(taskId);
    rawCommands.delete(taskId);
    stopping.delete(taskId);
    store.delete(taskId);
    if (dataDir !== undefined) {
      await fs.promises.rm(taskDir(taskId, dataDir), { recursive: true, force: true }).catch(() => undefined);
    }
  };

  const newId = (input: RunTaskRequest): string => {
    const base = slugOf(input.title ?? '') || slugOf(input.command) || 'task';
    for (;;) {
      const id = `${base}-${crypto.randomBytes(2).toString('hex')}`;
      if (store.get(id) === null) return id;
    }
  };

  const runNow = async (input: RunTaskRequest): Promise<Result<RunTaskResponse>> => {
    if (!cwdExists(input.cwd)) {
      return { ok: false, status: 400, code: 'invalid_cwd', message: `folder ${input.cwd} does not exist` };
    }
    let id = input.id;
    if (id !== undefined) {
      const existing = store.get(id);
      if (existing !== null && isRunning(existing) && input.restart !== true) {
        return { ok: true, status: 200, value: { task: view(existing), alreadyRunning: true } };
      }
      if (existing !== null) {
        await stopTask(existing, false);
        await forgetTask(id);
      }
    } else {
      const same = store
        .list()
        .find((task) => isRunning(task) && task.cwd === input.cwd && rawCommands.get(task.id) === input.command);
      if (same !== undefined) {
        if (input.restart !== true) return { ok: true, status: 200, value: { task: view(same), alreadyRunning: true } };
        await stopTask(same, false);
        await forgetTask(same.id);
        id = same.id;
      }
    }
    id ??= newId(input);

    const git = await gitReader(input.cwd);
    const env = buildSpawnEnv(input.env ?? options.baseEnv ?? process.env);
    const shell = shellFor(input.command, env);
    const cols = input.cols ?? 120;
    const rows = input.rows ?? 32;
    let pid: number;
    try {
      pid = pty.spawn({ taskId: id, file: shell.file, args: shell.args, cwd: input.cwd, env, cols, rows }).pid;
    } catch (error) {
      const message = error instanceof Error ? redactText(error.message) : 'could not start a terminal';
      if (/forkpty|posix_openpt|out of pty|no more pty|EAGAIN/i.test(message) || ptysExhausted()) {
        return {
          ok: false,
          status: 503,
          code: 'pty_limit',
          message: 'The system ran out of pseudo-terminals.',
          hint:
            process.platform === 'darwin'
              ? 'Remove ended tasks with `agenterm clear`, or raise the limit: sudo sysctl -w kern.tty.ptmx_max=999'
              : 'Remove ended tasks with `agenterm clear`, or raise /proc/sys/kernel/pty/max.'
        };
      }
      return { ok: false, status: 500, code: 'spawn_failed', message };
    }
    const task = store.put({
      id,
      title: input.title ?? redactText(input.command).slice(0, 200),
      command: redactText(input.command),
      cwd: input.cwd,
      project: projectOf(input.cwd, git.worktreeRoot),
      projectRoot: git.worktreeRoot,
      branch: git.branch,
      startedBy: input.startedBy ?? null,
      startedByPid: input.startedByPid ?? null,
      pid,
      status: 'running',
      exitCode: null,
      exitSignal: null,
      ports: [],
      cols,
      rows,
      startedAtMs: Date.now(),
      endedAtMs: null
    });
    rawCommands.set(id, input.command);
    supervisor.track(id, pid);
    publish(task);
    return { ok: true, status: 201, value: { task, alreadyRunning: false } };
  };

  /**
   * Runs for the same id, or the same command in the same folder, go one
   * at a time, so two quick identical calls start one task, not two.
   */
  const queues = new Map<string, Promise<unknown>>();
  const run = (input: RunTaskRequest): Promise<Result<RunTaskResponse>> => {
    const key = input.id !== undefined ? `id:${input.id}` : `cmd:${input.cwd}\0${input.command}`;
    const next = (queues.get(key) ?? Promise.resolve()).catch(() => undefined).then(() => runNow(input));
    queues.set(key, next);
    void next.finally(() => {
      if (queues.get(key) === next) queues.delete(key);
    });
    return next;
  };

  // Stop tasks whose starter exited, when the user asked for that.
  const liveness = setInterval(() => {
    if (!settings.stopWithAgent) return;
    for (const task of store.list()) {
      if (!isRunning(task) || task.startedByPid === null || stopping.has(task.id)) continue;
      if (!pidAlive(task.startedByPid)) void stopTask(task, false);
    }
  }, options.livenessIntervalMs ?? 2000);
  liveness.unref();

  app.decorate('agenterm', { activity });

  app.addHook('onClose', async () => {
    clearInterval(liveness);
  });

  app.addHook('onRequest', async (request, reply) => {
    if (request.method === 'GET' && request.url === '/health') return;
    if (!checkBearer(authOf(request), options.token)) {
      await fail(reply, { status: 401, code: 'unauthorized', message: 'missing or invalid bearer token' });
    }
  });

  /** Resolve :id to a task, or reply 400/404 and return null. */
  const loadTask = async (request: FastifyRequest, reply: FastifyReply): Promise<TaskRecord | null> => {
    const parsed = parseTaskId((request.params as { id?: unknown }).id);
    if (!parsed.ok) {
      await fail(reply, { status: 400, code: parsed.code, message: parsed.message });
      return null;
    }
    const task = store.get(parsed.value);
    if (task === null) {
      await fail(reply, { status: 404, code: 'unknown_task', message: `no task ${parsed.value}`, hint: UNKNOWN_HINT });
      return null;
    }
    return task;
  };

  app.get('/health', async (request) => {
    if (!checkBearer(authOf(request), options.token)) {
      return { ok: true as const, version: DAEMON_VERSION, api: API_VERSION };
    }
    return {
      ok: true as const,
      version: DAEMON_VERSION,
      api: API_VERSION,
      uptimeSeconds: Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000)),
      startedAtMs,
      port: options.port,
      pid: process.pid,
      running: store.list().filter(isRunning).length
    };
  });

  app.get('/tasks', async () => {
    const tasks = store.list().map(view);
    // Running first, then newest first.
    tasks.sort((a, b) => Number(isRunning(b)) - Number(isRunning(a)) || b.startedAtMs - a.startedAtMs);
    return { tasks };
  });

  app.post('/tasks', async (request, reply) => {
    const parsed = parseRunTaskRequest(request.body);
    if (!parsed.ok) {
      await fail(reply, { status: 400, code: parsed.code, message: parsed.message });
      return;
    }
    const result = await run(parsed.value);
    if (!result.ok) {
      await fail(reply, result);
      return;
    }
    await reply.code(result.status).send(result.value);
  });

  app.post('/tasks/clear', async () => {
    const removed: string[] = [];
    for (const task of store.list()) {
      if (isRunning(task)) continue;
      await forgetTask(task.id);
      bus.publish({ kind: 'task.removed', taskId: task.id });
      removed.push(task.id);
    }
    return { removed };
  });

  app.get('/tasks/:id', async (request, reply) => {
    const task = await loadTask(request, reply);
    if (task === null) return;
    return { task: view(task) };
  });

  app.post('/tasks/:id/stop', async (request, reply) => {
    const task = await loadTask(request, reply);
    if (task === null) return;
    const parsed = parseStopTaskRequest(request.body);
    if (!parsed.ok) {
      await fail(reply, { status: 400, code: parsed.code, message: parsed.message });
      return;
    }
    return { task: view(await stopTask(task, parsed.value.force === true)) };
  });

  app.delete('/tasks/:id', async (request, reply) => {
    const task = await loadTask(request, reply);
    if (task === null) return;
    const wasRunning = isRunning(task);
    if (wasRunning) await stopTask(task, false);
    await forgetTask(task.id);
    bus.publish({ kind: 'task.removed', taskId: task.id });
    return { removed: true as const, stopped: wasRunning };
  });

  app.post('/tasks/:id/input', async (request, reply) => {
    const task = await loadTask(request, reply);
    if (task === null) return;
    const parsed = parseTaskInputRequest(request.body);
    if (!parsed.ok) {
      await fail(reply, { status: 400, code: parsed.code, message: parsed.message });
      return;
    }
    const managed = pty.get(task.id);
    if (!isRunning(task) || managed === null || managed.exit !== null) {
      await fail(reply, { status: 409, code: 'not_running', message: `task ${task.id} is not running` });
      return;
    }
    pty.write(task.id, parsed.value.data);
    return { acceptedBytes: Buffer.byteLength(parsed.value.data, 'utf8') };
  });

  app.post('/tasks/:id/resize', async (request, reply) => {
    const task = await loadTask(request, reply);
    if (task === null) return;
    const parsed = parseTaskResizeRequest(request.body);
    if (!parsed.ok) {
      await fail(reply, { status: 400, code: parsed.code, message: parsed.message });
      return;
    }
    const managed = pty.get(task.id);
    if (!isRunning(task) || managed === null || managed.exit !== null) {
      await fail(reply, { status: 409, code: 'not_running', message: `task ${task.id} is not running` });
      return;
    }
    pty.resize(task.id, parsed.value.cols, parsed.value.rows);
    if (task.cols !== parsed.value.cols || task.rows !== parsed.value.rows) {
      store.put({ ...task, cols: parsed.value.cols, rows: parsed.value.rows });
    }
    return { task: view(store.get(task.id) ?? task) };
  });

  app.get('/tasks/:id/output', async (request, reply) => {
    const task = await loadTask(request, reply);
    if (task === null) return;
    const parsed = parseTaskOutputQuery(request.query ?? {});
    if (!parsed.ok) {
      await fail(reply, { status: 400, code: parsed.code, message: parsed.message });
      return;
    }
    const managed = pty.get(task.id);
    if (managed !== null && !managed.log.isReleased()) {
      const page = managed.log.read(parsed.value);
      return { taskId: task.id, ...page, live: managed.exit === null };
    }
    const tail =
      dataDir === undefined ? null : await readLogTailAsync(terminalLogPath(task.id, dataDir), parsed.value.tailBytes);
    // An ended task has one immutable chunk; any cursor past it is caught up.
    const chunks =
      tail !== null && tail.length > 0 && (parsed.value.sinceSeq ?? 0) < 1
        ? [{ seq: 1, data: tail, createdAtMs: task.endedAtMs ?? task.startedAtMs }]
        : [];
    return {
      taskId: task.id,
      chunks,
      resumeAfterSeq: chunks.length > 0 ? 1 : null,
      hasMore: false,
      firstSeq: tail !== null && tail.length > 0 ? 1 : null,
      live: false
    };
  });

  app.get('/processes', async (_request, reply) => {
    try {
      return await outside.list();
    } catch (error) {
      await fail(reply, {
        status: 500,
        code: 'scan_failed',
        message: `could not read the process table: ${error instanceof Error ? error.message : String(error)}`
      });
      return;
    }
  });

  app.post('/processes/:pid/stop', async (request, reply) => {
    const pid = parsePid((request.params as { pid?: unknown }).pid);
    if (!pid.ok) {
      await fail(reply, { status: 400, code: pid.code, message: pid.message });
      return;
    }
    const parsed = parseStopProcessRequest(request.body);
    if (!parsed.ok) {
      await fail(reply, { status: 400, code: parsed.code, message: parsed.message });
      return;
    }
    const result = await outside.stop(pid.value, parsed.value);
    if (!result.ok) {
      await fail(reply, result);
      return;
    }
    return { process: result.process, exited: result.exited };
  });

  app.get('/activity', async () => activity.snapshot());

  app.get('/settings', async () => settings);

  app.patch('/settings', async (request, reply) => {
    const parsed = parseSettingsPatch(request.body);
    if (!parsed.ok) {
      await fail(reply, { status: 400, code: parsed.code, message: parsed.message });
      return;
    }
    settings = { ...settings, ...parsed.value };
    try {
      saveSettings(settingsFile, settings);
    } catch {
      // Applies for this run even if the disk write fails.
    }
    return settings;
  });

  return app;
}
