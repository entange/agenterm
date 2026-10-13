import readline from 'node:readline';
import { AgentermApiError, type AgentermClient, redactText, type SessionRecord } from '@agenterm/core';

/**
 * MCP stdio bridge over the daemon HTTP API.
 *
 * Lets an agent (Claude Code, Codex, any MCP client) see the other
 * sessions on this machine: list them, read their output, type into them,
 * interrupt them, and kill one only when it names the exact pid. Every
 * text result is stripped of escape codes and redacted. Speaks
 * newline-delimited JSON-RPC 2.0 as the MCP stdio transport defines.
 */

const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (client: AgentermClient, args: Record<string, unknown>) => Promise<string>;
}

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

/** Terminal bytes as readable text: no escapes, carriage-return redraws collapsed, redacted. */
export function plainText(data: string): string {
  const lines = data.replace(ANSI, '').split('\n');
  return redactText(
    lines
      .map((line) => {
        const segments = line.split('\r').filter((segment) => segment.length > 0);
        return segments[segments.length - 1] ?? '';
      })
      .join('\n')
      .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
  );
}

function summary(session: SessionRecord): Record<string, Json> {
  return {
    id: session.id,
    title: session.title,
    provider: session.provider,
    origin: session.origin,
    lifecycle: session.lifecycle,
    status: session.overlay,
    cwd: session.cwd,
    branch: session.branch,
    pid: session.pid,
    command: redactText(session.commandLine.join(' ')),
    startedAt: new Date(session.startedAtMs).toISOString(),
    endedAt: session.endedAtMs === null ? null : new Date(session.endedAtMs).toISOString(),
    exitCode: session.exitCode
  };
}

function text(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.length === 0) throw new ToolInputError(`${key} must be a non-empty string`);
  return value;
}

/** The resolved session when session_id was given, otherwise undefined. */
async function optionalSession(client: AgentermClient, args: Record<string, unknown>): Promise<string | undefined> {
  return args['session_id'] === undefined ? undefined : (await resolve(client, text(args, 'session_id'))).id;
}

/** Bad tool arguments; reported to the model as a tool error. */
class ToolInputError extends Error {}

async function resolve(client: AgentermClient, raw: string): Promise<SessionRecord> {
  const idOrPrefix = raw.trim();
  if (idOrPrefix.length === 0) throw new ToolInputError('session_id must be a non-empty string');
  const { sessions } = await client.listSessions();
  const matches = sessions.filter(
    (session) => session.id === idOrPrefix || session.id.startsWith(idOrPrefix.toLowerCase())
  );
  if (matches.length === 1 && matches[0] !== undefined) return matches[0];
  if (matches.length === 0) throw new ToolInputError(`no session matches "${idOrPrefix}"; call list_sessions first`);
  throw new ToolInputError(`"${idOrPrefix}" matches ${matches.length} sessions; use the full id`);
}

const SESSION_ARG = { type: 'string', description: 'Session id, or a unique prefix of it, from list_sessions.' };

export const TOOLS: Tool[] = [
  {
    name: 'list_sessions',
    description:
      'List agent and terminal sessions on this machine, newest first: id, title, provider, lifecycle (running/exited/killed), status (working, waiting_input, waiting_permission, ...), folder, branch, and pid.',
    inputSchema: {
      type: 'object',
      properties: { running_only: { type: 'boolean', description: 'Only sessions that are still running.' } }
    },
    run: async (client, args) => {
      const { sessions } = await client.listSessions(args['running_only'] === true ? { lifecycle: 'running' } : {});
      return JSON.stringify(sessions.map(summary), null, 2);
    }
  },
  {
    name: 'get_session',
    description:
      'Details for one session: its record, process tree, listening ports, git status of its folder, and model spend when the agent reports it.',
    inputSchema: { type: 'object', properties: { session_id: SESSION_ARG }, required: ['session_id'] },
    run: async (client, args) => {
      const session = await resolve(client, text(args, 'session_id'));
      const [detail, git] = await Promise.all([
        client.sessionDetail(session.id),
        client.git(session.id).catch(() => null)
      ]);
      return JSON.stringify(
        {
          session: summary(detail.session),
          processes: detail.processes.map((p) => ({ pid: p.pid, ppid: p.ppid, command: redactText(p.command) })),
          ports: detail.ports.map((p) => ({ port: p.port, pid: p.pid, url: `http://localhost:${p.port}` })),
          git:
            git === null || git.worktreeRoot === null
              ? null
              : {
                  branch: git.branch,
                  changed: git.files.map((f) => f.path),
                  insertions: git.insertions,
                  deletions: git.deletions
                }
        },
        null,
        2
      );
    }
  },
  {
    name: 'read_output',
    description:
      'Read the terminal output of a session as plain text (escape codes removed, secrets redacted). Pass since_seq from a previous call to get only newer output.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: SESSION_ARG,
        max_bytes: {
          type: 'integer',
          minimum: 256,
          maximum: 262144,
          description: 'Tail size when since_seq is absent. Default 16384.'
        },
        since_seq: { type: 'integer', minimum: 0, description: 'Return only output after this sequence number.' }
      },
      required: ['session_id']
    },
    run: async (client, args) => {
      const session = await resolve(client, text(args, 'session_id'));
      const since = typeof args['since_seq'] === 'number' ? args['since_seq'] : undefined;
      const maxBytes = typeof args['max_bytes'] === 'number' ? args['max_bytes'] : 16_384;
      const page = await client.output(
        session.id,
        since === undefined ? { tailBytes: maxBytes, limit: 1000 } : { sinceSeq: since, limit: 1000 }
      );
      const body = plainText(page.chunks.map((chunk) => chunk.data).join(''));
      const cursor = page.resumeAfterSeq ?? since ?? 0;
      return `${body}\n\n[next since_seq: ${cursor}${page.hasMore ? ', more output available' : ''}${page.live ? '' : ', session has ended'}]`;
    }
  },
  {
    name: 'search_output',
    description:
      'Search the terminal output of all sessions (or one) for text, case-insensitive. Returns matching lines with their session ids.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to find, at least 2 characters.' },
        session_id: SESSION_ARG,
        limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Default 50.' }
      },
      required: ['text']
    },
    run: async (client, args) => {
      const sessionId = await optionalSession(client, args);
      const result = await client.search(text(args, 'text'), {
        ...(sessionId === undefined ? {} : { sessionId }),
        limit: typeof args['limit'] === 'number' ? args['limit'] : 50
      });
      return JSON.stringify(result, null, 2);
    }
  },
  {
    name: 'send_input',
    description:
      'Type text into a running session started by agenterm, as if at its keyboard. Presses Enter afterwards unless press_enter is false. An empty text with press_enter just presses Enter. Control keys are plain characters, for example "\\u0003" for Ctrl+C or "\\u001b" for Escape.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: SESSION_ARG,
        text: { type: 'string', description: 'Text to type. May be empty to press Enter alone.' },
        press_enter: { type: 'boolean', description: 'Press Enter after the text. Default true.' }
      },
      required: ['session_id', 'text']
    },
    run: async (client, args) => {
      const session = await resolve(client, text(args, 'session_id'));
      const typed = args['text'];
      if (typeof typed !== 'string') throw new ToolInputError('text must be a string');
      const data = typed + (args['press_enter'] === false ? '' : '\r');
      if (data.length === 0) throw new ToolInputError('nothing to type: text is empty and press_enter is false');
      const result = await client.sendInput(session.id, { data });
      return `Typed ${result.acceptedBytes} bytes into ${session.title}.`;
    }
  },
  {
    name: 'interrupt',
    description: 'Press Ctrl+C in a running session to stop its current command.',
    inputSchema: { type: 'object', properties: { session_id: SESSION_ARG }, required: ['session_id'] },
    run: async (client, args) => {
      const session = await resolve(client, text(args, 'session_id'));
      await client.signal(session.id, { signal: 'interrupt' });
      return `Sent Ctrl+C to ${session.title}.`;
    }
  },
  {
    name: 'kill_session',
    description:
      'End a running session agenterm started, and every process it started. To prevent mistakes, confirm_pid must equal the session pid from list_sessions. Sessions attached from another terminal are refused unless AGENTERM_MCP_ALLOW_KILL=1.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: SESSION_ARG,
        confirm_pid: { type: 'integer', description: 'The pid of the session being killed.' }
      },
      required: ['session_id', 'confirm_pid']
    },
    run: async (client, args) => {
      const session = await resolve(client, text(args, 'session_id'));
      if (session.origin === 'attached' && process.env['AGENTERM_MCP_ALLOW_KILL'] !== '1') {
        throw new ToolInputError(
          `"${session.title}" was started outside agenterm; ask the user to end it themselves. Nothing was killed.`
        );
      }
      if (args['confirm_pid'] !== session.pid) {
        throw new ToolInputError(`confirm_pid must be ${session.pid} for "${session.title}"; nothing was killed`);
      }
      const result = await client.deleteSession(session.id, { killTree: true, confirmPid: session.pid });
      return result.killed ? `Killed ${session.title} (pid ${session.pid}).` : `${session.title} had already ended.`;
    }
  },
  {
    name: 'recent_activity',
    description: 'Recent events across sessions, newest first: starts, exits, status changes, ports, and file edits.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: SESSION_ARG,
        limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Default 50.' }
      }
    },
    run: async (client, args) => {
      const sessionId = await optionalSession(client, args);
      const limit = typeof args['limit'] === 'number' ? args['limit'] : 50;
      const { events } = await client.events({ ...(sessionId === undefined ? {} : { sessionId }), limit });
      return redactText(JSON.stringify(events, null, 2));
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
export async function handleMcpMessage(client: AgentermClient, line: string, version: string): Promise<string | null> {
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
        serverInfo: { name: 'agenterm', version },
        instructions:
          'agenterm sees every agent and terminal session on this machine. Use list_sessions first, then read_output or get_session. Only kill a session when the user asked for it.'
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
        const output = await tool.run(client, args);
        return reply(id, { content: [{ type: 'text', text: output }] });
      } catch (error) {
        const message =
          error instanceof AgentermApiError
            ? `${error.message}${error.hint === undefined ? '' : ` (${error.hint})`}`
            : error instanceof ToolInputError
              ? error.message
              : /ECONNREFUSED|fetch failed/.test(String(error))
                ? 'The agenterm daemon is not running. Start it with `agenterm daemon start`.'
                : String(error);
        return reply(id, { content: [{ type: 'text', text: message }], isError: true });
      }
    }
    default:
      return failure(id, -32601, `method not found: ${request.method}`);
  }
}

/** Serve MCP over stdin and stdout until stdin closes. Logs go to stderr only. */
export async function runMcpStdio(client: () => AgentermClient, version: string): Promise<void> {
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
  for await (const line of lines) {
    if (line.trim().length === 0) continue;
    const response = await handleMcpMessage(client(), line, version);
    if (response !== null) process.stdout.write(`${response}\n`);
  }
}
