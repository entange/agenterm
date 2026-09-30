import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AgentermClient,
  daemonBaseUrl,
  parseAgentProvider,
  type AttachSessionRequest,
  type ListSessionsQuery,
  type SpawnSessionRequest
} from '@agenterm/core';
import { Command } from 'commander';

function dataDir(): string {
  const override = process.env['AGENTERM_DATA_DIR'];
  if (typeof override === 'string' && override.length > 0) return override;
  return path.join(os.homedir(), '.agenterm');
}

function readToken(): string {
  const file = path.join(dataDir(), 'token');
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
}

function readPort(): number {
  const fallback = Number(process.env['AGENTERM_PORT'] ?? '37241');
  try {
    const raw = fs.readFileSync(path.join(dataDir(), 'agentermd.lock'), 'utf8');
    const parsed = JSON.parse(raw) as { port?: number };
    if (typeof parsed.port === 'number') return parsed.port;
  } catch {
    // Fall through to env fallback.
  }
  return Number.isInteger(fallback) ? fallback : 37241;
}

function makeClient(): AgentermClient {
  const token = readToken();
  if (token.length === 0) {
    console.error('Missing token. Start the daemon first so ~/.agenterm/token exists.');
    process.exit(1);
  }
  return new AgentermClient({ baseUrl: daemonBaseUrl(readPort()), token });
}

const program = new Command();
program.name('agenterm').description('Local control center for agents and terminals').version('0.1.0');

program
  .command('status')
  .description('Show daemon liveness plus version and uptime')
  .action(async () => {
    const client = makeClient();
    const health = await client.health();
    console.log(`ok ${health.version} up ${health.uptimeSeconds}s port ${health.port}`);
  });

program
  .command('discover')
  .description('List running agent PIDs that can be attached with approval')
  .action(async () => {
    const client = makeClient();
    const out = await client.discover();
    if (out.candidates.length === 0) {
      console.log('No agent processes found.');
      return;
    }
    for (const entry of out.candidates) {
      console.log(`${entry.pid} ${entry.binaryName} ${entry.commandLine} cwd=${entry.cwd ?? '-'}`);
    }
  });

program
  .command('list')
  .description('List sessions')
  .option('--provider <provider>', 'filter by provider')
  .option('--cwd <cwd>', 'filter by cwd')
  .action(async (opts: { provider?: string; cwd?: string }) => {
    const client = makeClient();
    const query: ListSessionsQuery = {};
    if (typeof opts.provider === 'string') {
      const parsedProvider = parseAgentProvider(opts.provider);
      if (!parsedProvider.ok) {
        console.error(`Invalid provider: ${parsedProvider.message}`);
        process.exit(1);
      }
      query.provider = parsedProvider.value;
    }
    if (typeof opts.cwd === 'string') {
      query.cwd = opts.cwd;
    }
    const out = await client.listSessions(query);
    if (out.sessions.length === 0) {
      console.log('No sessions.');
      return;
    }
    for (const session of out.sessions) {
      console.log(`${session.id} ${session.origin} ${session.lifecycle} pid=${session.pid} ${session.title}`);
    }
  });

program
  .command('attach <pid>')
  .description('Adopt an existing OS pid by number with approval in this call')
  .option('--title <title>', 'human title')
  .option('--cwd <cwd>', 'cwd hint')
  .action(async (pidText: string, opts: { title?: string; cwd?: string }) => {
    const pid = Number(pidText);
    const client = makeClient();
    const req: AttachSessionRequest = { pid };
    if (typeof opts.title === 'string') {
      req.title = opts.title;
    }
    if (typeof opts.cwd === 'string') {
      req.cwd = opts.cwd;
    } else {
      req.cwd = null;
    }
    const out = await client.attach(req);
    console.log(`attached ${out.session.id} pid=${out.session.pid}`);
  });

program
  .command('spawn')
  .description('Spawn a new owned session in a PTY')
  .option('--provider <provider>', 'agent provider', 'generic')
  .option('--command <command>', 'binary override')
  .option('--args <args...>', 'argument list')
  .option('--cwd <cwd>', 'working directory')
  .option('--title <title>', 'human title')
  .option('--cols <cols>', 'terminal width', '80')
  .option('--rows <rows>', 'terminal height', '24')
  .option('--env <entry...>', 'environment override as KEY=VALUE')
  .action(
    async (opts: {
      provider?: string;
      command?: string;
      args?: string[];
      cwd?: string;
      title?: string;
      cols?: string;
      rows?: string;
      env?: string[];
    }) => {
      const providerParsed = parseAgentProvider(opts.provider ?? 'generic');
      if (!providerParsed.ok) {
        console.error(`Invalid provider: ${providerParsed.message}`);
        process.exit(1);
      }
      const env: Record<string, string> = {};
      for (const entry of opts.env ?? []) {
        const cut = entry.indexOf('=');
        if (cut <= 0) {
          console.error(`Invalid env entry (want KEY=VALUE): ${entry}`);
          process.exit(1);
        }
        env[entry.slice(0, cut)] = entry.slice(cut + 1);
      }
      const req: SpawnSessionRequest = {
        provider: providerParsed.value,
        cwd: opts.cwd ?? process.cwd(),
        args: opts.args ?? [],
        env
      };
      if (typeof opts.command === 'string') req.command = opts.command;
      if (typeof opts.title === 'string') req.title = opts.title;
      const cols = Number(opts.cols ?? '80');
      const rows = Number(opts.rows ?? '24');
      if (Number.isInteger(cols)) req.cols = cols;
      if (Number.isInteger(rows)) req.rows = rows;
      const client = makeClient();
      const out = await client.spawn(req);
      console.log(`spawned ${out.session.id} pid=${out.session.pid} ${out.session.title}`);
    }
  );

program
  .command('logs <id>')
  .description('Print session scrollback with an optional resume cursor')
  .option('--tail <bytes>', 'tail length in bytes', '65536')
  .option('--since <seq>', 'resume cursor: only chunks past this sequence')
  .action(async (id: string, opts: { tail?: string; since?: string }) => {
    const client = makeClient();
    const query: { tailBytes?: number; sinceSeq?: number } = {};
    const tail = Number(opts.tail ?? '65536');
    if (Number.isInteger(tail)) query.tailBytes = tail;
    if (opts.since !== undefined) {
      const since = Number(opts.since);
      if (Number.isInteger(since)) query.sinceSeq = since;
    }
    const out = await client.output(id, query);
    for (const chunk of out.chunks) {
      process.stdout.write(chunk.data);
    }
    if (out.resumeAfterSeq !== null) {
      console.error(`resumeAfterSeq=${out.resumeAfterSeq} hasMore=${out.hasMore}`);
    }
  });

program
  .command('input <id> [text...]')
  .description('Write bytes to owned PTY stdin')
  .action(async (id: string, text: string[]) => {
    const client = makeClient();
    const data = text.join(' ') + '\n';
    const out = await client.sendInput(id, { data });
    console.log(`accepted ${out.acceptedBytes} bytes`);
  });

program
  .command('kill <id>')
  .description('End a session with kill-tree and remove its row')
  .action(async (id: string) => {
    const client = makeClient();
    const out = await client.deleteSession(id, { killTree: true });
    console.log(`ended pid=${out.pid} killed=${out.killed}`);
  });

program
  .command('detach <id>')
  .description('Detach a session without killing its tree')
  .action(async (id: string) => {
    const client = makeClient();
    const out = await client.deleteSession(id, { killTree: false });
    console.log(`detached pid=${out.pid}`);
  });

program
  .command('shutdown')
  .description('Stop the daemon process')
  .option('--confirm', 'required explicit approval naming this action')
  .action((opts: { confirm?: boolean }) => {
    if (opts.confirm !== true) {
      console.error('Refusing: pass --confirm to stop the daemon.');
      process.exit(1);
    }
    let lock: { pid?: number };
    try {
      lock = JSON.parse(fs.readFileSync(path.join(dataDir(), 'agentermd.lock'), 'utf8')) as { pid?: number };
    } catch {
      console.error('No daemon lock file found.');
      process.exit(1);
    }
    if (typeof lock.pid !== 'number') {
      console.error('Daemon lock has no pid.');
      process.exit(1);
    }
    try {
      process.kill(lock.pid, 'SIGTERM');
      console.log(`signaled daemon pid=${lock.pid}`);
    } catch {
      console.error(`Daemon pid=${lock.pid} is not running.`);
      process.exit(1);
    }
  });

program
  .command('daemon')
  .description('Show daemon lock status')
  .action(() => {
    try {
      const lock = JSON.parse(fs.readFileSync(path.join(dataDir(), 'agentermd.lock'), 'utf8')) as {
        pid?: number;
        port?: number;
      };
      console.log(`daemon pid=${lock.pid ?? '?'} port=${lock.port ?? '?'}`);
    } catch {
      console.log('daemon not running (no lock file).');
    }
  });

await program.parseAsync(process.argv);
