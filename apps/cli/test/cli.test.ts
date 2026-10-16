import os from 'node:os';
import { AgentermApiError, API_VERSION, VERSION, type AgentermClient } from '@agenterm/core';
import { afterEach, describe, expect, it } from 'vitest';
import { buildProgram, shellQuote } from '../src/program.js';
import { daemonRig, fakeOutside, outsideProcess } from './kit.js';

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
    expect(c.err).toEqual(['error: "web" matches 2 tasks: web-1, web-2']);
    await c.run('logs', 'nope');
    expect(c.err).toEqual(['error: no task matches "nope"']);
    expect(process.exitCode).toBe(1);
  });
});

describe('commands outside agenterm', () => {
  it('lists them with who started each, and marks orphans', async () => {
    const { outside } = fakeOutside([
      outsideProcess(),
      outsideProcess({ pid: 900, pids: [900], command: 'cargo watch', startedBy: 'codex', orphaned: false, ports: [] })
    ]);
    const c = cli({ outside });
    await c.run('ps');
    expect(c.out[0]).toBe('Orphaned (1): what started it has exited');
    expect(c.out[1]).toMatch(/^PID\s+AGE\s+PORTS\s+CPU\s+MEM\s+FOLDER\s+COMMAND/);
    expect(c.out[2]).toMatch(/^4821\s+2h\s+:4000\s+1%\s+52MB\s+\/work\/api\s+node server\.js --port 4000/);
    expect(c.out[3]).toBe('');
    expect(c.out[4]).toBe('In other terminals and agents (1)');
    expect(c.out[5]).toMatch(/^PID\s+AGE\s+BY\s+PORTS\s+CPU\s+MEM\s+FOLDER\s+COMMAND/);
    expect(c.out[6]).toMatch(/^900\s+2h\s+codex\s+-\s+/);
    expect(c.out.at(-1)).toMatch(/^`agenterm kill <pid>` ends one/);
    await c.run('ps', '--orphaned', '--json');
    expect((JSON.parse(c.out.join('\n')) as Array<{ pid: number }>).map((entry) => entry.pid)).toEqual([4821]);
  });

  it('says when nothing is running', async () => {
    const c = cli({ outside: fakeOutside([]).outside });
    await c.run('ps');
    expect(c.out).toEqual(['nothing is running outside agenterm.']);
  });

  it('kills a listed command and refuses others', async () => {
    const { outside, stopped } = fakeOutside([outsideProcess()]);
    const c = cli({ outside });
    await c.run('kill', '4821', '--force');
    expect(c.out).toEqual(['ended 4821 (node server.js --port 4000, 2 processes)']);
    expect(stopped).toEqual([{ pid: 4821, force: true }]);
    await c.run('kill', '77');
    expect(c.err[0]).toMatch(/pid 77 is not listed/);
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

describe('a daemon from another version', () => {
  function against(health: Record<string, unknown>) {
    const out: string[] = [];
    const err: string[] = [];
    let spawned = 0;
    const missingRoute = async (): Promise<never> => {
      throw new AgentermApiError(404, 'http_error', 'request failed with status 404');
    };
    const client = { health: async () => ({ ok: true, ...health }), listTasks: missingRoute, run: missingRoute };
    const program = buildProgram({
      client: () => client as unknown as AgentermClient,
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      write: () => undefined,
      sleep: async () => undefined,
      caller: () => null,
      cwd: () => os.tmpdir(),
      env: () => ({}),
      isTTY: () => false,
      spawnDaemon: () => void spawned++
    });
    program.exitOverride();
    const run = async (...args: string[]) => {
      out.length = 0;
      err.length = 0;
      await program.parseAsync(['node', 'agenterm', ...args]);
    };
    return { run, out, err, spawned: () => spawned };
  }

  it('explains an older daemon instead of printing a bare 404', async () => {
    const c = against({ version: '0.0.9', running: 2 });
    await c.run('ls');
    expect(c.err).toEqual([
      'error: the agenterm daemon running now is an older version (0.0.9), with 2 running tasks.',
      'hint: `agenterm daemon restart` updates it. Its running tasks stop.'
    ]);
    expect(process.exitCode).toBe(1);
  });

  it('does not start tasks on an older daemon that is still running some', async () => {
    const c = against({ version: '0.0.9', running: 1 });
    await c.run('run', '--wait', '0', 'npm run dev');
    expect(c.err[0]).toContain('older version (0.0.9), with 1 running task.');
    expect(c.spawned()).toBe(0);
  });

  it('asks for a CLI update when the daemon is newer', async () => {
    const c = against({ version: '9.0.0', api: API_VERSION + 1, running: 0 });
    await c.run('run', '--wait', '0', 'npm run dev');
    expect(c.err).toEqual([
      `error: the agenterm daemon (9.0.0) is newer than this CLI (${VERSION}).`,
      'hint: update the CLI: `npm install -g agenterm@latest`'
    ]);
  });
});
