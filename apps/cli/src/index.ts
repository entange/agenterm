#!/usr/bin/env node
import { AgentermClient, daemonBaseUrl } from '@agenterm/core';
import { detectCaller, type Caller } from './caller.js';
import { readPort, readToken } from './local.js';
import { buildProgram } from './program.js';

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
