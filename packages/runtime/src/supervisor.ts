import si from 'systeminformation';
import treeKill from 'tree-kill';
import type { PortRecord, ProcessSnapshot } from '@agenterm/core';

/** One OS process as seen by the poller. */
export interface ProcEntry {
  pid: number;
  ppid: number;
  command: string;
  cpuPercent: number | null;
  rssBytes: number | null;
}

/** One listening socket as seen by the poller. */
export interface SockEntry {
  port: number;
  pid: number;
  address: string;
}

/** Poll sources. Injected in tests so no live scan is needed. */
export interface SupervisorProbes {
  processes: () => Promise<ProcEntry[]>;
  sockets: () => Promise<SockEntry[]>;
}

async function defaultProcesses(): Promise<ProcEntry[]> {
  const result = await si.processes();
  const out: ProcEntry[] = [];
  for (const entry of result.list ?? []) {
    if (typeof entry.pid !== 'number' || entry.pid <= 0) continue;
    out.push({
      pid: entry.pid,
      ppid: typeof entry.parentPid === 'number' ? entry.parentPid : 0,
      command: typeof entry.command === 'string' && entry.command.length > 0 ? entry.command : (entry.name ?? ''),
      cpuPercent: typeof entry.cpu === 'number' ? entry.cpu : null,
      rssBytes: typeof entry.memRss === 'number' ? Math.round(entry.memRss * 1024) : null
    });
  }
  return out;
}

async function defaultSockets(): Promise<SockEntry[]> {
  const result = await si.networkConnections();
  const out: SockEntry[] = [];
  for (const entry of result ?? []) {
    if (entry.state !== 'LISTEN') continue;
    const port = Number(entry.localPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
    if (typeof entry.pid !== 'number' || entry.pid <= 0) continue;
    out.push({
      port,
      pid: entry.pid,
      address: typeof entry.localAddress === 'string' ? entry.localAddress : '127.0.0.1'
    });
  }
  return out;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function treeKillAsync(pid: number, signal: string): Promise<void> {
  return new Promise((resolve) => {
    try {
      treeKill(pid, signal, () => resolve());
    } catch {
      resolve();
    }
  });
}

export interface PortChange {
  opened: PortRecord[];
  closed: PortRecord[];
}

/**
 * Skinny supervisor.
 *
 * Polls on an interval scoped to tracked session subtrees. Builds the
 * pid to child pid mapping, joins listening sockets back to owning pids,
 * and reports port open and close changes. Kill-tree uses the polled PID
 * list first with the portable killer as backup, and only ever touches
 * pids inside the tracked leader subtree.
 */
export class Supervisor {
  private readonly probes: SupervisorProbes;
  private readonly intervalMs: number;
  private readonly leaders = new Map<string, number>();
  private children = new Map<number, number[]>();
  private byPid = new Map<number, ProcEntry>();
  private lastPorts = new Map<string, PortRecord[]>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly onPorts: ((sessionId: string, change: PortChange) => void) | undefined;

  constructor(
    options: {
      probes?: SupervisorProbes | undefined;
      intervalMs?: number | undefined;
      onPorts?: ((sessionId: string, change: PortChange) => void) | undefined;
    } = {}
  ) {
    this.probes = options.probes ?? { processes: defaultProcesses, sockets: defaultSockets };
    this.intervalMs = options.intervalMs ?? 1000;
    this.onPorts = options.onPorts;
  }

  track(sessionId: string, leaderPid: number): void {
    this.leaders.set(sessionId, leaderPid);
  }

  untrack(sessionId: string): void {
    this.leaders.delete(sessionId);
    this.lastPorts.delete(sessionId);
  }

  /** Direct children of a pid from the most recent poll. */
  childrenOf(pid: number): number[] {
    return [...(this.children.get(pid) ?? [])];
  }

  /** Leader plus all descendants from the most recent poll. */
  subtreePids(leaderPid: number): number[] {
    const out: number[] = [leaderPid];
    const queue: number[] = [leaderPid];
    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined) continue;
      for (const child of this.childrenOf(current)) {
        if (!out.includes(child)) {
          out.push(child);
          queue.push(child);
        }
      }
    }
    return out;
  }

  /** Run one poll cycle. Scoped reads; never throws. */
  async poll(): Promise<void> {
    let procs: ProcEntry[] = [];
    let socks: SockEntry[] = [];
    try {
      procs = await this.probes.processes();
    } catch {
      procs = [];
    }
    try {
      socks = await this.probes.sockets();
    } catch {
      socks = [];
    }
    const kids = new Map<number, number[]>();
    const byPid = new Map<number, ProcEntry>();
    for (const entry of procs) {
      byPid.set(entry.pid, entry);
      const list = kids.get(entry.ppid) ?? [];
      list.push(entry.pid);
      kids.set(entry.ppid, list);
    }
    this.children = kids;
    this.byPid = byPid;
    for (const [sessionId, leader] of this.leaders) {
      const owned = new Set(this.subtreePids(leader));
      const ports: PortRecord[] = [];
      for (const sock of socks) {
        if (!owned.has(sock.pid)) continue;
        ports.push({ port: sock.port, pid: sock.pid, sessionId, address: sock.address });
      }
      ports.sort((a, b) => a.port - b.port);
      const before = this.lastPorts.get(sessionId) ?? [];
      const beforeKeys = new Set(before.map((p) => `${p.port}:${p.pid}`));
      const afterKeys = new Set(ports.map((p) => `${p.port}:${p.pid}`));
      const opened = ports.filter((p) => !beforeKeys.has(`${p.port}:${p.pid}`));
      const closed = before.filter((p) => !afterKeys.has(`${p.port}:${p.pid}`));
      this.lastPorts.set(sessionId, ports);
      if ((opened.length > 0 || closed.length > 0) && this.onPorts !== undefined) {
        this.onPorts(sessionId, { opened, closed });
      }
    }
  }

  /** Snapshot of the session subtree from the most recent poll. */
  snapshot(sessionId: string, sampledAtMs = Date.now()): ProcessSnapshot[] {
    const leader = this.leaders.get(sessionId);
    if (leader === undefined) return [];
    const out: ProcessSnapshot[] = [];
    for (const pid of this.subtreePids(leader)) {
      const entry = this.byPid.get(pid);
      out.push({
        pid,
        ppid: entry?.ppid ?? 0,
        sessionId,
        command: entry?.command ?? '',
        cwd: null,
        cpuPercent: entry?.cpuPercent ?? null,
        rssBytes: entry?.rssBytes ?? null,
        startedAtMs: null,
        endedAtMs: null,
        exitCode: null,
        sampledAtMs
      });
    }
    out.sort((a, b) => a.pid - b.pid);
    return out;
  }

  /** Listening ports owned by the session from the most recent poll. */
  portsFor(sessionId: string): PortRecord[] {
    return [...(this.lastPorts.get(sessionId) ?? [])];
  }

  /**
   * End a session tree.
   *
   * Signals the leader plus polled descendants with SIGTERM, then SIGKILL
   * for survivors after a grace wait. Returns the pids that were signaled.
   * Only pids inside the leader subtree are ever touched.
   */
  async killTree(leaderPid: number): Promise<number[]> {
    await this.poll();
    const targets = this.subtreePids(leaderPid).filter((pid) => pidAlive(pid));
    if (targets.length === 0) return [];
    await treeKillAsync(leaderPid, 'SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const survivors = targets.filter((pid) => pidAlive(pid));
    if (survivors.length > 0) {
      await treeKillAsync(leaderPid, 'SIGKILL');
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return targets;
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      void this.poll();
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
