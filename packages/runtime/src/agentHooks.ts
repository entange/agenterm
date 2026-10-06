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

/** Notification types that mean the agent is blocked on the user. */
const NEEDS_REPLY: ReadonlySet<string> = new Set([
  'idle_prompt',
  'agent_needs_input',
  'elicitation_dialog',
  'elicitation_url_dialog'
]);

/**
 * Map a Claude Code hook payload to a status.
 *
 * UserPromptSubmit and tool completions mean it is working.
 * PermissionRequest (or a permission_prompt notification) means it waits
 * for approval; idle and input notifications mean it waits for a reply;
 * Stop means it finished its turn; StopFailure means the turn failed.
 * SessionEnd also fires on /clear and /resume, so it is ignored; the
 * process exit is the truth for an ended session.
 * Other notification types (auth, quota, ...) and unknown events change
 * nothing.
 */
export function claudeHookStatus(payload: unknown): HookStatus | null {
  const record = asRecord(payload);
  if (record === null) return null;
  const tool = typeof record['tool_name'] === 'string' ? record['tool_name'] : null;
  switch (record['hook_event_name']) {
    case 'UserPromptSubmit':
      return { overlay: 'working', summary: clip(record['prompt']) };
    case 'PermissionRequest':
      return { overlay: 'waiting_permission', summary: tool === null ? null : `Wants to use ${tool}` };
    case 'PreToolUse':
    case 'PostToolUse':
    case 'PostToolUseFailure':
      return { overlay: 'working', summary: tool === null ? null : `Using ${tool}` };
    case 'Notification': {
      const message = clip(record['message']);
      const kind = typeof record['notification_type'] === 'string' ? record['notification_type'] : null;
      if (kind === 'permission_prompt') return { overlay: 'waiting_permission', summary: message };
      if (kind !== null) return NEEDS_REPLY.has(kind) ? { overlay: 'waiting_input', summary: message } : null;
      // Older versions send no type; fall back to the message text.
      if (/permission|approve|allow/i.test(message ?? '')) return { overlay: 'waiting_permission', summary: message };
      return /waiting|input/i.test(message ?? '') ? { overlay: 'waiting_input', summary: message } : null;
    }
    case 'Stop':
      return { overlay: 'waiting_input', summary: clip(record['last_assistant_message']) ?? 'Finished its turn' };
    case 'StopFailure':
      return { overlay: 'failed', summary: clip(record['error']) ?? 'The turn ended with an error' };
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

const CLAUDE_EVENTS = [
  'UserPromptSubmit',
  'PermissionRequest',
  'PostToolUse',
  'PostToolUseFailure',
  'Notification',
  'Stop',
  'StopFailure'
] as const;
const TOOL_EVENTS: ReadonlySet<string> = new Set(['PermissionRequest', 'PostToolUse', 'PostToolUseFailure']);

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

  /**
   * Arguments and extra environment to launch with, plus whether hooks
   * were installed. Claude Code also gets its OpenTelemetry logs pointed
   * at the daemon for cost and token totals, unless the user already
   * configured telemetry themselves.
   */
  prepare(input: {
    sessionId: string;
    provider: AgentProvider;
    args: string[];
    requested: boolean;
    env?: Record<string, string> | undefined;
  }): { args: string[]; env: Record<string, string>; installed: boolean } {
    const { sessionId, provider } = input;
    const usable = this.options.enabled !== false && input.requested && process.platform !== 'win32';
    if (!usable || (provider !== 'claude' && provider !== 'codex'))
      return { args: input.args, env: {}, installed: false };
    const token = crypto.randomBytes(24).toString('hex');
    const prepared = this.launchArgs(sessionId, provider, input.args, token);
    if (!prepared.installed) return { ...prepared, env: {} };
    this.tokens.set(sessionId, token);
    const env = provider === 'claude' ? this.telemetryEnv(sessionId, token, input.env ?? {}) : {};
    return { ...prepared, env };
  }

  private telemetryEnv(sessionId: string, token: string, current: Record<string, string>): Record<string, string> {
    const configured = Object.keys(current).some(
      (key) => key.startsWith('OTEL_') || key === 'CLAUDE_CODE_ENABLE_TELEMETRY'
    );
    if (configured) return {};
    return {
      CLAUDE_CODE_ENABLE_TELEMETRY: '1',
      OTEL_LOGS_EXPORTER: 'otlp',
      OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: 'http/json',
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `http://127.0.0.1:${this.port}/otel/${sessionId}/v1/logs`,
      OTEL_EXPORTER_OTLP_LOGS_HEADERS: `x-agenterm-token=${token}`,
      OTEL_LOGS_EXPORT_INTERVAL: '2000'
    };
  }

  private launchArgs(
    sessionId: string,
    provider: 'claude' | 'codex',
    args: string[],
    token: string
  ): { args: string[]; installed: boolean } {
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
    return { args: ['-c', `notify=[${notify.map(tomlString).join(', ')}]`, ...args], installed: true };
  }

  /** Constant-time check of a session ingest token, given as `Bearer <t>` or bare. */
  verify(sessionId: string, header: string | undefined): boolean {
    const token = this.tokens.get(sessionId);
    if (token === undefined || typeof header !== 'string') return false;
    const given = Buffer.from(header.startsWith('Bearer ') ? header.slice('Bearer '.length) : header);
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
