import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';
import type { AgentProvider, DiscoveredProcess } from '@agenterm/core';
import { redactText } from '@agenterm/core';
import si from 'systeminformation';

const execFileAsync = promisify(execFile);

/** Binary names treated as agent candidates. Lowercased for matching. */
export const KNOWN_AGENT_BINARIES: Readonly<Record<string, AgentProvider>> = {
  claude: 'claude',
  codex: 'codex',
  gemini: 'gemini',
  opencode: 'opencode'
};

/** Script-host binaries whose first argument names the real agent. */
const INTERPRETERS: ReadonlySet<string> = new Set(['node', 'bun', 'deno', 'python', 'python3']);

/** npm package paths that identify an agent launched through an interpreter. */
const PACKAGE_MARKERS: ReadonlyArray<readonly [string, AgentProvider]> = [
  ['@anthropic-ai/claude-code', 'claude'],
  ['@openai/codex', 'codex'],
  ['@google/gemini-cli', 'gemini'],
  ['opencode-ai', 'opencode']
];

/** Raw process entry used for matching. Keeps the runtime layer testable. */
export interface RawProcessEntry {
  pid: number;
  ppid: number;
  command: string;
  cwd: string | null;
}

function baseName(file: string): string {
  const base = file.split(/[\\/]/).pop() ?? file;
  return base.toLowerCase().replace(/\.(exe|cmd|js|mjs|cjs)$/, '');
}

/**
 * Identify the agent behind one command line, or null.
 *
 * Matches the executable name exactly (`claude`, `/opt/bin/codex`), or an
 * interpreter running a known script or package (`node .../codex.js`,
 * `node .../@anthropic-ai/claude-code/cli.js`). GUI app bundles never
 * match, so a desktop app named Claude is not an attachable CLI agent.
 */
export function agentOf(command: string): { binary: string; provider: AgentProvider } | null {
  const trimmed = command.trim();
  // Executable paths may hold spaces; everything before the first flag is the head.
  const head = trimmed.split(/\s-/)[0] ?? trimmed;
  if (head.includes('.app/Contents/')) return null;
  const parts = trimmed.split(/\s+/);
  const argv0 = parts[0] ?? '';
  if (argv0.length === 0) return null;
  const binary = baseName(argv0);
  const direct = KNOWN_AGENT_BINARIES[binary];
  if (direct !== undefined) return { binary, provider: direct };
  if (!INTERPRETERS.has(binary)) return null;
  const script = parts.slice(1).find((part) => !part.startsWith('-'));
  if (script === undefined) return null;
  const scripted = KNOWN_AGENT_BINARIES[baseName(script)];
  if (scripted !== undefined) return { binary: baseName(script), provider: scripted };
  for (const [marker, provider] of PACKAGE_MARKERS) {
    if (script.includes(marker)) return { binary: provider, provider };
  }
  return null;
}

/**
 * Match raw entries against known agent binaries.
 *
 * Candidates only. Pure function so tests can inject fixtures without
 * touching live processes. Command lines are redacted because agents are
 * often launched with tokens in flags.
 */
export function matchAgentCandidates(entries: readonly RawProcessEntry[], selfPid = process.pid): DiscoveredProcess[] {
  const out: DiscoveredProcess[] = [];
  for (const entry of entries) {
    if (!Number.isInteger(entry.pid) || entry.pid <= 0 || entry.pid === selfPid) continue;
    if (typeof entry.command !== 'string' || entry.command.trim().length === 0) continue;
    const agent = agentOf(entry.command);
    if (agent === null) continue;
    out.push({
      pid: entry.pid,
      ppid: Number.isInteger(entry.ppid) && entry.ppid >= 0 ? entry.ppid : 0,
      commandLine: redactText(entry.command),
      binaryName: agent.binary,
      provider: agent.provider,
      cwd: entry.cwd,
      sessionId: null
    });
  }
  out.sort((a, b) => a.pid - b.pid);
  return out;
}

/** Lister type injected for tests. Defaults to a systeminformation scan. */
export type ProcessLister = () => Promise<readonly RawProcessEntry[]>;

/** Parse `ps -o pid=,ppid=,args=` output. Exported for tests. */
export function parsePsOutput(stdout: string): RawProcessEntry[] {
  const out: RawProcessEntry[] = [];
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (match === null) continue;
    out.push({ pid: Number(match[1]), ppid: Number(match[2]), command: (match[3] ?? '').trim(), cwd: null });
  }
  return out;
}

async function systeminformationLister(): Promise<readonly RawProcessEntry[]> {
  const result = await si.processes();
  const list = (result.list ?? []) as Array<{ pid?: number; parentPid?: number; command?: string; params?: string; path?: string }>;
  return list.map((entry) => {
    const command = typeof entry.command === 'string' && entry.command.length > 0 ? entry.command : (entry.path ?? '');
    const params = typeof entry.params === 'string' && entry.params.length > 0 ? ` ${entry.params}` : '';
    return {
      pid: typeof entry.pid === 'number' ? entry.pid : -1,
      ppid: typeof entry.parentPid === 'number' ? entry.parentPid : 0,
      command: `${command}${params}`,
      cwd: null
    };
  });
}

/**
 * Full argv per process. POSIX uses ps for exact argv (systeminformation
 * reports display names like "Codex (Renderer)" on macOS); Windows falls
 * back to systeminformation.
 */
export async function systemProcessLister(): Promise<readonly RawProcessEntry[]> {
  if (process.platform === 'win32') return systeminformationLister();
  try {
    const { stdout } = await execFileAsync('ps', ['-axww', '-o', 'pid=,ppid=,args='], {
      timeout: 5000,
      maxBuffer: 32 * 1024 * 1024
    });
    return parsePsOutput(stdout);
  } catch {
    return systeminformationLister();
  }
}

/**
 * Resolve a process working directory without a shell.
 *
 * Linux reads /proc; macOS asks lsof for the cwd descriptor. Returns null
 * on other platforms, permission errors, or exited pids.
 */
export async function processCwd(pid: number): Promise<string | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === 'linux') {
      return fs.readlinkSync(`/proc/${pid}/cwd`);
    }
    if (process.platform === 'darwin') {
      const { stdout } = await execFileAsync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { timeout: 3000 });
      const line = stdout.split('\n').find((entry) => entry.startsWith('n/'));
      return line === undefined ? null : line.slice(1);
    }
  } catch {
    return null;
  }
  return null;
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
