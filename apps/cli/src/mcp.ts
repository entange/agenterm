import readline from 'node:readline';
import path from 'node:path';
import { AgentermApiError, isRunning, statusText, type AgentermClient } from '@agenterm/core';
import type { Caller } from './caller.js';
import {
  cleanEnv,
  processTable,
  resolveTask,
  runSummary,
  settle,
  settledReport,
  startTask,
  tailLines,
  taskTable
} from './ops.js';

/**
 * MCP stdio server with the same abilities as the CLI: run, list, logs,
 * input, stop, remove, processes, kill. Results are the same text the CLI prints, with
 * escape codes stripped and secrets redacted. Speaks newline-delimited
 * JSON-RPC 2.0 as the MCP stdio transport defines.
 */

const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

/** What the tools need. The CLI passes its own; tests pass stubs. */
export interface McpContext {
  client: () => AgentermClient;
  version: string;
  /** The agent that launched this server. */
  caller: () => Caller | null;
  /** Default folder for run: where the agent started this server. */
  cwd: () => string;
  env: () => NodeJS.ProcessEnv;
  sleep: (ms: number) => Promise<void>;
  ensureDaemon: () => Promise<void>;
}

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (context: McpContext, args: Record<string, unknown>) => Promise<string>;
}

class ToolInputError extends Error {}

function text(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.trim().length === 0)
    throw new ToolInputError(`${key} must be a non-empty string`);
  return value;
}

function optionalText(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new ToolInputError(`${key} must be a string`);
  return value.trim().length === 0 ? undefined : value;
}

function flag(args: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = args[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') throw new ToolInputError(`${key} must be true or false`);
  return value;
}

function count(args: Record<string, unknown>, key: string, fallback: number, max: number): number {
  const value = args[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max) {
    throw new ToolInputError(`${key} must be a number from 0 to ${max}`);
  }
  return value;
}

const ID_ARG = { type: 'string', description: 'Task id from run or list. A title or unique id prefix also works.' };

export const TOOLS: Tool[] = [
  {
    name: 'run',
    description:
      'Start a long-running command (dev server, watcher, build, test loop) in a real terminal the user can watch and type into in the agenterm app. ' +
      'Returns the task id and its first output. Use it instead of running servers in your own shell. ' +
      'Only for commands that keep running or take minutes: run quick ones (ls, pwd, git status, npm install, a single test run) in your own shell. ' +
      'Calling again with the same id, or the same command in the same folder, returns the running task instead of starting a duplicate; set restart to replace it.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command line, e.g. "npm run dev".' },
        id: {
          type: 'string',
          description:
            'Id to use for the task, e.g. "web". Letters, digits, ".", "_", "-". Generated from the command when omitted.'
        },
        cwd: { type: 'string', description: 'Absolute folder to run in. Defaults to the folder you were started in.' },
        title: { type: 'string', description: 'Human title. Defaults to the command.' },
        restart: { type: 'boolean', description: 'Replace the task if it is already running.' },
        wait_seconds: { type: 'number', description: 'Seconds to wait for first output, 0-30. Default 2.' }
      },
      required: ['command'],
      additionalProperties: false
    },
    run: async (context, args) => {
      const command = text(args, 'command');
      const cwd = optionalText(args, 'cwd');
      if (cwd !== undefined && !path.isAbsolute(cwd)) throw new ToolInputError('cwd must be an absolute path');
      const waitSeconds = count(args, 'wait_seconds', 2, 30);
      await context.ensureDaemon();
      const client = context.client();
      const env = context.env();
      const result = await startTask(
        client,
        {
          command,
          cwd: cwd ?? context.cwd(),
          id: optionalText(args, 'id'),
          title: optionalText(args, 'title'),
          agent: env['AGENTERM_AGENT'],
          restart: flag(args, 'restart', false),
          env: cleanEnv(env)
        },
        context.caller()
      );
      if (result.alreadyRunning || waitSeconds === 0) return runSummary(result).join('\n');
      const task = await settle(client, result.task, waitSeconds * 1000, context.sleep);
      return [...runSummary({ ...result, task }), ...settledReport(task, await tailLines(client, task.id, 30))].join(
        '\n'
      );
    }
  },
  {
    name: 'list',
    description: 'List tasks on this machine, running first: id, status, age, who started it, ports, folder, command.',
    inputSchema: {
      type: 'object',
      properties: { running_only: { type: 'boolean', description: 'Only running tasks.' } },
      additionalProperties: false
    },
    run: async (context, args) => {
      const { tasks } = await context.client().listTasks();
      return taskTable(flag(args, 'running_only', false) ? tasks.filter(isRunning) : tasks).join('\n');
    }
  },
  {
    name: 'logs',
    description: 'Recent output of a task as plain text.',
    inputSchema: {
      type: 'object',
      properties: { id: ID_ARG, lines: { type: 'number', description: 'How many lines, 1-2000. Default 100.' } },
      required: ['id'],
      additionalProperties: false
    },
    run: async (context, args) => {
      const client = context.client();
      const task = await resolveTask(client, text(args, 'id'));
      const lines = await tailLines(client, task.id, Math.max(1, Math.floor(count(args, 'lines', 100, 2000))));
      return [`${task.id}: ${statusText(task)}`, ...(lines.length > 0 ? lines : ['(no output)'])].join('\n');
    }
  },
  {
    name: 'input',
    description:
      'Type text into a running task, then press Enter unless enter is false. For prompts like "Continue? (y/n)".',
    inputSchema: {
      type: 'object',
      properties: {
        id: ID_ARG,
        text: { type: 'string', description: 'Text to type.' },
        enter: { type: 'boolean', description: 'Press Enter after the text. Default true.' }
      },
      required: ['id', 'text'],
      additionalProperties: false
    },
    run: async (context, args) => {
      const client = context.client();
      const task = await resolveTask(client, text(args, 'id'));
      const value = args['text'];
      if (typeof value !== 'string') throw new ToolInputError('text must be a string');
      const data = `${value}${flag(args, 'enter', true) ? '\r' : ''}`;
      if (data.length === 0) throw new ToolInputError('text is empty and enter is false: nothing to send');
      await client.sendInput(task.id, { data });
      return `sent ${Buffer.byteLength(data, 'utf8')} bytes to ${task.id}`;
    }
  },
  {
    name: 'stop',
    description:
      'Stop a running task: Ctrl+C, then end its whole process tree if it does not exit. force kills it right away. The task stays listed with its output until removed.',
    inputSchema: {
      type: 'object',
      properties: { id: ID_ARG, force: { type: 'boolean', description: 'Kill immediately.' } },
      required: ['id'],
      additionalProperties: false
    },
    run: async (context, args) => {
      const client = context.client();
      const task = await resolveTask(client, text(args, 'id'));
      if (!isRunning(task)) return `${task.id} is not running (${statusText(task)})`;
      const stopped = (await client.stop(task.id, { force: flag(args, 'force', false) })).task;
      return `${task.id}: ${statusText(stopped)}`;
    }
  },
  {
    name: 'remove',
    description: 'Remove a task and its output, stopping it first if it is running.',
    inputSchema: {
      type: 'object',
      properties: { id: ID_ARG },
      required: ['id'],
      additionalProperties: false
    },
    run: async (context, args) => {
      const client = context.client();
      const task = await resolveTask(client, text(args, 'id'));
      const result = await client.remove(task.id);
      return `removed ${task.id}${result.stopped ? ' (stopped it first)' : ''}`;
    }
  },
  {
    name: 'processes',
    description:
      'List commands running outside agenterm: typed in terminals, run by agents (you included), or orphaned because what started them has exited. ' +
      'Shows pid, who started it, ports, CPU, memory, folder, and command. Use it to find what holds a port or what was left behind.',
    inputSchema: {
      type: 'object',
      properties: { orphaned: { type: 'boolean', description: 'Only orphaned commands.' } },
      additionalProperties: false
    },
    run: async (context, args) => {
      await context.ensureDaemon();
      const { processes } = await context.client().listProcesses();
      const shown = flag(args, 'orphaned', false) ? processes.filter((entry) => entry.orphaned) : processes;
      if (shown.length === 0) return 'nothing is running outside agenterm';
      return processTable(shown).join('\n');
    }
  },
  {
    name: 'kill',
    description:
      'End a command listed by processes, with everything under it: SIGTERM, then SIGKILL; force kills right away. ' +
      'Only kill orphaned commands, ones you started yourself, or ones the user asked you to: the rest belong to the user or other agents. ' +
      'Tasks agenterm started are ended with stop.',
    inputSchema: {
      type: 'object',
      properties: {
        pid: { type: 'number', description: 'Pid from processes.' },
        force: { type: 'boolean', description: 'SIGKILL immediately.' }
      },
      required: ['pid'],
      additionalProperties: false
    },
    run: async (context, args) => {
      const pid = args['pid'];
      if (typeof pid !== 'number' || !Number.isInteger(pid) || pid < 2) {
        throw new ToolInputError('pid must be a process id from processes');
      }
      const { process: ended, exited } = await context.client().stopProcess(pid, { force: flag(args, 'force', false) });
      const count = ended.pids.length;
      const what = `${pid} (${ended.command.slice(0, 60)}${count > 1 ? `, ${count} processes` : ''})`;
      return exited ? `ended ${what}` : `signaled ${what}, but some of it is still running`;
    }
  }
];

interface Request {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

function reply(id: string | number | null, result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

function failure(id: string | number | null, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
}

/** Handle one JSON-RPC line. Returns the response line, or null for notifications. */
export async function handleMcpMessage(context: McpContext, line: string): Promise<string | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return failure(null, -32700, 'parse error');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return failure(null, -32600, 'invalid request: expected one JSON-RPC request object');
  }
  const message = parsed as Partial<Request> & { result?: unknown; error?: unknown };
  // Responses from the client (to requests this server never sends) are ignored.
  if (message.method === undefined && ('result' in message || 'error' in message)) return null;
  const rawId: unknown = message.id;
  if (rawId !== undefined && rawId !== null && typeof rawId !== 'string' && typeof rawId !== 'number') {
    return failure(null, -32600, 'invalid request: id must be a string or number');
  }
  if (typeof message.method !== 'string') {
    return rawId === undefined ? null : failure(rawId, -32600, 'invalid request: method must be a string');
  }
  // Notifications never get a reply, and never run tools.
  if (rawId === undefined) return null;
  const request = message as Request;
  const id = rawId;
  switch (request.method) {
    case 'initialize': {
      const asked = request.params?.['protocolVersion'];
      const protocolVersion =
        typeof asked === 'string' && SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[0];
      return reply(id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'agenterm', version: context.version },
        instructions:
          'agenterm runs long-lived commands (dev servers, watchers, builds) in terminals the user can watch in the agenterm app. ' +
          'Use run to start one and keep its id; run with the same id never starts a duplicate. Use logs to check on it and stop when done. processes lists what runs outside agenterm, including orphans left behind.'
      });
    }
    case 'ping':
      return reply(id, {});
    case 'tools/list':
      return reply(id, {
        tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))
      });
    case 'tools/call': {
      const name = request.params?.['name'];
      const tool = TOOLS.find((entry) => entry.name === name);
      if (tool === undefined) return failure(id, -32602, `unknown tool ${String(name)}`);
      const args = (request.params?.['arguments'] ?? {}) as Record<string, unknown>;
      try {
        const output = await tool.run(context, args);
        return reply(id, { content: [{ type: 'text', text: output }] });
      } catch (error) {
        const message =
          error instanceof AgentermApiError
            ? `${error.message}${error.hint === undefined ? '' : ` (${error.hint})`}`
            : /ECONNREFUSED|fetch failed/.test(String(error))
              ? 'The agenterm daemon is not running, so no tasks are. The run tool starts it.'
              : error instanceof Error
                ? error.message
                : String(error);
        return reply(id, { content: [{ type: 'text', text: message }], isError: true });
      }
    }
    default:
      return failure(id, -32601, `method not found: ${request.method}`);
  }
}

/** Serve MCP over stdin and stdout until stdin closes. Logs go to stderr only. */
export async function runMcpStdio(context: McpContext): Promise<void> {
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
  for await (const line of lines) {
    if (line.trim().length === 0) continue;
    const response = await handleMcpMessage(context, line);
    if (response !== null) process.stdout.write(`${response}\n`);
  }
}
