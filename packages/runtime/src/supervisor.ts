import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import si from 'systeminformation';
import treeKill from 'tree-kill';

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

const execFileAsync = promisify(execFile);

/** Parse `ps -o pid=,ppid=,pcpu=,rss=,args=`. RSS is in KiB. Exported for tests. */
export function parsePsProcesses(stdout: string): ProcEntry[] {
  const out: ProcEntry[] = [];
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match === null) continue;
    out.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      cpuPercent: Number(match[3]),
      rssBytes: Number(match[4]) * 1024,
      command: (match[5] ?? '').trim()
    });
  }
  return out;
}

/**
 * Process table with full argv. One `ps` call on POSIX is far cheaper than
 * systeminformation's scan and reports real command lines instead of
 * display names; Windows falls back to systeminformation.
 */
async function defaultProcesses(): Promise<ProcEntry[]> {
  if (process.platform !== 'win32') {
    try {
      const { stdout } = await execFileAsync('ps', ['-axww', '-o', 'pid=,ppid=,pcpu=,rss=,args='], {
        timeout: 5000,
        maxBuffer: 32 * 1024 * 1024
      });
      return parsePsProcesses(stdout);
    } catch {
      // Fall through to the portable scan.
    }
  }
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

/** Parse `lsof -nP -iTCP -sTCP:LISTEN -Fpn` field output. Exported for tests. */
export function parseLsofListeners(stdout: string): SockEntry[] {
  const out: SockEntry[] = [];
  const seen = new Set<string>();
  let pid = 0;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('p')) {
      pid = Number(line.slice(1));
      continue;
    }
    if (!line.startsWith('n') || pid <= 0) continue;
    const name = line.slice(1);
    const cut = name.lastIndexOf(':');
    const port = Number(name.slice(cut + 1));
    if (cut === -1 || !Number.isInteger(port) || port < 1 || port > 65535) continue;
    const rawAddress = name.slice(0, cut).replace(/^\[|\]$/g, '');
    const address = rawAddress === '*' ? '0.0.0.0' : rawAddress;
    const key = `${pid}:${port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ port, pid, address });
  }
  return out;
}

/**
 * Listening TCP sockets. POSIX asks lsof for listeners only, which is a
 * fraction of the cost of a full connection scan.
 */
export async function listeningSockets(): Promise<SockEntry[]> {
  if (process.platform !== 'win32') {
    try {
      const { stdout } = await execFileAsync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn'], {
        timeout: 5000,
        maxBuffer: 16 * 1024 * 1024
      });
      return parseLsofListeners(stdout);
    } catch (error) {
      const failure = error as { stdout?: string; code?: unknown; killed?: boolean };
      // lsof exits 1 when nothing is listening. A timeout leaves partial output that would
      // read as ports closing, so it fails the probe and the previous snapshot stands.
      if (failure.killed === true) throw error;
      if (failure.code === 1 && typeof failure.stdout === 'string') return parseLsofListeners(failure.stdout);
    }
  }
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

/**
 * Skinny supervisor.
 *
 * Polls on an interval scoped to tracked task subtrees. Builds the
 * pid to child pid mapping, joins listening sockets back to owning pids,
 * and reports when a task's listening ports change. Kill-tree uses the polled PID
 * list first with the portable killer as backup, and only ever touches
 * pids inside the tracked leader subtree.
 */
export class Supervisor {
  private readonly probes: SupervisorProbes;
  private readonly intervalMs: number;
  private readonly leaders = new Map<string, number>();
  private children = new Map<number, number[]>();
  private lastPorts = new Map<string, number[]>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly onPorts: ((taskId: string, ports: number[]) => void) | undefined;

  constructor(
    options: {
      probes?: SupervisorProbes | undefined;
      intervalMs?: number | undefined;
      onPorts?: ((taskId: string, ports: number[]) => void) | undefined;
    } = {}
  ) {
    this.probes = options.probes ?? { processes: defaultProcesses, sockets: listeningSockets };
    this.intervalMs = options.intervalMs ?? 1000;
    this.onPorts = options.onPorts;
  }

  track(taskId: string, leaderPid: number): void {
    this.leaders.set(taskId, leaderPid);
  }

  untrack(taskId: string): void {
    this.leaders.delete(taskId);
    this.lastPorts.delete(taskId);
  }

  /** Direct children of a pid from the most recent poll. */
  childrenOf(pid: number): number[] {
    return [...(this.children.get(pid) ?? [])];
  }

  /** Leader plus all descendants from the most recent poll. */
  subtreePids(leaderPid: number): number[] {
    const seen = new Set<number>([leaderPid]);
    const queue: number[] = [leaderPid];
    for (let i = 0; i < queue.length; i++) {
      for (const child of this.children.get(queue[i] ?? 0) ?? []) {
        if (seen.has(child)) continue;
        seen.add(child);
        queue.push(child);
      }
    }
    return queue;
  }

  private inFlight: Promise<void> | null = null;

  /** Run one poll cycle. Concurrent callers share the cycle in flight; never throws. */
  poll(): Promise<void> {
    if (this.inFlight !== null) return this.inFlight;
    this.inFlight = this.pollOnce().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async pollOnce(): Promise<void> {
    let procs: ProcEntry[] = [];
    let socks: SockEntry[] = [];
    // Skip the system scan entirely while nothing is tracked.
    if (this.leaders.size === 0) {
      this.children = new Map();
      return;
    }
    try {
      [procs, socks] = await Promise.all([this.probes.processes(), this.probes.sockets()]);
    } catch {
      // A failed probe keeps the previous snapshot; an empty one would fake closed ports.
      return;
    }
    const kids = new Map<number, number[]>();
    for (const entry of procs) {
      const list = kids.get(entry.ppid) ?? [];
      list.push(entry.pid);
      kids.set(entry.ppid, list);
    }
    this.children = kids;
    for (const [taskId, leader] of this.leaders) {
      const owned = new Set(this.subtreePids(leader));
      const ports = [...new Set(socks.filter((sock) => owned.has(sock.pid)).map((sock) => sock.port))].sort(
        (a, b) => a - b
      );
      const before = this.lastPorts.get(taskId) ?? [];
      this.lastPorts.set(taskId, ports);
      if (this.onPorts !== undefined && ports.join(',') !== before.join(',')) this.onPorts(taskId, ports);
    }
  }

  /** Listening ports owned by the task from the most recent poll. */
  portsFor(taskId: string): number[] {
    return [...(this.lastPorts.get(taskId) ?? [])];
  }

  /**
   * End a task's process tree.
   *
   * Signals the leader plus polled descendants with SIGTERM, then SIGKILL
   * for survivors after a grace wait. With force, SIGKILL right away. Returns the pids that were signaled.
   * Only pids inside the leader subtree are ever touched.
   */
  async killTree(leaderPid: number, options: { force?: boolean } = {}): Promise<number[]> {
    await this.poll();
    const targets = this.subtreePids(leaderPid).filter((pid) => pidAlive(pid));
    if (targets.length === 0) return [];
    if (options.force === true) {
      for (const pid of targets) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // Exited in between.
        }
      }
      return targets;
    }
    await treeKillAsync(leaderPid, 'SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const survivors = targets.filter((pid) => pidAlive(pid));
    if (survivors.length > 0) {
      // Signal survivors by pid: children of a dead leader are reparented and
      // a tree walk from the leader would no longer find them.
      for (const pid of survivors) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // Exited in between.
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return targets;
  }

  /**
   * Poll on a self-scheduling loop: one cycle never overlaps the next, and
   * the pause grows with the number of tracked trees so hundreds of tasks
   * do not keep ps and lsof busy.
   */
  start(): void {
    if (this.timer !== null) return;
    const loop = (): void => {
      const pause =
        this.leaders.size > 200 ? this.intervalMs * 3 : this.leaders.size > 50 ? this.intervalMs * 2 : this.intervalMs;
      this.timer = setTimeout(() => {
        void this.poll().finally(() => {
          if (this.timer !== null) loop();
        });
      }, pause);
    };
    loop();
  }

  stop(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
