import os from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { buildProgram, shellQuote } from '../src/program.js';
import { daemonRig } from './kit.js';

afterEach(() => {
  process.exitCode = 0;
});

function cli(options: Parameters<typeof daemonRig>[0] = {}, extra: { tty?: boolean; sleep?: () => void } = {}) {
  const daemon = daemonRig(options);
  const out: string[] = [];
  const err: string[] = [];
  const written: string[] = [];
  const program = buildProgram({
    client: () => daemon.client,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    write: (data) => written.push(data),
    sleep: async () => extra.sleep?.(),
    caller: () => ({ name: 'claude', pid: 4242 }),
    cwd: () => os.tmpdir(),
    env: () => ({ PATH: '/caller/bin', SHELL: '/bin/zsh', SECRET_KEY: 'k' }),
    isTTY: () => extra.tty === true,
    spawnDaemon: () => undefined
  });
  program.exitOverride();
  const run = async (...args: string[]) => {
    out.length = 0;
    err.length = 0;
    written.length = 0;
    await program.parseAsync(['node', 'agenterm', ...args]);
  };
  return { ...daemon, run, out, err, written };
}

describe('agenterm run', () => {
  it('starts a command line with the caller details and prints its id', async () => {
    const c = cli();
    await c.run('run', '--wait', '0', 'npm run dev');
    const task = c.store.list()[0];
    expect(task).toMatchObject({ command: 'npm run dev', cwd: os.tmpdir(), startedBy: 'claude', startedByPid: 4242 });
    expect(c.out[0]).toBe(`started ${task?.id}: npm run dev`);
    expect(c.last()?.spawnEnv['PATH']).toBe('/caller/bin');
    expect(c.last()?.spawnEnv['SECRET_KEY']).toBe('k');
  });

  it('quotes program arguments and keeps their flags', async () => {
    const c = cli();
    await c.run('run', '--id', 'web', '--wait', '0', 'python3', '-m', 'http.server', "it's");
    expect(c.store.get('web')?.command).toBe("python3 -m http.server 'it'\\''s'");
  });

  it('never starts the same id twice and says so', async () => {
    const c = cli();
    await c.run('run', '--id', 'web', '--wait', '0', 'npm run dev');
    await c.run('run', '--id', 'web', 'npm run dev');
    expect(c.out[0]).toBe('already running: web (npm run dev)');
    expect(c.fakes).toHaveLength(1);
    await c.run('run', '--id', 'web', '--restart', '--wait', '0', 'npm start');
    expect(c.out[0]).toBe('started web: npm start');
    expect(c.fakes).toHaveLength(2);
  });

  it('shows the first output and fails when the command fails', async () => {
    const c = cli(
      {},
      {
        sleep: () => {
          c.last()?.emitData('\x1b[31mmake: *** No rule\x1b[0m\r\n');
          c.last()?.emitExit(2);
        }
      }
    );
    await c.run('run', '--id', 'build', 'make');
    expect(c.out).toContain('  ended: failed (exit 2)');
    expect(c.out).toContain('make: *** No rule');
    expect(process.exitCode).toBe(1);
  });

  it('accepts the old spawn form', async () => {
    const c = cli();
    await c.run('spawn', '--command', 'npm', '--args', 'run', 'dev', '--wait', '0');
    expect(c.store.list()[0]?.command).toBe('npm run dev');
  });
});

describe('managing tasks', () => {
  it('lists, shows logs, types, stops, and removes by id, title, or prefix', async () => {
    const c = cli();
    await c.run('run', '--id', 'web', '--title', 'Web server', '--wait', '0', 'npm run dev');
    c.last()?.emitData('\x1b[32mready\x1b[0m on :3000\r\n');
    await c.run('ls');
    expect(c.out[0]).toMatch(/^ID\s+STATUS\s+AGE\s+BY/);
    expect(c.out[1]).toMatch(/^web\s+running\s+\d+s\s+claude/);
    await c.run('logs', 'web');
    expect(c.out).toEqual(['ready on :3000']);
    await c.run('input', 'web server', 'y');
    expect(c.last()?.written).toEqual(['y\r']);
    await c.run('stop', 'we');
    expect(c.out).toEqual(['web: stopped']);
    await c.run('stop', 'web');
    expect(c.out).toEqual(['web is not running (stopped)']);
    await c.run('rm', 'web');
    expect(c.out).toEqual(['removed web']);
    await c.run('ls');
    expect(c.out[0]).toMatch(/^no tasks/);
  });

  it('keeps colors in a terminal', async () => {
    const c = cli({}, { tty: true });
    await c.run('run', '--id', 'web', '--wait', '0', 'npm run dev');
    c.last()?.emitData('\x1b[32mready\x1b[0m\r\n');
    await c.run('logs', 'web');
    expect(c.written.join('')).toBe('\x1b[32mready\x1b[0m\r\n');
  });

  it('clears ended tasks and changes settings', async () => {
    const c = cli();
    await c.run('run', '--id', 'a', '--wait', '0', 'true');
    c.last()?.emitExit(0);
    await c.run('run', '--id', 'b', '--wait', '0', 'sleep 9');
    await c.run('clear');
    expect(c.out).toEqual(['removed 1: a']);
    await c.run('settings', '--stop-with-agent', 'on');
    expect(c.out).toEqual(['stop-with-agent: on']);
  });

  it('explains unknown and ambiguous refs', async () => {
    const c = cli();
    await c.run('run', '--id', 'web-1', '--wait', '0', 'a');
    await c.run('run', '--id', 'web-2', '--wait', '0', 'b');
    await c.run('stop', 'web');
    expect(c.err).toEqual(['error: "web" matches 2 tasks: web-2, web-1']);
    await c.run('logs', 'nope');
    expect(c.err).toEqual(['error: no task matches "nope"']);
    expect(process.exitCode).toBe(1);
  });
});

describe('shellQuote', () => {
  it('quotes only what needs it', () => {
    expect(shellQuote('--port=3000')).toBe('--port=3000');
    expect(shellQuote('a b')).toBe("'a b'");
    expect(shellQuote('$HOME')).toBe("'$HOME'");
  });
});
