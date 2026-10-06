import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentermEvent } from '@agenterm/core';
import { openDatabase, SqliteCommands, SqliteEvents } from '../src/database.js';
import { EventBus } from '../src/events.js';
import { FileWatch } from '../src/fileWatch.js';
import type { PtyHandle } from '../src/ptyManager.js';
import { PtyManager } from '../src/ptyManager.js';
import { createApp, type CreateAppOptions } from '../src/server.js';
import { SessionStore } from '../src/sessionStore.js';
import { Supervisor } from '../src/supervisor.js';

export const TOKEN = 'test-token-helpers-0123456789abcdef';
export const headers = { authorization: `Bearer ${TOKEN}` };

export interface FakePty extends PtyHandle {
  written: string[];
  signals: string[];
  spawnArgs: string[];
  spawnEnv: Record<string, string>;
  emitData: (data: string) => void;
  emitExit: (code: number, signal?: number) => void;
}

/** App wired with a fake PTY, fake probes, an on-disk data dir, and SQLite. */
export function rig(overrides: Partial<CreateAppOptions> = {}) {
  let pid = 70000;
  const fakes: FakePty[] = [];
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenterm-rig-'));
  const pty = new PtyManager({
    dataDir,
    spawnFn: (_file, args, opts) => {
      let dataCb: ((data: string) => void) | null = null;
      let exitCb: ((event: { exitCode: number; signal?: number }) => void) | null = null;
      const fake: FakePty = {
        pid: pid++,
        written: [],
        signals: [],
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
        },
        resize: () => undefined,
        kill: (signal) => {
          fake.signals.push(signal ?? 'SIGTERM');
          exitCb?.({ exitCode: 137, signal: 9 });
        },
        emitData: (data) => dataCb?.(data),
        emitExit: (code, signal) => exitCb?.(signal === undefined ? { exitCode: code } : { exitCode: code, signal })
      };
      fakes.push(fake);
      return fake;
    }
  });
  const opened = openDatabase(path.join(dataDir, 'agenterm.db'));
  const store = new SessionStore({ dataDir });
  const bus = new EventBus({ dataDir, table: new SqliteEvents(opened.db) });
  const seen: AgentermEvent[] = [];
  bus.onEvent((event) => seen.push(event));
  const killed: number[] = [];
  const supervisor = new Supervisor({ probes: { processes: async () => [], sockets: async () => [] } });
  supervisor.killTree = async (leader: number) => {
    killed.push(leader);
    return [leader];
  };
  const app = createApp({
    token: TOKEN,
    port: 37241,
    store,
    lister: async () => [],
    pty,
    supervisor,
    bus,
    dataDir,
    fileWatch: new FileWatch({ debounceMs: 20 }),
    commandsDb: new SqliteCommands(opened.db),
    gitReader: async () => ({ branch: null, worktreeRoot: null }),
    baseEnv: {
      HOME: '/home/agent',
      USER: 'agent',
      PATH: process.env['PATH'] ?? '/usr/bin:/bin',
      ELECTRON_RUN_AS_NODE: '1'
    },
    ...overrides
  });
  const spawn = async (payload: Record<string, unknown> = {}) => {
    const res = await app.inject({
      method: 'POST',
      url: '/sessions',
      headers,
      payload: { provider: 'generic', command: '/bin/echo', cwd: '/tmp', ...payload }
    });
    if (res.statusCode !== 201) throw new Error(`spawn failed ${res.statusCode} ${res.body}`);
    return (res.json() as { session: { id: string; pid: number } }).session;
  };
  return { app, pty, store, bus, seen, fakes, killed, dataDir, spawn, last: () => fakes[fakes.length - 1] };
}
