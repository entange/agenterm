import type { AgentermEvent, AgentProvider, SessionRecord } from '@agenterm/core';

export const PROVIDER_NAMES: Record<AgentProvider, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  gemini: 'Gemini CLI',
  opencode: 'opencode',
  generic: 'Command'
};

/** Compact age: now, 45s, 12m, 3h, 2d. */
export function formatAge(fromMs: number, nowMs = Date.now()): string {
  const seconds = Math.max(0, Math.floor((nowMs - fromMs) / 1000));
  if (seconds < 5) return 'now';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

/** Duration like 850ms, 12.4s, 3m 05s, 2h 10m. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m ${String(Math.floor((ms % 60_000) / 1000)).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function formatClock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/** Home-relative path for display: /Users/me/code/app → ~/code/app. */
export function shortPath(cwd: string): string {
  const match = /^(\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)(.*)$/.exec(cwd);
  if (match === null) return cwd;
  return `~${match[2] ?? ''}` || '~';
}

/** Last path segment, for compact labels. */
export function folderName(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? cwd;
}

export function isLive(session: SessionRecord): boolean {
  return session.lifecycle === 'running' || session.lifecycle === 'starting' || session.lifecycle === 'created';
}

/** One plain sentence per event, written from the user's side. */
export function describeEvent(event: AgentermEvent): string {
  switch (event.kind) {
    case 'session.created':
      return `Started ${event.commandLine.join(' ')}`;
    case 'session.exited':
      if (event.exitSignal !== null) return `Ended by ${event.exitSignal}`;
      return event.exitCode === null
        ? 'Ended'
        : event.exitCode === 0
          ? 'Finished cleanly'
          : `Exited with code ${event.exitCode}`;
    case 'session.attached':
      return `Attached to pid ${event.pid}`;
    case 'session.detached':
      return 'Closed';
    case 'session.updated':
      return `Renamed to “${event.title}”`;
    case 'agent.status': {
      const label: Record<typeof event.overlay, string> = {
        unknown: 'Status unknown',
        working: 'Working',
        waiting_input: 'Waiting for your reply',
        waiting_permission: 'Waiting for your approval',
        completed: 'Finished its task',
        failed: 'Reported a failure'
      };
      return event.summary === null ? label[event.overlay] : `${label[event.overlay]} — ${event.summary}`;
    }
    case 'port.opened':
      return `Listening on port ${event.port}`;
    case 'port.closed':
      return `Stopped listening on port ${event.port}`;
    case 'workspace.conflict':
      return `Shares ${shortPath(event.cwd)} with ${event.involvedSessionIds.length - 1} other running ${event.involvedSessionIds.length === 2 ? 'session' : 'sessions'}`;
    case 'file.changed':
      return `${event.change === 'added' ? 'Created' : event.change === 'deleted' ? 'Deleted' : 'Edited'} ${event.path}`;
    case 'process.started':
      return `Started ${event.command}`;
    case 'process.exited':
      return `${event.command} exited`;
    default:
      return event.kind;
  }
}

/** Split a typed argument string like a shell would, honoring quotes. */
export function splitArgs(input: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let started = false;
  for (let i = 0; i < input.length; i++) {
    const char = input[i] ?? '';
    if (quote !== null) {
      if (char === quote) quote = null;
      else if (char === '\\' && quote === '"' && i + 1 < input.length) current += input[++i] ?? '';
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) out.push(current);
      current = '';
      started = false;
    } else if (char === '\\' && i + 1 < input.length) {
      current += input[++i] ?? '';
      started = true;
    } else {
      current += char;
      started = true;
    }
  }
  if (started) out.push(current);
  return out;
}
