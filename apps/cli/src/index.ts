#!/usr/bin/env node
import { AgentermClient, daemonBaseUrl, VERSION } from '@agenterm/core';
import { detectCaller, type Caller } from './caller.js';
import { dataDir, readPort, readToken } from './local.js';
import { buildProgram } from './program.js';
import { updateNotice, wantsUpdateCheck } from './updateNotice.js';

// The desktop app's copy runs on Electron as Node. That switch is for this
// process only: tasks would inherit it and break any Electron app they run.
if (process.versions.electron !== undefined) delete process.env['ELECTRON_RUN_AS_NODE'];

function makeClient(): AgentermClient {
  // An empty token still reaches the daemon and earns a clear 401 or a connection error.
  return new AgentermClient({ baseUrl: daemonBaseUrl(readPort()), token: readToken() });
}

// Our parent never changes, so one walk up the process tree is enough.
let caller: Caller | null | undefined;

const program = buildProgram({
  client: makeClient,
  out: (line) => console.log(line),
  err: (line) => console.error(line),
  write: (data) => process.stdout.write(data),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  caller: () => (caller ??= detectCaller()),
  cwd: () => process.cwd(),
  env: () => process.env,
  isTTY: () => process.stdout.isTTY === true
});

await program.parseAsync(process.argv);

if (wantsUpdateCheck(process.argv.slice(2), process.env, process.stderr.isTTY === true)) {
  const notice = await updateNotice(VERSION, dataDir());
  if (notice !== null) console.error(`\n${notice}`);
}
