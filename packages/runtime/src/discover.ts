import type { DiscoveredProcess } from '@agenterm/core';
import si from 'systeminformation';

/** Binary names treated as agent candidates. Lowercased for matching. */
export const KNOWN_AGENT_BINARIES: readonly string[] = [
  'claude',
  'codex',
  'gemini',
  'opencode'
] as const;

/** Raw process entry used for matching. Keeps the runtime layer testable. */
export interface RawProcessEntry {
  pid: number;
  ppid: number;
  command: string;
  cwd: string | null;
}

function binaryOf(command: string): string {
  const first = command.trim().split(/\s+/)[0] ?? '';
  const base = first.split('/').pop() ?? first;
  return base.toLowerCase().replace(/\.exe$/, '');
}

/**
 * Match raw entries against known agent binaries.
 *
 * Candidates only. Pure function so tests can inject fixtures without
 * touching live processes.
 */
export function matchAgentCandidates(entries: readonly RawProcessEntry[]): DiscoveredProcess[] {
  const out: DiscoveredProcess[] = [];
  for (const entry of entries) {
    if (!Number.isInteger(entry.pid) || entry.pid <= 0) continue;
    if (typeof entry.command !== 'string' || entry.command.trim().length === 0) continue;
    const binary = binaryOf(entry.command);
    const hit = KNOWN_AGENT_BINARIES.some(
      (known) => binary === known || binary.startsWith(`${known}-`) || entry.command.toLowerCase().includes(known)
    );
    if (!hit) continue;
    out.push({
      pid: entry.pid,
      ppid: Number.isInteger(entry.ppid) && entry.ppid >= 0 ? entry.ppid : 0,
      commandLine: entry.command,
      binaryName: binary,
      cwd: entry.cwd
    });
  }
  out.sort((a, b) => a.pid - b.pid);
  return out;
}

/** Lister type injected for tests. Defaults to a systeminformation scan. */
export type ProcessLister = () => Promise<readonly RawProcessEntry[]>;

export async function systemProcessLister(): Promise<readonly RawProcessEntry[]> {
  const result = await si.processes();
  const list = (result.list ?? []) as Array<{
    pid?: number;
    parentPid?: number;
    command?: string;
    path?: string;
  }>;
  return list.map((entry) => ({
    pid: typeof entry.pid === 'number' ? entry.pid : -1,
    ppid: typeof entry.parentPid === 'number' ? entry.parentPid : 0,
    command: typeof entry.command === 'string' && entry.command.length > 0 ? entry.command : (entry.path ?? ''),
    cwd: null
  }));
}

/** Run discovery with an injectable lister. Never throws on empty scans. */
export async function discoverAgents(lister: ProcessLister = systemProcessLister): Promise<DiscoveredProcess[]> {
  try {
    const entries = await lister();
    return matchAgentCandidates(entries);
  } catch {
    return [];
  }
}
