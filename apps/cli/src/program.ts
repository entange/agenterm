import fs from 'node:fs';
import path from 'node:path';
import {
  AgentermApiError,
  type AgentermClient,
  parseAgentProvider,
  type AttachSessionRequest,
  type ListSessionsQuery,
  type SessionRecord,
  type SessionSignalName,
  type SpawnSessionRequest
} from '@agenterm/core';
import { Command } from 'commander';
import { runMcpStdio } from './mcp.js';
import { daemonEntry, daemonLogTail, dataDir, pidAlive, readLock, startDaemonProcess } from './local.js';

/** Side effects the program needs. Tests inject stubs. */
export interface CliDeps {
  client: () => AgentermClient;
  out: (line: string) => void;
  err: (line: string) => void;
  write: (data: string) => void;
  /** Ask a yes/no or free-text question. Resolves to the trimmed answer. */
  ask: (question: string) => Promise<string>;
  sleep: (ms: number) => Promise<void>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Thrown for user-facing failures that need no stack trace. */
export class CliError extends Error {}

/** Parse a whole-number option or fail with the option's name. */
function positiveInt(text: string, name: string): number {
  const value = Number(text);
  if (!Number.isInteger(value) || value < 1) throw new CliError(`${name} must be a positive integer`);
  return value;
}

/** Compact age like 45s, 12m, 3h, 2d. */
export function formatAge(fromMs: number, nowMs = Date.now()): string {
  const seconds = Math.max(0, Math.floor((nowMs - fromMs) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

function truncate(text: string, width: number): string {
  return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`;
}

/** Left-aligned columns sized to content. The last column is never padded. */
export function table(rows: string[][]): string[] {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  }
  return rows.map((row) =>
    row
      .map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i] ?? 0)))
      .join('  ')
      .trimEnd()
  );
}

/** Human status combining lifecycle truth with the overlay. */
export function statusLabel(session: SessionRecord): string {
  if (session.lifecycle !== 'running') {
    const detail = session.exitSignal ?? (session.exitCode === null ? null : String(session.exitCode));
    return detail === null ? session.lifecycle : `${session.lifecycle} (${detail})`;
  }
  return session.overlay === 'unknown' ? 'running' : session.overlay.replace('_', ' ');
}

function shortPath(cwd: string): string {
  const home = process.env['HOME'];
  return home !== undefined && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
}

/**
 * Resolve a full session id or a unique prefix, like git short hashes.
 * Fails with the candidates listed when the prefix is ambiguous.
 */
export async function resolveSessionId(client: AgentermClient, idOrPrefix: string): Promise<SessionRecord> {
  idOrPrefix = idOrPrefix.trim();
  // An empty prefix would match every session.
  if (idOrPrefix.length === 0) throw new CliError('a session id or prefix is required');
  const { sessions } = await client.listSessions();
  if (UUID.test(idOrPrefix)) {
    const exact = sessions.find((session) => session.id === idOrPrefix.toLowerCase());
    if (exact === undefined) throw new CliError(`no session ${idOrPrefix}`);
    return exact;
  }
  const matches = sessions.filter((session) => session.id.startsWith(idOrPrefix.toLowerCase()));
  if (matches.length === 1 && matches[0] !== undefined) return matches[0];
  if (matches.length === 0) throw new CliError(`no session matches "${idOrPrefix}"`);
  throw new CliError(
    `"${idOrPrefix}" is ambiguous: ${matches.map((session) => `${session.id.slice(0, 8)} (${session.title})`).join(', ')}`
  );
}

function isConnectionRefused(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const cause = (error as Error & { cause?: { code?: string } }).cause;
  return cause?.code === 'ECONNREFUSED' || /ECONNREFUSED|fetch failed/.test(error.message);
}

/** Build the CLI. Kept free of process globals so tests drive real commands. */
export function buildProgram(deps: CliDeps): Command {
  const program = new Command();
  program
    .name('agenterm')
    .description('Local control center for agents, terminals, processes, and workspaces')
    .version('0.1.0')
    .showHelpAfterError();

  /** Wrap an action with friendly error output and a non-zero exit code. */
  const run =
    <A extends unknown[]>(action: (...args: A) => Promise<void> | void) =>
    async (...args: A): Promise<void> => {
      try {
        await action(...args);
      } catch (error) {
        process.exitCode = 1;
        if (error instanceof AgentermApiError) {
          deps.err(`error: ${error.message}`);
          if (error.hint !== undefined) deps.err(`hint: ${error.hint}`);
          return;
        }
        if (error instanceof CliError) {
          deps.err(`error: ${error.message}`);
          return;
        }
        if (isConnectionRefused(error)) {
          deps.err('error: the agenterm daemon is not running.');
          deps.err('hint: start it with `agenterm daemon start`.');
          return;
        }
        deps.err(`error: ${error instanceof Error ? error.message : String(error)}`);
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

  const confirm = async (question: string): Promise<boolean> => {
    const answer = (await deps.ask(`${question} [y/N] `)).toLowerCase();
    return answer === 'y' || answer === 'yes';
  };

  program
    .command('status')
    .description('Show daemon liveness, version, uptime, and live sessions')
    .action(
      run(async () => {
        const health = await deps.client().health();
        deps.out(
          `agentermd ${health.version} · up ${health.uptimeSeconds ?? '?'}s · port ${health.port ?? '?'} · ${health.liveSessions ?? 0} live sessions`
        );
      })
    );

  const daemon = program.command('daemon').description('Start, stop, and inspect the background daemon');

  daemon
    .command('status', { isDefault: true })
    .description('Show the lock file and whether the daemon answers')
    .action(
      run(async () => {
        const lock = readLock();
        if (lock === null || !pidAlive(lock.pid)) {
          deps.out('daemon not running.');
          return;
        }
        const health = await deps
          .client()
          .health()
          .catch(() => null);
        deps.out(
          `daemon pid=${lock.pid} port=${lock.port} ${health === null ? 'not answering' : `healthy (${health.version})`}`
        );
      })
    );

  daemon
    .command('start')
    .description('Start the daemon in the background if it is not running')
    .action(
      run(async () => {
        const running = await runningDaemon();
        if (running !== null) {
          deps.out(`daemon already running (pid ${running.pid}, port ${running.port}).`);
          return;
        }
        const entry = daemonEntry();
        if (entry === null) {
          throw new CliError('cannot find the daemon build. Run `bun run build` or set AGENTERM_DAEMON_ENTRY.');
        }
        startDaemonProcess(entry);
        for (let i = 0; i < 50; i++) {
          await deps.sleep(100);
          const next = readLock();
          if (next === null) continue;
          const ok = await deps
            .client()
            .health()
            .then(() => true)
            .catch(() => false);
          if (ok) {
            deps.out(`daemon started (pid ${next.pid}, port ${next.port}).`);
            return;
          }
        }
        throw new CliError(`daemon did not answer within 5s. See ${path.join(dataDir(), 'daemon.log')}.`);
      })
    );

  const stopDaemon = async (opts: { yes?: boolean }): Promise<void> => {
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
    if (opts.yes !== true && !(await confirm('Stopping the daemon ends every spawned session. Continue?'))) {
      deps.out('cancelled.');
      process.exitCode = 1;
      return;
    }
    process.kill(lock.pid, 'SIGTERM');
    // The daemon allows itself 4s to end sessions before it exits regardless.
    for (let i = 0; i < 80 && pidAlive(lock.pid); i++) await deps.sleep(100);
    if (pidAlive(lock.pid)) throw new CliError(`daemon pid ${lock.pid} is still running after 8s`);
    deps.out('daemon stopped.');
  };

  daemon
    .command('stop')
    .description('Stop the daemon (ends spawned sessions)')
    .option('-y, --yes', 'skip the confirmation prompt')
    .action(run(stopDaemon));

  daemon
    .command('logs')
    .description('Print the tail of the daemon log')
    .option('-n, --lines <n>', 'line count', '40')
    .action(
      run((opts: { lines: string }) => {
        const count = Number(opts.lines);
        if (!Number.isInteger(count) || count < 1) throw new CliError('--lines must be a positive integer');
        const lines = daemonLogTail(count);
        if (lines.length === 0) deps.out('daemon log is empty.');
        for (const line of lines) deps.out(line);
      })
    );

  program
    .command('shutdown')
    .description('Stop the daemon (same as `daemon stop`)')
    .option('--confirm', 'skip the confirmation prompt')
    .action(run((opts: { confirm?: boolean }) => stopDaemon({ yes: opts.confirm === true })));

  program
    .command('discover')
    .description('List running agent processes that can be attached')
    .action(
      run(async () => {
        const { candidates } = await deps.client().discover();
        if (candidates.length === 0) {
          deps.out('No agent processes found.');
          return;
        }
        const rows = [['PID', 'AGENT', 'CWD', 'TRACKED', 'COMMAND']];
        for (const entry of candidates) {
          rows.push([
            String(entry.pid),
            entry.provider,
            entry.cwd === null ? '-' : shortPath(entry.cwd),
            entry.sessionId === null ? '-' : entry.sessionId.slice(0, 8),
            truncate(entry.commandLine, 60)
          ]);
        }
        table(rows).forEach((line) => deps.out(line));
      })
    );

  program
    .command('list')
    .alias('ls')
    .description('List sessions, newest first')
    .option('--provider <provider>', 'filter by provider')
    .option('--cwd <cwd>', 'filter by cwd')
    .option('--live', 'only running sessions')
    .action(
      run(async (opts: { provider?: string; cwd?: string; live?: boolean }) => {
        const query: ListSessionsQuery = {};
        if (typeof opts.provider === 'string') {
          const parsed = parseAgentProvider(opts.provider);
          if (!parsed.ok) throw new CliError(parsed.message);
          query.provider = parsed.value;
        }
        if (typeof opts.cwd === 'string') query.cwd = path.resolve(opts.cwd);
        if (opts.live === true) query.lifecycle = 'running';
        const { sessions } = await deps.client().listSessions(query);
        if (sessions.length === 0) {
          deps.out('No sessions. Start one with `agenterm spawn --provider claude`.');
          return;
        }
        const rows = [['ID', 'STATUS', 'AGENT', 'AGE', 'PID', 'CWD', 'TITLE']];
        for (const session of sessions) {
          rows.push([
            session.id.slice(0, 8),
            statusLabel(session),
            session.origin === 'attached' ? `${session.provider}*` : session.provider,
            formatAge(session.startedAtMs),
            String(session.pid),
            truncate(shortPath(session.cwd), 32),
            session.title
          ]);
        }
        table(rows).forEach((line) => deps.out(line));
        if (sessions.some((session) => session.origin === 'attached')) deps.out('* attached (read-only)');
      })
    );

  program
    .command('attach <pid>')
    .description('Adopt a running agent process read-only (names the pid you approve)')
    .option('--title <title>', 'human title')
    .option('--cwd <cwd>', 'cwd override when it cannot be detected')
    .option('-y, --yes', 'skip the confirmation prompt')
    .action(
      run(async (pidText: string, opts: { title?: string; cwd?: string; yes?: boolean }) => {
        const pid = Number(pidText);
        if (!Number.isInteger(pid) || pid <= 0) throw new CliError('pid must be a positive integer');
        if (opts.yes !== true && !(await confirm(`Attach to pid ${pid} read-only?`))) {
          deps.out('cancelled.');
          process.exitCode = 1;
          return;
        }
        const req: AttachSessionRequest = { pid, cwd: typeof opts.cwd === 'string' ? path.resolve(opts.cwd) : null };
        if (typeof opts.title === 'string') req.title = opts.title;
        const out = await deps.client().attach(req);
        deps.out(`attached ${out.session.id.slice(0, 8)} pid=${out.session.pid} ${out.session.title}`);
      })
    );

  program
    .command('spawn')
    .description('Start an agent or command in a daemon-owned terminal')
    .option('--provider <provider>', 'claude, codex, gemini, opencode, or generic', 'generic')
    .option('--command <command>', 'binary override (required for generic)')
    .option('--args <args...>', 'argument list')
    .option('--cwd <cwd>', 'working directory (defaults to the current one)')
    .option('--title <title>', 'human title')
    .option('--cols <cols>', 'terminal width', '120')
    .option('--rows <rows>', 'terminal height', '32')
    .option('--env <entry...>', 'environment override as KEY=VALUE')
    .option('--no-status-hooks', 'do not let Claude Code or Codex push their status to agenterm')
    .action(
      run(
        async (opts: {
          provider?: string;
          command?: string;
          args?: string[];
          cwd?: string;
          title?: string;
          cols?: string;
          rows?: string;
          env?: string[];
          statusHooks: boolean;
        }) => {
          const providerParsed = parseAgentProvider(opts.provider ?? 'generic');
          if (!providerParsed.ok) throw new CliError(providerParsed.message);
          const env: Record<string, string> = {};
          for (const entry of opts.env ?? []) {
            const cut = entry.indexOf('=');
            if (cut <= 0) throw new CliError(`invalid env entry (want KEY=VALUE): ${entry}`);
            env[entry.slice(0, cut)] = entry.slice(cut + 1);
          }
          const req: SpawnSessionRequest = {
            provider: providerParsed.value,
            cwd: path.resolve(opts.cwd ?? process.cwd()),
            args: opts.args ?? [],
            env,
            statusHooks: opts.statusHooks
          };
          if (typeof opts.command === 'string') req.command = opts.command;
          if (typeof opts.title === 'string') req.title = opts.title;
          // Run from inside an agenterm terminal (an agent starting helpers): nest under it.
          const parent = process.env['AGENTERM_SESSION_ID'];
          if (parent !== undefined && UUID.test(parent)) req.parentSessionId = parent;
          req.cols = positiveInt(opts.cols ?? '120', '--cols');
          req.rows = positiveInt(opts.rows ?? '32', '--rows');
          const out = await deps.client().spawn(req);
          deps.out(`spawned ${out.session.id.slice(0, 8)} pid=${out.session.pid} ${out.session.title}`);
        }
      )
    );

  program
    .command('logs <id>')
    .description('Print session scrollback; --follow streams new output')
    .option('--tail <bytes>', 'tail length in bytes', '65536')
    .option('--since <seq>', 'resume cursor: only chunks past this sequence')
    .option('-f, --follow', 'keep printing new output until the session ends')
    .action(
      run(async (idText: string, opts: { tail?: string; since?: string; follow?: boolean }) => {
        const client = deps.client();
        const session = await resolveSessionId(client, idText);
        let cursor: number | undefined;
        if (opts.since !== undefined) {
          const since = Number(opts.since);
          if (!Number.isInteger(since) || since < 0) throw new CliError('--since must be a non-negative integer');
          cursor = since;
        }
        const tail = Number(opts.tail ?? '65536');
        let first = true;
        for (;;) {
          const page = await client.output(session.id, {
            ...(cursor === undefined ? { tailBytes: Number.isInteger(tail) ? tail : 65_536 } : { sinceSeq: cursor }),
            limit: 1000
          });
          if (first && cursor !== undefined && page.firstSeq !== null && page.firstSeq > cursor + 1) {
            deps.err(`[older output before seq ${page.firstSeq} was evicted]`);
          }
          first = false;
          for (const chunk of page.chunks) deps.write(chunk.data);
          if (page.resumeAfterSeq !== null) cursor = page.resumeAfterSeq;
          if (page.hasMore) continue;
          if (opts.follow !== true || !page.live) break;
          cursor ??= 0;
          await deps.sleep(250);
        }
      })
    );

  program
    .command('commands <id>')
    .description('List prompt-anchored command rows, newest first')
    .option('--limit <n>', 'max rows', '100')
    .action(
      run(async (idText: string, opts: { limit?: string }) => {
        const client = deps.client();
        const session = await resolveSessionId(client, idText);
        const limit = positiveInt(opts.limit ?? '100', '--limit');
        const out = await client.commands(session.id, Number.isInteger(limit) ? { limit } : {});
        if (out.commands.length === 0) {
          deps.out('No commands recorded yet.');
          return;
        }
        const rows = [['WHEN', 'TOOK', 'LINES', 'COMMAND']];
        for (const row of out.commands) {
          rows.push([
            formatAge(row.startedAtMs),
            row.durationMs === null ? 'running' : `${(row.durationMs / 1000).toFixed(1)}s`,
            String(row.outputLineCount ?? 0),
            row.text
          ]);
        }
        table(rows).forEach((line) => deps.out(line));
      })
    );

  program
    .command('input <id> [text...]')
    .description('Type text into a session (adds Enter unless --no-enter)')
    .option('--no-enter', 'do not append a carriage return')
    .action(
      run(async (idText: string, text: string[], opts: { enter: boolean }) => {
        const client = deps.client();
        const session = await resolveSessionId(client, idText);
        const data = text.join(' ') + (opts.enter ? '\r' : '');
        if (data.length === 0) throw new CliError('nothing to send');
        const out = await client.sendInput(session.id, { data });
        deps.out(`sent ${out.acceptedBytes} bytes`);
      })
    );

  program
    .command('signal <id> <signal>')
    .description('Send interrupt (Ctrl+C), terminate, or kill to a session')
    .option('--confirm-pid <pid>', 'required for terminate or kill on attached sessions')
    .action(
      run(async (idText: string, signalText: string, opts: { confirmPid?: string }) => {
        if (!['interrupt', 'terminate', 'kill'].includes(signalText)) {
          throw new CliError('signal must be interrupt, terminate, or kill');
        }
        const client = deps.client();
        const session = await resolveSessionId(client, idText);
        const out = await client.signal(session.id, {
          signal: signalText as SessionSignalName,
          ...(opts.confirmPid === undefined ? {} : { confirmPid: Number(opts.confirmPid) })
        });
        deps.out(`${out.signal} ${out.signaled ? 'sent to' : 'could not reach'} pid ${out.pid}`);
        if (!out.signaled) process.exitCode = 1;
      })
    );

  program
    .command('kill <id>')
    .description('End a running session and its whole process tree (keeps it in history)')
    .option('-y, --yes', 'skip the confirmation prompt')
    .option('--confirm-pid <pid>', 'for attached sessions: the pid you approve killing')
    .action(
      run(async (idText: string, opts: { yes?: boolean; confirmPid?: string }) => {
        const client = deps.client();
        const session = await resolveSessionId(client, idText);
        let confirmPid: number | undefined;
        if (session.origin === 'attached') {
          if (opts.confirmPid !== undefined) {
            confirmPid = Number(opts.confirmPid);
          } else {
            const typed = await deps.ask(
              `"${session.title}" is an attached process you did not start. Type its pid (${session.pid}) to kill it: `
            );
            confirmPid = Number(typed);
          }
          if (confirmPid !== session.pid) throw new CliError('pid did not match; nothing was killed');
        } else if (
          opts.yes !== true &&
          !(await confirm(`Kill "${session.title}" (pid ${session.pid}) and its children?`))
        ) {
          deps.out('cancelled.');
          process.exitCode = 1;
          return;
        }
        const out = await client.deleteSession(session.id, {
          killTree: true,
          ...(confirmPid === undefined ? {} : { confirmPid })
        });
        deps.out(out.killed ? `killed pid ${out.pid}` : `session had already ended; closed pid ${out.pid}`);
      })
    );

  program
    .command('close <id>')
    .alias('detach')
    .description('Remove an ended session, or detach an attached one (never kills)')
    .action(
      run(async (idText: string) => {
        const client = deps.client();
        const session = await resolveSessionId(client, idText);
        const out = await client.deleteSession(session.id, { killTree: false });
        deps.out(session.origin === 'attached' ? `detached pid ${out.pid}` : `closed ${session.id.slice(0, 8)}`);
      })
    );

  program
    .command('rename <id> <title...>')
    .description('Rename a session')
    .action(
      run(async (idText: string, title: string[]) => {
        const client = deps.client();
        const session = await resolveSessionId(client, idText);
        const out = await client.updateSession(session.id, { title: title.join(' ') });
        deps.out(`renamed to "${out.session.title}"`);
      })
    );

  program
    .command('restart <id>')
    .description('Start an ended session again with the same command and cwd')
    .action(
      run(async (idText: string) => {
        const client = deps.client();
        const session = await resolveSessionId(client, idText);
        const out = await client.restart(session.id);
        deps.out(`restarted as ${out.session.id.slice(0, 8)} pid=${out.session.pid}`);
      })
    );

  program
    .command('git <id>')
    .description('Show branch and changed files in a session workspace')
    .action(
      run(async (idText: string) => {
        const client = deps.client();
        const session = await resolveSessionId(client, idText);
        const status = await client.git(session.id);
        if (status.worktreeRoot === null) {
          deps.out('Not a git repository.');
          return;
        }
        deps.out(
          `${status.branch ?? '(detached)'} · ${status.stagedCount} staged · ${status.unstagedCount} unstaged · +${status.insertions} -${status.deletions}`
        );
        for (const file of status.files) {
          const index = file.staged === null ? ' ' : (file.staged[0] ?? ' ').toUpperCase();
          const work =
            file.unstaged === null
              ? ' '
              : file.unstaged === 'untracked'
                ? '?'
                : (file.unstaged[0] ?? ' ').toUpperCase();
          deps.out(`${index}${work} ${file.path}`);
        }
      })
    );

  program
    .command('diff <id> <file>')
    .description('Print the diff of one file versus HEAD')
    .action(
      run(async (idText: string, file: string) => {
        const client = deps.client();
        const session = await resolveSessionId(client, idText);
        const out = await client.gitDiff(session.id, file);
        deps.write(out.diff.length > 0 ? out.diff : 'No changes.\n');
        if (out.truncated) deps.err('[diff truncated]');
      })
    );

  program
    .command('files <id>')
    .description('Files recently changed in a session workspace')
    .action(
      run(async (idText: string) => {
        const client = deps.client();
        const session = await resolveSessionId(client, idText);
        const out = await client.files(session.id);
        if (!out.watching && out.changes.length === 0) {
          deps.out('This workspace is not watched (not a git repository, or the home or root folder).');
          return;
        }
        if (out.changes.length === 0) {
          deps.out('No file changes yet.');
          return;
        }
        table([['WHEN', 'CHANGE', 'PATH'], ...out.changes.map((c) => [formatAge(c.atMs), c.change, c.path])]).forEach(
          (line) => deps.out(line)
        );
      })
    );

  program
    .command('grep <text>')
    .description('Search the output of every session (or one) for text')
    .option('--session <id>', 'only one session')
    .option('--limit <n>', 'max matches', '100')
    .action(
      run(async (text: string, opts: { session?: string; limit?: string }) => {
        const client = deps.client();
        const sessionId = opts.session === undefined ? undefined : (await resolveSessionId(client, opts.session)).id;
        const [result, { sessions }] = await Promise.all([
          client.search(text, {
            ...(sessionId === undefined ? {} : { sessionId }),
            limit: positiveInt(opts.limit ?? '100', '--limit')
          }),
          client.listSessions()
        ]);
        if (result.matches.length === 0) {
          deps.out(`No output matches "${text}".`);
          return;
        }
        const titles = new Map(sessions.map((session) => [session.id, session.title]));
        for (const match of result.matches) {
          deps.out(`${match.sessionId.slice(0, 8)}  ${titles.get(match.sessionId) ?? ''}:${match.line}  ${match.text}`);
        }
        if (result.truncated) deps.err('[more matches; raise --limit]');
      })
    );

  program
    .command('usage')
    .description('Model spend per session, from agent telemetry (Claude Code)')
    .action(
      run(async () => {
        const client = deps.client();
        const [{ sessions: totals }, { sessions }] = await Promise.all([client.usage(), client.listSessions()]);
        const rows = sessions.filter((session) => totals[session.id] !== undefined);
        if (rows.length === 0) {
          deps.out('No usage reported yet. Claude Code sessions started by agenterm report spend automatically.');
          return;
        }
        let total = 0;
        const lines = [['ID', 'COST', 'INPUT', 'OUTPUT', 'REQUESTS', 'MODEL', 'TITLE']];
        for (const session of rows) {
          const usage = totals[session.id];
          if (usage === undefined) continue;
          total += usage.costUsd;
          lines.push([
            session.id.slice(0, 8),
            `$${usage.costUsd.toFixed(2)}`,
            String(usage.inputTokens),
            String(usage.outputTokens),
            String(usage.requests),
            usage.model ?? '-',
            session.title
          ]);
        }
        table(lines).forEach((line) => deps.out(line));
        deps.out(`total $${total.toFixed(2)}`);
      })
    );

  program
    .command('events')
    .description('Recent activity across sessions, newest first')
    .option('--session <id>', 'only one session')
    .option('--limit <n>', 'max rows', '50')
    .action(
      run(async (opts: { session?: string; limit?: string }) => {
        const client = deps.client();
        const sessionId = opts.session === undefined ? undefined : (await resolveSessionId(client, opts.session)).id;
        const limit = positiveInt(opts.limit ?? '50', '--limit');
        const { events } = await client.events({
          ...(sessionId === undefined ? {} : { sessionId }),
          limit: Number.isInteger(limit) ? limit : 50
        });
        if (events.length === 0) {
          deps.out('No activity yet.');
          return;
        }
        table([
          ['WHEN', 'SESSION', 'EVENT'],
          ...events.map((event) => [formatAge(event.createdAtMs), event.sessionId.slice(0, 8), describeEvent(event)])
        ]).forEach((line) => deps.out(line));
      })
    );

  program
    .command('mcp')
    .description('Serve the Model Context Protocol on stdio so agents can see and steer sessions')
    .addHelpText(
      'after',
      '\nAdd to Claude Code:  claude mcp add agenterm -- agenterm mcp\nAdd to Codex:        codex mcp add agenterm -- agenterm mcp'
    )
    .action(async () => {
      await runMcpStdio(deps.client, program.version() ?? '0.1.0');
    });

  addHarnessCommands(program, deps);
  return program;
}

function describeEvent(event: import('@agenterm/core').AgentermEvent): string {
  switch (event.kind) {
    case 'session.created':
      return `started ${event.commandLine.join(' ')}`;
    case 'session.exited':
      return event.exitSignal !== null
        ? `ended by ${event.exitSignal}`
        : `exited${event.exitCode === null ? '' : ` with ${event.exitCode}`}`;
    case 'session.attached':
      return `attached pid ${event.pid}`;
    case 'session.detached':
      return 'closed';
    case 'session.updated':
      return `renamed to "${event.title}"`;
    case 'session.usage':
      return `spend now $${event.costUsd.toFixed(2)}`;
    case 'agent.status':
      return `status ${event.overlay.replace('_', ' ')}${event.summary === null ? '' : `: ${event.summary}`}`;
    case 'port.opened':
      return `opened port ${event.port}`;
    case 'port.closed':
      return `closed port ${event.port}`;
    case 'workspace.conflict':
      return `shares ${event.cwd} with ${event.involvedSessionIds.length - 1} other session(s)`;
    case 'file.changed':
      return `${event.change} ${event.path}`;
    default:
      return event.kind;
  }
}

const HARNESS_PROVIDERS = ['claude', 'codex', 'opencode', 'gemini'] as const;

function grantsPath(): string {
  return path.join(dataDir(), 'harness-grants.json');
}

function readGrants(): Array<{ provider: string; path: string; grantedAtMs: number }> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(grantsPath(), 'utf8'));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is { provider: string; path: string; grantedAtMs: number } =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as Record<string, unknown>)['provider'] === 'string' &&
        typeof (entry as Record<string, unknown>)['path'] === 'string'
    );
  } catch {
    return [];
  }
}

function writeGrants(grants: Array<{ provider: string; path: string; grantedAtMs: number }>): void {
  fs.mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(grantsPath(), JSON.stringify(grants, null, 2), { encoding: 'utf8', mode: 0o600 });
}

function addHarnessCommands(program: Command, deps: CliDeps): void {
  const harness = program.command('harness').description('Approve and inspect harness overlay access');

  harness
    .command('grant')
    .description('Approve read-only harness log access for one provider root')
    .requiredOption('--provider <provider>', 'one of claude, codex, opencode, gemini')
    .requiredOption('--path <dir>', 'absolute root the daemon may list and tail')
    .action((opts: { provider: string; path: string }) => {
      if (!(HARNESS_PROVIDERS as readonly string[]).includes(opts.provider)) {
        deps.err(`error: invalid provider ${opts.provider}`);
        process.exitCode = 1;
        return;
      }
      if (!path.isAbsolute(opts.path)) {
        deps.err('error: grant path must be absolute');
        process.exitCode = 1;
        return;
      }
      const grants = readGrants();
      if (!grants.some((entry) => entry.provider === opts.provider && entry.path === opts.path)) {
        grants.push({ provider: opts.provider, path: opts.path, grantedAtMs: Date.now() });
        writeGrants(grants);
      }
      deps.out(`granted ${opts.provider} ${opts.path}`);
      deps.out('Reads start when the daemon runs with AGENTERM_HARNESS_WATCH=1.');
    });

  harness
    .command('list')
    .description('List harness overlay approvals')
    .action(() => {
      const grants = readGrants();
      if (grants.length === 0) {
        deps.out('No harness approvals.');
        return;
      }
      for (const entry of grants) deps.out(`${entry.provider} ${entry.path}`);
    });

  harness
    .command('revoke')
    .description('Remove one harness overlay approval')
    .requiredOption('--provider <provider>', 'provider of the approval')
    .requiredOption('--path <dir>', 'absolute root of the approval')
    .action((opts: { provider: string; path: string }) => {
      const grants = readGrants();
      const kept = grants.filter((entry) => !(entry.provider === opts.provider && entry.path === opts.path));
      if (kept.length === grants.length) {
        deps.err('error: no matching approval');
        process.exitCode = 1;
        return;
      }
      writeGrants(kept);
      deps.out(`revoked ${opts.provider} ${opts.path}`);
    });
}
