import path from 'node:path';
import {
  AgentermApiError,
  API_VERSION,
  isRunning,
  plainText,
  statusText,
  VERSION,
  type AgentermClient,
  type HealthResponse
} from '@agenterm/core';
import { Command, Option } from 'commander';
import type { Caller } from './caller.js';
import { daemonEntry, daemonLogTail, dataDir, pidAlive, readLock, startDaemonProcess } from './local.js';
import { runMcpStdio } from './mcp.js';
import {
  cleanEnv,
  resolveTask,
  runSummary,
  settle,
  settledReport,
  startTask,
  tailLines,
  taskFacts,
  taskTable
} from './ops.js';

/** Side effects the program needs. Tests inject stubs. */
export interface CliDeps {
  client: () => AgentermClient;
  out: (line: string) => void;
  err: (line: string) => void;
  write: (data: string) => void;
  sleep: (ms: number) => Promise<void>;
  /** The program that ran us, for "started by". */
  caller: () => Caller | null;
  cwd: () => string;
  env: () => NodeJS.ProcessEnv;
  /** True when stdout is a terminal; logs keep colors only then. */
  isTTY: () => boolean;
  /** Start the daemon in the background. Defaults to the local build. */
  spawnDaemon?: (() => void) | undefined;
}

/** Thrown for user-facing failures that need no stack trace. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly hint?: string
  ) {
    super(message);
  }
}

/**
 * A daemon from another install (an older CLI, or the app) that speaks a
 * different API. Older ones are missing routes; newer ones may answer
 * differently than this CLI expects.
 */
function mismatch(health: HealthResponse): 'older' | 'newer' | null {
  const api = health.api ?? 1;
  if (api === API_VERSION) return null;
  return api < API_VERSION ? 'older' : 'newer';
}

function mismatchError(health: HealthResponse, kind: 'older' | 'newer'): CliError {
  if (kind === 'newer') {
    return new CliError(
      `the agenterm daemon (${health.version}) is newer than this CLI (${VERSION}).`,
      'update the CLI: `npm install -g agenterm@latest`'
    );
  }
  const running = health.running ?? 0;
  return new CliError(
    `the agenterm daemon running now is an older version (${health.version}), with ${running} running ${running === 1 ? 'task' : 'tasks'}.`,
    '`agenterm daemon restart` updates it. Its running tasks stop.'
  );
}

function positiveInt(text: string, name: string): number {
  const value = Number(text);
  if (!Number.isInteger(value) || value < 1) throw new CliError(`${name} must be a positive integer`);
  return value;
}

function isConnectionRefused(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const cause = (error as Error & { cause?: { code?: string } }).cause;
  return cause?.code === 'ECONNREFUSED' || /ECONNREFUSED|fetch failed/.test(error.message);
}

/** Quote one argument for a POSIX shell, only when it needs it. */
export function shellQuote(arg: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** Build the CLI. Kept free of process globals so tests drive real commands. */
export function buildProgram(deps: CliDeps): Command {
  const program = new Command();
  program
    .name('agenterm')
    .description('Run long-running commands in terminals you can watch, type into, and stop from anywhere.')
    .version(VERSION)
    .enablePositionalOptions()
    .showHelpAfterError()
    .addHelpText(
      'after',
      `
Examples:
  agenterm run "npm run dev"                start it; prints its id
  agenterm run --id web -- npm run dev      pick the id yourself
  agenterm ls                               what is running
  agenterm logs web                         recent output
  agenterm stop web                         Ctrl+C, then end it
  agenterm rm web                           stop and forget it

Running the same id, or the same command in the same folder, again returns
the running task instead of starting a second one. Add --restart to replace it.`
    );

  /** Wrap an action with friendly error output and a non-zero exit code. */
  const run =
    <A extends unknown[]>(action: (...args: A) => Promise<void> | void) =>
    async (...args: A): Promise<void> => {
      try {
        await action(...args);
      } catch (error) {
        process.exitCode = 1;
        if (error instanceof AgentermApiError && error.status === 404 && error.code === 'http_error') {
          // A missing route, not a missing task: the daemon is from another version.
          const health = await deps
            .client()
            .health()
            .catch(() => null);
          const kind = health === null ? null : mismatch(health);
          if (health !== null && kind !== null) error = mismatchError(health, kind);
        }
        if (error instanceof AgentermApiError) {
          deps.err(`error: ${error.message}`);
          if (error.hint !== undefined) deps.err(`hint: ${error.hint}`);
          return;
        }
        if (isConnectionRefused(error)) {
          deps.err('error: the agenterm daemon is not running, so nothing is running.');
          deps.err('hint: `agenterm run "<command>"` starts it, or `agenterm daemon start`.');
          return;
        }
        deps.err(`error: ${error instanceof Error ? error.message : String(error)}`);
        if (error instanceof CliError && error.hint !== undefined) deps.err(`hint: ${error.hint}`);
      }
    };

  /**
   * The lock's pid only counts when the daemon on the lock's port answers
   * with that same pid. A crash leaves a lock behind, and the pid may since
   * belong to an unrelated process that must never be signaled.
   */
  const runningDaemon = async (): Promise<{ pid: number; port: number; version: string } | null> => {
    const lock = readLock();
    if (lock === null || !pidAlive(lock.pid)) return null;
    const health = await deps
      .client()
      .health()
      .catch(() => null);
    if (health === null || health.pid !== lock.pid) return null;
    return { pid: lock.pid, port: lock.port, version: health.version };
  };

  /** Signal the daemon and wait for it to exit. */
  const stopDaemon = async (pid: number): Promise<void> => {
    process.kill(pid, 'SIGTERM');
    // The daemon allows itself 4s to end tasks before it exits regardless.
    for (let i = 0; i < 80 && pidAlive(pid); i++) await deps.sleep(100);
    if (pidAlive(pid)) throw new CliError(`daemon pid ${pid} is still running after 8s`);
  };

  /**
   * Start the daemon unless it already answers. An older daemon with nothing
   * running is replaced quietly; one with running tasks is left alone and
   * reported, since replacing it would end them.
   */
  const ensureDaemon = async (): Promise<{ started: boolean }> => {
    const answers = async (): Promise<boolean> =>
      deps
        .client()
        .health()
        .then(() => true)
        .catch(() => false);
    const health = await deps
      .client()
      .health()
      .catch(() => null);
    if (health !== null) {
      const kind = mismatch(health);
      if (kind === null) return { started: false };
      const running = await runningDaemon();
      if (kind === 'newer' || (health.running ?? 0) > 0 || running === null) throw mismatchError(health, kind);
      deps.err(`note: replacing the agenterm daemon ${health.version} with ${VERSION}.`);
      await stopDaemon(running.pid);
    }
    if (deps.spawnDaemon !== undefined) {
      deps.spawnDaemon();
    } else {
      const entry = daemonEntry();
      if (entry === null) {
        throw new CliError(
          'cannot find the daemon next to this CLI. Reinstall agenterm, or run `bun run build` in a checkout.'
        );
      }
      startDaemonProcess(entry);
    }
    for (let i = 0; i < 50; i++) {
      await deps.sleep(100);
      if (await answers()) return { started: true };
    }
    throw new CliError(`the daemon did not answer within 5s. See ${path.join(dataDir(), 'daemon.log')}.`);
  };

  const runAction = async (
    words: string[],
    opts: {
      id?: string;
      title?: string;
      cwd?: string;
      agent?: string;
      restart?: boolean;
      wait: string;
      json?: boolean;
    }
  ): Promise<void> => {
    if (words.length === 0) throw new CliError('a command is required, e.g. agenterm run "npm run dev"');
    // One word is a full command line ("npm run dev"); several came after `--` and are quoted back.
    const command = words.length === 1 ? (words[0] ?? '') : words.map(shellQuote).join(' ');
    const waitSeconds = Number(opts.wait);
    if (!Number.isFinite(waitSeconds) || waitSeconds < 0 || waitSeconds > 60) {
      throw new CliError('--wait must be 0-60 seconds');
    }
    await ensureDaemon();
    const client = deps.client();
    const env = deps.env();
    const result = await startTask(
      client,
      {
        command,
        cwd: path.resolve(deps.cwd(), opts.cwd ?? '.'),
        id: opts.id,
        title: opts.title,
        agent: opts.agent ?? env['AGENTERM_AGENT'],
        restart: opts.restart,
        env: cleanEnv(env)
      },
      deps.caller()
    );
    const task =
      result.alreadyRunning || waitSeconds === 0
        ? result.task
        : await settle(client, result.task, waitSeconds * 1000, deps.sleep);
    if (opts.json === true) {
      deps.out(JSON.stringify({ ...result, task }, null, 2));
      return;
    }
    for (const line of runSummary({ ...result, task })) deps.out(line);
    if (!result.alreadyRunning && waitSeconds > 0) {
      for (const line of settledReport(task, await tailLines(client, task.id, 20))) deps.out(line);
    }
    if (!isRunning(task) && task.status === 'failed') process.exitCode = 1;
  };

  const addRunOptions = (command: Command): Command =>
    command
      .option('--id <id>', 'id to give the task (letters, digits, . _ -); reusing it never starts a duplicate')
      .option('-t, --title <title>', 'human title (defaults to the command)')
      .option('-C, --cwd <dir>', 'folder to run in (defaults to the current one)')
      .option('--agent <name>', 'who is starting it (detected when omitted)')
      .option('--restart', 'replace the task if it is already running')
      .option('--wait <seconds>', 'seconds to wait and show first output', '2')
      .option('--json', 'print the task as JSON');

  addRunOptions(
    program
      .command('run [command...]')
      .description('Start a command in a new terminal, or return the one already running')
      .usage('[options] "<command line>"  |  [options] <program> [args...]')
      // Everything after the command belongs to it: `agenterm run --id web npm start -p 3000`.
      .passThroughOptions()
  ).action(run(runAction));

  // Older docs and scripts used `spawn --command x --args a b`.
  const spawn = addRunOptions(new Command('spawn').option('--command <program>').option('--args <args...>')).action(
    run(async (opts: { command?: string; args?: string[] } & Parameters<typeof runAction>[1]) => {
      if (opts.command === undefined) throw new CliError('--command is required');
      const args = opts.args ?? [];
      await runAction(args.length === 0 ? [opts.command] : [opts.command, ...args], opts);
    })
  );
  program.addCommand(spawn, { hidden: true });

  program
    .command('ls')
    .alias('list')
    .description('List tasks, running first')
    .option('--running', 'only running tasks')
    .option('--json', 'print JSON')
    .action(
      run(async (opts: { running?: boolean; json?: boolean }) => {
        const { tasks } = await deps.client().listTasks();
        const shown = opts.running === true ? tasks.filter(isRunning) : tasks;
        if (opts.json === true) {
          deps.out(JSON.stringify(shown, null, 2));
          return;
        }
        if (shown.length === 0 && tasks.length > 0) {
          deps.out('nothing is running.');
          return;
        }
        for (const line of taskTable(shown)) deps.out(line);
      })
    );

  program
    .command('show <task>')
    .description('Show one task')
    .option('--json', 'print JSON')
    .action(
      run(async (ref: string, opts: { json?: boolean }) => {
        const task = await resolveTask(deps.client(), ref);
        if (opts.json === true) {
          deps.out(JSON.stringify(task, null, 2));
          return;
        }
        deps.out(`${task.id}: ${task.command}`);
        deps.out(`  ${taskFacts(task)}`);
      })
    );

  program
    .command('logs <task>')
    .description('Print recent output; -f keeps printing until it ends')
    .option('-n, --lines <n>', 'how many lines', '100')
    .option('-f, --follow', 'keep printing new output')
    .addOption(new Option('--plain', 'strip colors and escape codes (default when piped)').conflicts('raw'))
    .addOption(new Option('--raw', 'keep colors and escape codes (default in a terminal)'))
    .action(
      run(async (ref: string, opts: { lines: string; follow?: boolean; plain?: boolean; raw?: boolean }) => {
        const client = deps.client();
        const task = await resolveTask(client, ref);
        const lines = positiveInt(opts.lines, '--lines');
        const plain = opts.plain === true || (opts.raw !== true && !deps.isTTY());
        let cursor = 0;
        let live: boolean;
        if (plain) {
          for (const line of await tailLines(client, task.id, lines)) deps.out(line);
          if (opts.follow !== true) return;
          // The newest chunk only, to learn where the tail ended.
          const page = await client.output(task.id, { tailBytes: 1 });
          cursor = page.resumeAfterSeq ?? 0;
          live = page.live;
        } else {
          const page = await client.output(task.id, { tailBytes: Math.min(1_048_576, lines * 400), limit: 1000 });
          for (const chunk of page.chunks) deps.write(chunk.data);
          cursor = page.resumeAfterSeq ?? 0;
          live = page.live;
        }
        if (opts.follow !== true) return;
        while (live) {
          await deps.sleep(250);
          const page = await client.output(task.id, { sinceSeq: cursor, limit: 1000 });
          for (const chunk of page.chunks) deps.write(plain ? plainText(chunk.data) : chunk.data);
          cursor = page.resumeAfterSeq ?? cursor;
          live = page.live || page.hasMore;
        }
        deps.err(`[${task.id} ${statusText((await client.getTask(task.id)).task)}]`);
      })
    );

  program
    .command('input <task> <text...>')
    .description('Type into a task, then press Enter (unless --no-enter)')
    .option('--no-enter', 'do not press Enter after the text')
    .action(
      run(async (ref: string, words: string[], opts: { enter: boolean }) => {
        const client = deps.client();
        const task = await resolveTask(client, ref);
        const data = `${words.join(' ')}${opts.enter ? '\r' : ''}`;
        await client.sendInput(task.id, { data });
        deps.out(`sent ${Buffer.byteLength(data, 'utf8')} bytes to ${task.id}`);
      })
    );

  program
    .command('stop <task...>')
    .description('Stop tasks: Ctrl+C, then end the process tree; --force kills right away')
    .option('--force', 'kill immediately')
    .action(
      run(async (refs: string[], opts: { force?: boolean }) => {
        const client = deps.client();
        for (const ref of refs) {
          const task = await resolveTask(client, ref);
          if (!isRunning(task)) {
            deps.out(`${task.id} is not running (${statusText(task)})`);
            continue;
          }
          const stopped = (await client.stop(task.id, { force: opts.force === true })).task;
          deps.out(`${task.id}: ${statusText(stopped)}`);
        }
      })
    );

  program
    .command('rm <task...>')
    .alias('remove')
    .description('Remove tasks and their output, stopping them first if running')
    .action(
      run(async (refs: string[]) => {
        const client = deps.client();
        for (const ref of refs) {
          const task = await resolveTask(client, ref);
          const result = await client.remove(task.id);
          deps.out(`removed ${task.id}${result.stopped ? ' (stopped it first)' : ''}`);
        }
      })
    );

  program
    .command('clear')
    .description('Remove every task that is no longer running')
    .action(
      run(async () => {
        const { removed } = await deps.client().clearEnded();
        deps.out(removed.length === 0 ? 'nothing to clear.' : `removed ${removed.length}: ${removed.join(', ')}`);
      })
    );

  program
    .command('settings')
    .description('Show or change daemon settings')
    .addOption(
      new Option('--stop-with-agent <on|off>', 'stop a task when the program that started it exits').choices([
        'on',
        'off'
      ])
    )
    .action(
      run(async (opts: { stopWithAgent?: 'on' | 'off' }) => {
        const client = deps.client();
        const settings =
          opts.stopWithAgent === undefined
            ? await client.settings()
            : await client.updateSettings({ stopWithAgent: opts.stopWithAgent === 'on' });
        deps.out(`stop-with-agent: ${settings.stopWithAgent ? 'on' : 'off'}`);
      })
    );

  const daemon = program.command('daemon').description('Start, stop, and inspect the background daemon');

  daemon
    .command('status', { isDefault: true })
    .description('Show whether the daemon is running')
    .action(
      run(async () => {
        const running = await runningDaemon();
        if (running === null) {
          deps.out('daemon not running.');
          return;
        }
        const health = await deps.client().health();
        deps.out(
          `daemon ${running.version} · pid ${running.pid} · port ${running.port} · up ${health.uptimeSeconds ?? '?'}s · ${health.running ?? 0} running`
        );
      })
    );

  daemon
    .command('start')
    .description('Start the daemon in the background if it is not running')
    .action(
      run(async () => {
        const { started } = await ensureDaemon();
        const lock = readLock();
        const where = lock === null ? '' : ` (pid ${lock.pid}, port ${lock.port})`;
        deps.out(started ? `daemon started${where}.` : `daemon already running${where}.`);
      })
    );

  daemon
    .command('stop')
    .description('Stop the daemon. Every running task ends with it.')
    .action(
      run(async () => {
        const lock = await runningDaemon();
        if (lock === null) {
          const stale = readLock();
          if (stale !== null && pidAlive(stale.pid)) {
            // Could be a wedged daemon or a recycled pid; only the user can tell which.
            throw new CliError(
              `the lock names pid ${stale.pid}, but no daemon answers on port ${stale.port}. ` +
                `If that pid is agentermd, stop it with \`kill ${stale.pid}\`.`
            );
          }
          deps.out('daemon not running.');
          return;
        }
        await stopDaemon(lock.pid);
        deps.out('daemon stopped.');
      })
    );

  daemon
    .command('restart')
    .description('Stop the daemon and start this version of it. Every running task ends.')
    .action(
      run(async () => {
        const lock = await runningDaemon();
        if (lock !== null) await stopDaemon(lock.pid);
        await ensureDaemon();
        const next = readLock();
        deps.out(`daemon ${VERSION} started${next === null ? '' : ` (pid ${next.pid}, port ${next.port})`}.`);
      })
    );

  daemon
    .command('logs')
    .description('Print the tail of the daemon log')
    .option('-n, --lines <n>', 'line count', '40')
    .action(
      run((opts: { lines: string }) => {
        const lines = daemonLogTail(positiveInt(opts.lines, '--lines'));
        if (lines.length === 0) deps.out('daemon log is empty.');
        for (const line of lines) deps.out(line);
      })
    );

  program
    .command('mcp')
    .description('Serve the Model Context Protocol on stdio, with the same tools as this CLI')
    .addHelpText(
      'after',
      '\nAdd to Claude Code:  claude mcp add agenterm -- agenterm mcp\nAdd to Codex:        codex mcp add agenterm -- agenterm mcp'
    )
    .action(async () => {
      await runMcpStdio({
        client: deps.client,
        version: VERSION,
        caller: deps.caller,
        cwd: deps.cwd,
        env: deps.env,
        sleep: deps.sleep,
        ensureDaemon: async () => {
          await ensureDaemon();
        }
      });
    });

  return program;
}
