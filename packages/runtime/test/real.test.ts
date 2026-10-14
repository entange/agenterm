import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { TaskRecord } from '@agenterm/core';
import { createApp } from '../src/server.js';
import { Supervisor } from '../src/supervisor.js';
import { headers, TOKEN } from './helpers.js';

const apps: Array<{ close: () => Promise<unknown> }> = [];
afterEach(async () => {
  while (apps.length > 0) await apps.pop()?.close();
});

function realApp() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenterm-real-'));
  const supervisor = new Supervisor({ intervalMs: 200 });
  const app = createApp({ token: TOKEN, port: 1, dataDir, supervisor, stopGraceMs: 500 });
  apps.push({ close: async () => (supervisor.stop(), app.close()) });
  return app;
}

async function until<T>(read: () => Promise<T>, check: (value: T) => boolean, ms = 5000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (check(value) || Date.now() > deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('real terminals', () => {
  it('runs a shell command line and records its exit', async () => {
    const app = realApp();
    const res = await app.inject({
      method: 'POST',
      url: '/tasks',
      headers,
      payload: {
        command: 'echo "hi $GREETING" && exit 3',
        cwd: os.tmpdir(),
        env: { GREETING: 'there', PATH: '/usr/bin:/bin' }
      }
    });
    const { task } = res.json() as { task: TaskRecord };
    const ended = await until(
      async () =>
        ((await app.inject({ method: 'GET', url: `/tasks/${task.id}`, headers })).json() as { task: TaskRecord }).task,
      (value) => value.status !== 'running'
    );
    expect(ended).toMatchObject({ status: 'failed', exitCode: 3 });
    const out = (await app.inject({ method: 'GET', url: `/tasks/${task.id}/output`, headers })).json() as {
      chunks: Array<{ data: string }>;
    };
    expect(out.chunks.map((chunk) => chunk.data).join('')).toContain('hi there');
  }, 10000);

  it('stops a sleeping command with Ctrl+C, and one that ignores it by ending its tree', async () => {
    const app = realApp();
    const run = async (command: string) =>
      (
        (
          await app.inject({ method: 'POST', url: '/tasks', headers, payload: { command, cwd: os.tmpdir() } })
        ).json() as {
          task: TaskRecord;
        }
      ).task;
    const plain = await run('sleep 30');
    await new Promise((resolve) => setTimeout(resolve, 300));
    const stopped = (await app.inject({ method: 'POST', url: `/tasks/${plain.id}/stop`, headers })).json() as {
      task: TaskRecord;
    };
    expect(stopped.task.status).toBe('stopped');
    const stubborn = await run("trap '' INT; sleep 30");
    await new Promise((resolve) => setTimeout(resolve, 300));
    const started = Date.now();
    const ended = (await app.inject({ method: 'POST', url: `/tasks/${stubborn.id}/stop`, headers })).json() as {
      task: TaskRecord;
    };
    expect(ended.task.status).toBe('stopped');
    expect(Date.now() - started).toBeLessThan(6000);
  }, 20000);
});
