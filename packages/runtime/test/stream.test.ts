import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { EventStream } from '../src/stream.js';
import { rig, TOKEN } from './helpers.js';

type Frame = {
  kind: string;
  event?: { kind: string; taskId: string; seq?: number; data?: string; task?: { status: string } };
  code?: string;
  tick?: { tasks: Record<string, { bytes: number; lastLine: string | null }> };
};

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function listen() {
  const r = rig();
  await r.app.listen({ host: '127.0.0.1', port: 0 });
  const stream = new EventStream({
    server: r.app.server,
    token: TOKEN,
    bus: r.bus,
    pty: r.pty,
    activity: r.app.agenterm.activity,
    activityIntervalMs: 50
  });
  cleanups.push(async () => {
    stream.close();
    await r.app.close();
  });
  const port = (r.app.server.address() as AddressInfo).port;
  return { ...r, stream, url: `ws://127.0.0.1:${port}/events/stream` };
}

function connect(url: string, token = TOKEN): Promise<{ socket: WebSocket; frames: Frame[] }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } });
    const frames: Frame[] = [];
    socket.on('message', (raw) => frames.push(JSON.parse(String(raw)) as Frame));
    socket.on('open', () => resolve({ socket, frames }));
    socket.on('error', reject);
  });
}

async function until(check: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('EventStream', () => {
  it('rejects a bad token before the upgrade completes', async () => {
    const { url } = await listen();
    await expect(connect(url, 'nope')).rejects.toThrow(/401/);
  });

  it('survives malformed and hostile frames', async () => {
    const { url, stream } = await listen();
    const { socket, frames } = await connect(url);
    for (const raw of ['null', '42', '"x"', '[]', '{}', '{"kind":"terminal.input","taskId":"x"}', 'not json']) {
      socket.send(raw);
    }
    await until(() => frames.filter((frame) => frame.kind === 'error').length >= 7);
    const second = await connect(url);
    expect(stream.size()).toBe(2);
    second.socket.close();
    socket.close();
  });

  it('sends terminal bytes only to subscribed clients and replays from a cursor', async () => {
    const { url, spawn, last } = await listen();
    const task = await spawn();
    const watcher = await connect(url);
    const bystander = await connect(url);
    last()?.emitData('before-subscribe');
    watcher.socket.send(JSON.stringify({ kind: 'subscribe', taskId: task.id, sinceSeq: 0 }));
    await until(() => watcher.frames.some((frame) => frame.event?.data === 'before-subscribe'));
    last()?.emitData('live');
    await until(() => watcher.frames.some((frame) => frame.event?.data === 'live'));
    last()?.emitExit(0);
    await until(() =>
      bystander.frames.some((frame) => frame.event?.kind === 'task.updated' && frame.event.task?.status === 'exited')
    );
    expect(bystander.frames.some((frame) => frame.event?.kind === 'terminal.output')).toBe(false);
    watcher.socket.close();
    bystander.socket.close();
  });

  it('accepts input frames for live PTYs only', async () => {
    const { url, spawn, last } = await listen();
    const task = await spawn();
    const { socket, frames } = await connect(url);
    socket.send(JSON.stringify({ kind: 'terminal.input', taskId: task.id, data: 'ls\r' }));
    await until(() => (last()?.written.length ?? 0) > 0);
    expect(last()?.written).toEqual(['ls\r']);
    last()?.emitExit(0);
    socket.send(JSON.stringify({ kind: 'terminal.input', taskId: task.id, data: 'late' }));
    await until(() => frames.some((frame) => frame.code === 'not_running'));
    socket.close();
  });
});

describe('EventStream activity frames', () => {
  it('summarizes every task once per tick without streaming bytes', async () => {
    const { url, spawn, last } = await listen();
    const task = await spawn();
    const { socket, frames } = await connect(url);
    last()?.emitData('\x1b[32mbuilding\x1b[0m\r\n');
    await until(() => frames.some((frame) => frame.kind === 'activity'));
    const tick = frames.find((frame) => frame.kind === 'activity')?.tick;
    expect(tick?.tasks[task.id]).toEqual({ bytes: 19, lastLine: 'building' });
    expect(frames.some((frame) => frame.event?.kind === 'terminal.output')).toBe(false);
    socket.close();
  });
});
