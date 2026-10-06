#!/usr/bin/env node
import readline from 'node:readline/promises';
import { AgentermClient, daemonBaseUrl } from '@agenterm/core';
import { readPort, readToken } from './local.js';
import { buildProgram } from './program.js';

function makeClient(): AgentermClient {
  // An empty token still reaches the daemon and earns a clear 401 or a connection error.
  return new AgentermClient({ baseUrl: daemonBaseUrl(readPort()), token: readToken() });
}

async function ask(question: string): Promise<string> {
  if (!process.stdin.isTTY) return '';
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

const program = buildProgram({
  client: makeClient,
  out: (line) => console.log(line),
  err: (line) => console.error(line),
  write: (data) => process.stdout.write(data),
  ask,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
});

await program.parseAsync(process.argv);
