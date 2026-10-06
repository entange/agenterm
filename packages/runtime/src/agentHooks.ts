import crypto from 'node:crypto';
import { redactText, type AgentProvider, type SessionOverlayStatus } from '@agenterm/core';

/** Status derived from one agent push. Null means the push changes nothing. */
export interface HookStatus {
  overlay: SessionOverlayStatus;
  summary: string | null;
}

const SUMMARY_LIMIT = 160;

function clip(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  const flat = redactText(text).replace(/\s+/g, ' ').trim();
  if (flat.length === 0) return null;
  return flat.length > SUMMARY_LIMIT ? `${flat.slice(0, SUMMARY_LIMIT - 1)}…` : flat;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Map a Claude Code hook payload to a status.
 *
 * UserPromptSubmit and PostToolUse mean it is working. Notification is
 * either a permission prompt or an idle wait. Stop means it finished its
 * turn and is waiting for the next prompt. Unknown events change nothing.
 */
export function claudeHookStatus(payload: unknown): HookStatus | null {
  const record = asRecord(payload);
  if (record === null) return null;
  const event = record['hook_event_name'];
  switch (event) {
    case 'UserPromptSubmit':
      return { overlay: 'working', summary: clip(record['prompt']) };
    case 'PreToolUse':
    case 'PostToolUse': {
      const tool = typeof record['tool_name'] === 'string' ? record['tool_name'] : null;
      return { overlay: 'working', summary: tool === null ? null : `Using ${tool}` };
    }
    case 'Notification': {
      const message = clip(record['message']);
      const kind = typeof record['notification_type'] === 'string' ? record['notification_type'] : '';
      const permission = kind === 'permission_prompt' || /permission|approve|allow/i.test(message ?? '');
      return { overlay: permission ? 'waiting_permission' : 'waiting_input', summary: message };
    }
    case 'Stop':
      return { overlay: 'waiting_input', summary: 'Finished its turn' };
    case 'SessionEnd':
      return { overlay: 'completed', summary: null };
    default:
      return null;
  }
}

/** Map a Codex notify payload (passed as one JSON argument) to a status. */
export function codexNotifyStatus(payload: unknown): HookStatus | null {
  const record = asRecord(payload);
  if (record === null) return null;
  if (record['type'] === 'agent-turn-complete') {
    return { overlay: 'waiting_input', summary: clip(record['last-assistant-message']) ?? 'Finished its turn' };
  }
  return null;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function tomlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

const CLAUDE_EVENTS = ['UserPromptSubmit', 'PostToolUse', 'Notification', 'Stop', 'SessionEnd'] as const;
const TOOL_EVENTS: ReadonlySet<string> = new Set(['PreToolUse', 'PostToolUse']);

/**
 * Per-session status hooks.
 *
 * At spawn, adds launch arguments that make Claude Code and Codex push
 * their own status to a per-session ingest URL on the daemon. Each
 * session gets its own random ingest token, which only authorizes status
 * pushes for that session; the daemon token never enters the agent env.
 * Nothing under the agents' own config folders is read or written.
 */
export class AgentHooks {
  private readonly tokens = new Map<string, string>();
  private port: number;

  constructor(private readonly options: { port: number; enabled?: boolean | undefined }) {
    this.port = options.port;
  }

  /** Point new hooks at the port actually bound (tests bind port 0). */
  setPort(port: number): void {
    this.port = port;
  }

  /** Arguments to launch with, plus whether hooks were installed. */
  prepare(input: { sessionId: string; provider: AgentProvider; args: string[]; requested: boolean }): {
    args: string[];
    installed: boolean;
  } {
    const { sessionId, provider, args } = input;
    const usable = this.options.enabled !== false && input.requested && process.platform !== 'win32';
    if (!usable || (provider !== 'claude' && provider !== 'codex')) return { args, installed: false };
    const token = crypto.randomBytes(24).toString('hex');
    const url = `http://127.0.0.1:${this.port}/ingest/${provider}/${sessionId}`;
    if (provider === 'claude') {
      // A user-supplied --settings wins; layering a second one would be surprising.
      if (args.some((arg) => arg === '--settings' || arg.startsWith('--settings='))) return { args, installed: false };
      const command = `curl -sS -m 2 -o /dev/null -X POST -H 'Content-Type: application/json' -H ${shellQuote(
        `Authorization: Bearer ${token}`
      )} --data-binary @- ${shellQuote(url)} || true`;
      const hooks: Record<string, unknown[]> = {};
      for (const event of CLAUDE_EVENTS) {
        const entry: Record<string, unknown> = { hooks: [{ type: 'command', command, timeout: 5 }] };
        if (TOOL_EVENTS.has(event)) entry['matcher'] = '*';
        hooks[event] = [entry];
      }
      this.tokens.set(sessionId, token);
      return { args: ['--settings', JSON.stringify({ hooks }), ...args], installed: true };
    }
    if (args.some((arg, i) => /^notify\s*=/.test(arg) && (args[i - 1] === '-c' || args[i - 1] === '--config'))) {
      return { args, installed: false };
    }
    // Codex appends the JSON payload as the last argument, which becomes --data-binary's value.
    const notify = [
      'curl',
      '-sS',
      '-m',
      '2',
      '-o',
      '/dev/null',
      '-X',
      'POST',
      '-H',
      'Content-Type: application/json',
      '-H',
      `Authorization: Bearer ${token}`,
      url,
      '--data-binary'
    ];
    this.tokens.set(sessionId, token);
    return { args: ['-c', `notify=[${notify.map(tomlString).join(', ')}]`, ...args], installed: true };
  }

  /** Constant-time check that a push carries this session's ingest token. */
  verify(sessionId: string, header: string | undefined): boolean {
    const token = this.tokens.get(sessionId);
    if (token === undefined || typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
    const given = Buffer.from(header.slice('Bearer '.length));
    const wanted = Buffer.from(token);
    return given.length === wanted.length && crypto.timingSafeEqual(given, wanted);
  }

  hasHooks(sessionId: string): boolean {
    return this.tokens.has(sessionId);
  }

  forget(sessionId: string): void {
    this.tokens.delete(sessionId);
  }
}

/** Opt-out switch: AGENTERM_AGENT_HOOKS=0 disables injection daemon-wide. */
export function agentHooksEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['AGENTERM_AGENT_HOOKS'] !== '0';
}
