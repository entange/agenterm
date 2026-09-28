import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentermClient, daemonBaseUrl, parseAgentProvider, type AttachSessionRequest, type ListSessionsQuery } from '@agenterm/core';
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
  .command('daemon')
  .description('Daemon helpers')
  .option('--start', 'note that the desktop shell starts the daemon on demand')
  .action((opts: { start?: boolean }) => {
    if (opts.start === true) {
      console.log('Start the daemon via the desktop shell or run the runtime entry directly.');
      return;
    }
    console.log('Use status, list, discover, attach. Shutdown arrives with the spawn change.');
  });

program
  .command('spawn')
  .description('Spawn is wired in the following change; this entry reserves the name')
  .action(() => {
    console.error('Spawn arrives with the PTY change. Use attach for existing PIDs for now.');
    process.exit(1);
  });

for (const name of ['detach', 'kill', 'logs', 'input', 'shutdown'] as const) {
  program
    .command(name)
    .description(`Reserved for the spawn and terminal change: ${name}`)
    .action(() => {
      console.error(`${name} arrives with the spawn and terminal change.`);
      process.exit(1);
    });
}

await program.parseAsync(process.argv);
