import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentermEvent, TaskRecord } from '@agenterm/core';
import { openDatabase, TaskTable } from '../src/database.js';
import { EventBus } from '../src/events.js';
import type { PtyHandle } from '../src/ptyManager.js';
import { PtyManager } from '../src/ptyManager.js';
import { createApp, type CreateAppOptions } from '../src/server.js';
import { Supervisor } from '../src/supervisor.js';
import { TaskStore } from '../src/taskStore.js';

export const TOKEN = 'test-token-helpers-0123456789abcdef';
export const headers = { authorization: `Bearer ${TOKEN}` };

export interface FakePty extends PtyHandle {
  written: string[];
  signals: string[];
  file: string;
  spawnArgs: string[];
  spawnEnv: Record<string, string>;
  emitData: (data: string) => void;
  emitExit: (code: number, signal?: number) => void;
}

export interface RigOptions extends Partial<CreateAppOptions> {
  /** Fake commands ignore Ctrl+C, like a program that traps SIGINT. */
  ignoreInterrupt?: boolean;
}

/** App wired with a fake PTY, fake probes, an on-disk data dir, and SQLite. */
export function rig(overrides: RigOptions = {}) {
  let pid = 70000;
  const fakes: FakePty[] = [];
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenterm-rig-'));
  const pty = new PtyManager({
    dataDir,
    spawnFn: (file, args, opts) => {
      let dataCb: ((data: string) => void) | null = null;
      let exitCb: ((event: { exitCode: number; signal?: number }) => void) | null = null;
      let exited = false;
      const fake: FakePty = {
        pid: pid++,
        written: [],
        signals: [],
        file,
        spawnArgs: args,
        spawnEnv: opts.env,
        onData: (cb) => {
          dataCb = cb;
        },
        onExit: (cb) => {
          exitCb = cb;
        },
        write: (data) => {
          fake.written.push(data);
          if (data === '\x03' && overrides.ignoreInterrupt !== true) setTimeout(() => fake.emitExit(130), 5);
        },
        resize: () => undefined,
        kill: (signal) => {
          fake.signals.push(signal ?? 'SIGTERM');
          fake.emitExit(137, 9);
        },
        emitData: (data) => dataCb?.(data),
        emitExit: (code, signal) => {
          if (exited) return;
          exited = true;
          exitCb?.(signal === undefined ? { exitCode: code } : { exitCode: code, signal });
        }
      };
      fakes.push(fake);
      return fake;
    }
  });
  const table = new TaskTable(openDatabase(path.join(dataDir, 'agenterm.db')));
  const store = new TaskStore(table);
  const bus = new EventBus();
  const seen: AgentermEvent[] = [];
  bus.onEvent((event) => seen.push(event));
  const killed: Array<{ pid: number; force: boolean }> = [];
  const supervisor = new Supervisor({ probes: { processes: async () => [], sockets: async () => [] } });
  supervisor.killTree = async (leader: number, options: { force?: boolean } = {}) => {
    killed.push({ pid: leader, force: options.force === true });
    setTimeout(() => fakes.find((fake) => fake.pid === leader)?.emitExit(143, 15), 5);
    return [leader];
  };
  const { ignoreInterrupt: _ignore, ...appOverrides } = overrides;
  const app = createApp({
    token: TOKEN,
    port: 37241,
    store,
    pty,
    supervisor,
    bus,
    dataDir,
    gitReader: async () => ({ branch: null, worktreeRoot: null }),
    baseEnv: {
      HOME: '/home/agent',
      USER: 'agent',
      SHELL: '/bin/zsh',
      PATH: process.env['PATH'] ?? '/usr/bin:/bin',
      ELECTRON_RUN_AS_NODE: '1'
    },
    stopGraceMs: 30,
    stopTimeoutMs: 200,
    ...appOverrides
  });
  const run = async (payload: Record<string, unknown> = {}) => {
    const res = await app.inject({
      method: 'POST',
      url: '/tasks',
      headers,
      payload: { command: 'npm run dev', cwd: os.tmpdir(), ...payload }
    });
    if (res.statusCode !== 201 && res.statusCode !== 200) throw new Error(`run failed ${res.statusCode} ${res.body}`);
    return res.json() as { task: TaskRecord; alreadyRunning: boolean };
  };
  return {
    app,
    pty,
    store,
    table,
    bus,
    seen,
    fakes,
    killed,
    dataDir,
    run,
    spawn: async (payload: Record<string, unknown> = {}) => (await run(payload)).task,
    last: () => fakes[fakes.length - 1]
  };
}
