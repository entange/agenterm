import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';
import {
  AGENTS,
  PASS_THROUGH,
  processName,
  redactText,
  SHELLS,
  type ListProcessesResponse,
  type OutsideProcess
} from '@agenterm/core';
import type { GitInfo } from './gitInfo.js';
import { projectOf } from './project.js';
import { listeningSockets, type SockEntry } from './supervisor.js';

/**
 * Commands running outside agenterm.
 *
 * agenterm only owns what it starts. Everything else a person types into a
 * terminal, or an agent runs in its own shell, or that outlived whatever
 * started it, is found here by reading the process table: a command is the
 * topmost process of the user's that a shell or an agent started, or that
 * was left with no parent. Its whole subtree belongs to it.
 */

/** One row of the process table. */
export interface ProcRow {
  pid: number;
  ppid: number;
  uid: number;
  /** Seconds since it started. */
  elapsedSeconds: number;
  /** Terminal device, or null. */
  tty: string | null;
  cpuPercent: number;
  rssBytes: number;
  /** Executable path or name. */
  comm: string;
  /** Full command line. */
  args: string;
}

/** What one scan reads from the system. Injected in tests. */
export interface OutsideProbes {
  processes: () => Promise<ProcRow[]>;
  sockets: () => Promise<SockEntry[]>;
  /** macOS: pids launchd runs as jobs (apps, agents, services). Null where there is no launchd. */
  launchdJobs: () => Promise<ReadonlySet<number> | null>;
  /** Linux: true when the pid is a systemd service rather than something left behind. */
  isService: (pid: number) => boolean;
  /** Working directories by pid. Missing entries are unknown. */
  cwds: (pids: number[]) => Promise<Map<number, string>>;
}

/** Programs that host shells for people. Their shells' commands count; they never do. */
const HOSTS = new Set(['tmux', 'screen', 'zellij', 'mosh-server', 'sshd', 'systemd', 'launchd', 'init']);

/** Executables that belong to the system or an app bundle, never to a command someone ran. */
const SYSTEM_PATH =
  /^(\/System\/|\/usr\/libexec\/|\/usr\/sbin\/|\/sbin\/|\/usr\/lib\/|\/lib\/)|\.(app|appex|xpc|framework|bundle)\/|\/Library\//;

/** Children of agents that are tools for the agent, not commands it ran. */
const AGENT_TOOL = /(^|[\s/@_-])mcp([\s/@_-]|$)/i;

/** How long a command has to run before it is listed. */
const MIN_AGE_SECONDS = 2;

/** Parse ps `etime`: [[dd-]hh:]mm:ss. */
export function parseElapsed(text: string): number {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(text.trim());
  if (match === null) return 0;
  const [, days = '0', hours = '0', minutes = '0', seconds = '0'] = match;
  return ((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60 + Number(seconds);
}

/**
 * Parse `ps -o pid=,ppid=,uid=,etime=,tty=,pcpu=,rss=,args=` joined with
 * `ps -o pid=,comm=` (comm can hold spaces, so it comes from its own call).
 * Exported for tests.
 */
export function parseProcessTable(table: string, comms: string): ProcRow[] {
  const commOf = new Map<number, string>();
  for (const line of comms.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (match !== null) commOf.set(Number(match[1]), (match[2] ?? '').trim());
  }
  const rows: ProcRow[] = [];
  for (const line of table.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+([\d.]+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match === null) continue;
    const pid = Number(match[1]);
    const args = (match[8] ?? '').trim();
    const tty = match[5] ?? '';
    rows.push({
      pid,
      ppid: Number(match[2]),
      uid: Number(match[3]),
      elapsedSeconds: parseElapsed(match[4] ?? ''),
      tty: /^\?+$|^-$/.test(tty) ? null : tty,
      cpuPercent: Number(match[6]),
      rssBytes: Number(match[7]) * 1024,
      comm: commOf.get(pid) ?? args.split(/\s+/)[0] ?? '',
      args
    });
  }
  return rows;
}

export interface FindOutsideOptions {
  /** Only this user's commands; another user's cannot be stopped anyway. */
  uid: number;
  /** Processes whose whole subtree is agenterm's own: the daemon and its tasks. */
  ownPids: number[];
  nowMs: number;
}

/** A command before its folder is known. */
export type OutsideFound = Omit<OutsideProcess, 'cwd' | 'project'>;

/**
 * Pick out the commands from a process table. Pure, so the rules can be
 * tested against recorded trees.
 */
export function findOutside(
  procs: ProcRow[],
  sockets: SockEntry[],
  system: { launchdJobs: ReadonlySet<number> | null; isService: (pid: number) => boolean },
  options: FindOutsideOptions
): OutsideFound[] {
  const byPid = new Map(procs.map((proc) => [proc.pid, proc]));
  const children = new Map<number, number[]>();
  for (const proc of procs) {
    const list = children.get(proc.ppid) ?? [];
    list.push(proc.pid);
    children.set(proc.ppid, list);
  }
  const subtree = (root: number): number[] => {
    const seen = new Set([root]);
    const out = [root];
    for (let i = 0; i < out.length; i++) {
      for (const child of children.get(out[i] ?? 0) ?? []) {
        if (seen.has(child)) continue;
        seen.add(child);
        out.push(child);
      }
    }
    return out;
  };

  const own = new Set(options.ownPids.flatMap(subtree));
  const names = new Map<number, string>();
  const nameOf = (proc: ProcRow): string => {
    let name = names.get(proc.pid);
    if (name === undefined) {
      name = processName(proc);
      names.set(proc.pid, name);
    }
    return name;
  };

  /** Shells, launchers, agents, and hosts are what commands run under, never commands. */
  const isHost = (proc: ProcRow): boolean => {
    const name = nameOf(proc);
    const lower = name.toLowerCase();
    return (
      SHELLS.has(lower) || lower === 'login' || AGENTS.has(lower) || HOSTS.has(lower) || /^\(.*\)$/.test(name) // (sd-pam)
    );
  };

  /** The init process, or a per-user service manager that adopts orphans. */
  const isAdopter = (pid: number): boolean => {
    if (pid <= 1) return true;
    const parent = byPid.get(pid);
    return parent !== undefined && parent.uid === options.uid && nameOf(parent) === 'systemd';
  };

  const starts = (proc: ProcRow): boolean => {
    if (proc.uid !== options.uid || proc.pid <= 1 || own.has(proc.pid) || isHost(proc)) return false;
    // `agenterm ps` and friends, however they were launched.
    if (/(^|[\s/])agenterm(\.js)?(\s|$)/.test(proc.args.split(/\s+/).slice(0, 4).join(' '))) return false;
    const parent = byPid.get(proc.ppid);
    const parentName = parent === undefined ? '' : nameOf(parent).toLowerCase();
    if (SHELLS.has(parentName)) return true;
    // Shells exec a lone command in place, so an agent can be the direct parent.
    if (AGENTS.has(parentName)) return !AGENT_TOOL.test(proc.args);
    if (!isAdopter(proc.ppid)) return false;
    // Left behind: adopted by init. Apps and services are adopted too; leave those out.
    if (system.launchdJobs?.has(proc.pid) === true || system.isService(proc.pid)) return false;
    const executable = proc.comm.startsWith('/') ? proc.comm : (proc.args.split(/\s+/)[0] ?? '');
    return !SYSTEM_PATH.test(executable) && !proc.comm.startsWith('com.apple.');
  };

  const qualifies = new Set(procs.filter(starts).map((proc) => proc.pid));
  /** The agent, terminal, or editor above a pid, skipping shells and launchers. */
  const ownerAbove = (pid: number): { name: string; pid: number } | null => {
    let at = byPid.get(pid);
    for (let depth = 0; depth < 32 && at !== undefined; depth++) {
      if (at.pid <= 1) return null;
      const name = nameOf(at);
      const lower = name.toLowerCase();
      if (lower === 'launchd' || lower === 'init' || lower === 'systemd') return null;
      if (!PASS_THROUGH.has(lower)) return { name, pid: at.pid };
      at = byPid.get(at.ppid);
    }
    return null;
  };
  const hasQualifyingAncestor = (proc: ProcRow): boolean => {
    let at = byPid.get(proc.ppid);
    for (let depth = 0; depth < 64 && at !== undefined && at.pid > 1; depth++) {
      if (qualifies.has(at.pid)) return true;
      at = byPid.get(at.ppid);
    }
    return false;
  };

  const found: OutsideFound[] = [];
  for (const pid of qualifies) {
    const root = byPid.get(pid);
    // Quick commands (an agent's grep, a git status) come and go between scans; they are not worth listing.
    if (root === undefined || root.elapsedSeconds < MIN_AGE_SECONDS || hasQualifyingAncestor(root)) continue;
    const pids = subtree(pid).filter((entry) => !own.has(entry));
    const members = pids.map((entry) => byPid.get(entry)).filter((entry) => entry !== undefined);
    const owner = ownerAbove(root.ppid);
    const ports = [...new Set(sockets.filter((sock) => pids.includes(sock.pid)).map((sock) => sock.port))];
    found.push({
      pid,
      pids,
      name: nameOf(root),
      command: redactText(root.args).slice(0, 2000),
      startedBy: owner?.name ?? null,
      startedByPid: owner?.pid ?? null,
      orphaned: owner === null,
      tty: root.tty,
      ports: ports.sort((a, b) => a - b),
      cpuPercent: Math.round(members.reduce((sum, entry) => sum + entry.cpuPercent, 0) * 10) / 10,
      memoryBytes: members.reduce((sum, entry) => sum + entry.rssBytes, 0),
      startedAtMs: Math.floor((options.nowMs - root.elapsedSeconds * 1000) / 1000) * 1000
    });
  }
  // Orphaned first: nothing else will ever stop those. Then newest first.
  return found.sort((a, b) => Number(b.orphaned) - Number(a.orphaned) || b.startedAtMs - a.startedAtMs);
}

const execFileAsync = promisify(execFile);

async function psProcesses(): Promise<ProcRow[]> {
  const options = { timeout: 5000, maxBuffer: 32 * 1024 * 1024 };
  const [table, comms] = await Promise.all([
    execFileAsync('ps', ['-A', '-ww', '-o', 'pid=,ppid=,uid=,etime=,tty=,pcpu=,rss=,args='], options),
    execFileAsync('ps', ['-A', '-ww', '-o', 'pid=,comm='], options)
  ]);
  return parseProcessTable(table.stdout, comms.stdout);
}

/** Pids from `launchctl list`, whose first column is the pid or "-". */
export function parseLaunchctlList(stdout: string): Set<number> {
  const out = new Set<number>();
  for (const line of stdout.split('\n')) {
    const match = /^(\d+)\s/.exec(line);
    if (match !== null) out.add(Number(match[1]));
  }
  return out;
}

async function launchdJobs(): Promise<ReadonlySet<number> | null> {
  if (process.platform !== 'darwin') return null;
  try {
    const { stdout } = await execFileAsync('launchctl', ['list'], { timeout: 3000, maxBuffer: 4 * 1024 * 1024 });
    return parseLaunchctlList(stdout);
  } catch {
    return null;
  }
}

function isSystemdService(pid: number): boolean {
  if (process.platform !== 'linux') return false;
  try {
    const cgroup = fs.readFileSync(`/proc/${pid}/cgroup`, 'utf8').trim().split('\n').pop() ?? '';
    return cgroup.endsWith('.service');
  } catch {
    return false;
  }
}

/** Parse `lsof -a -d cwd -Fn -p ...`. Exported for tests. */
export function parseLsofCwds(stdout: string): Map<number, string> {
  const out = new Map<number, string>();
  let pid = 0;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && pid > 0) out.set(pid, line.slice(1));
  }
  return out;
}

async function cwds(pids: number[]): Promise<Map<number, string>> {
  if (pids.length === 0) return new Map();
  if (process.platform === 'linux') {
    const out = new Map<number, string>();
    for (const pid of pids) {
      try {
        out.set(pid, fs.readlinkSync(`/proc/${pid}/cwd`));
      } catch {
        // Gone, or not ours to read.
      }
    }
    return out;
  }
  try {
    const { stdout } = await execFileAsync('lsof', ['-a', '-d', 'cwd', '-Fn', '-p', pids.join(',')], {
      timeout: 3000,
      maxBuffer: 4 * 1024 * 1024
    });
    return parseLsofCwds(stdout);
  } catch (error) {
    // lsof exits 1 when one of the pids is gone, after printing the rest.
    const stdout = (error as { stdout?: unknown }).stdout;
    return typeof stdout === 'string' ? parseLsofCwds(stdout) : new Map();
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function signal(pids: number[], name: NodeJS.Signals): void {
  for (const pid of pids) {
    try {
      process.kill(pid, name);
    } catch {
      // Exited in between, or not ours.
    }
  }
}

export interface OutsideScannerOptions {
  /** Processes whose subtrees are agenterm's own. Defaults to this process (the daemon). */
  ownPids?: number[] | undefined;
  probes?: Partial<OutsideProbes> | undefined;
  gitReader: (cwd: string) => Promise<GitInfo>;
  /** How long a stop waits after SIGTERM before SIGKILL. Defaults to 3000 ms. */
  graceMs?: number | undefined;
}

export type StopOutsideResult =
  | { ok: true; process: OutsideProcess; exited: boolean }
  | { ok: false; status: number; code: string; message: string; hint?: string };

/**
 * Lists and stops commands running outside agenterm. Scans only when
 * asked, and callers within a second share one scan.
 */
export class OutsideScanner {
  private readonly probes: OutsideProbes;
  private readonly ownPids: number[];
  private readonly gitReader: (cwd: string) => Promise<GitInfo>;
  private readonly graceMs: number;
  private readonly roots = new Map<string, { root: string | null; atMs: number }>();
  private last: { atMs: number; value: Promise<ListProcessesResponse> } | null = null;

  constructor(options: OutsideScannerOptions) {
    this.probes = {
      processes: psProcesses,
      sockets: listeningSockets,
      launchdJobs,
      isService: isSystemdService,
      cwds,
      ...options.probes
    };
    this.ownPids = options.ownPids ?? [process.pid];
    this.gitReader = options.gitReader;
    this.graceMs = options.graceMs ?? 3000;
  }

  /** Project for a folder, from git when it is a repository. Cached for a minute per folder. */
  private async project(cwd: string, nowMs: number): Promise<string | null> {
    let cached = this.roots.get(cwd);
    if (cached === undefined || nowMs - cached.atMs > 60_000) {
      cached = { root: (await this.gitReader(cwd)).worktreeRoot, atMs: nowMs };
      this.roots.set(cwd, cached);
      if (this.roots.size > 500) this.roots.delete(this.roots.keys().next().value ?? '');
    }
    return projectOf(cwd, cached.root);
  }

  private async scan(): Promise<ListProcessesResponse> {
    const uid = process.getuid?.();
    const nowMs = Date.now();
    if (uid === undefined) return { processes: [], scannedAtMs: nowMs };
    const [procs, sockets, jobs] = await Promise.all([
      this.probes.processes(),
      this.probes.sockets().catch(() => []),
      this.probes.launchdJobs()
    ]);
    const found = findOutside(
      procs,
      sockets,
      { launchdJobs: jobs, isService: this.probes.isService },
      { uid, ownPids: this.ownPids, nowMs }
    );
    const folders = await this.probes.cwds(found.map((entry) => entry.pid));
    const processes = await Promise.all(
      found.map(async (entry): Promise<OutsideProcess> => {
        const cwd = folders.get(entry.pid) ?? null;
        return { ...entry, cwd, project: cwd === null ? null : await this.project(cwd, nowMs) };
      })
    );
    return { processes, scannedAtMs: nowMs };
  }

  /** Every command running outside agenterm. Never throws for a failed probe; it is reported to the caller. */
  list(): Promise<ListProcessesResponse> {
    const nowMs = Date.now();
    if (this.last !== null && nowMs - this.last.atMs < 1000) return this.last.value;
    const value = this.scan();
    this.last = { atMs: nowMs, value };
    value.catch(() => {
      if (this.last?.value === value) this.last = null;
    });
    return value;
  }

  /**
   * End one listed command and everything under it: SIGTERM, then SIGKILL
   * for whatever is left after the grace period. Force sends SIGKILL right
   * away. Only a pid that is listed right now can be stopped, so a pid
   * from an old listing never reaches some unrelated process.
   */
  async stop(pid: number, options: { force?: boolean; startedAtMs?: number } = {}): Promise<StopOutsideResult> {
    this.last = null;
    const { processes } = await this.list();
    const entry = processes.find((candidate) => candidate.pid === pid);
    if (entry === undefined) {
      return {
        ok: false,
        status: 404,
        code: 'unknown_process',
        message: `pid ${pid} is not a command running outside agenterm`,
        hint: 'Run `agenterm ps` to see them. Tasks agenterm started are stopped with `agenterm stop`.'
      };
    }
    // ps reports start times to the second, and two scans can round differently.
    if (options.startedAtMs !== undefined && Math.abs(entry.startedAtMs - options.startedAtMs) > 3000) {
      return {
        ok: false,
        status: 409,
        code: 'process_changed',
        message: `pid ${pid} now belongs to a different process than the one listed`,
        hint: 'List them again and pick it from there.'
      };
    }
    const targets = entry.pids.filter(alive);
    if (options.force === true) {
      signal(targets, 'SIGKILL');
    } else {
      signal(targets, 'SIGTERM');
      for (let waited = 0; waited < this.graceMs && targets.some(alive); waited += 100) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      signal(targets.filter(alive), 'SIGKILL');
    }
    for (let waited = 0; waited < 1000 && targets.some(alive); waited += 50) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    this.last = null;
    return { ok: true, process: entry, exited: !targets.some(alive) };
  }
}
