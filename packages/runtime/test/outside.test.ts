import { execFileSync, spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  findOutside,
  OutsideScanner,
  parseElapsed,
  parseLaunchctlList,
  parseLsofCwds,
  parseProcessTable,
  type ProcRow
} from '../src/outside.js';

const ME = 501;
const NOW = 1_800_000_000_000;

function proc(pid: number, ppid: number, args: string, extra: Partial<ProcRow> = {}): ProcRow {
  return {
    pid,
    ppid,
    uid: ME,
    elapsedSeconds: 600,
    tty: null,
    cpuPercent: 1,
    rssBytes: 1024,
    comm: args.split(' ')[0] ?? '',
    args,
    ...extra
  };
}

/**
 * A Mac with a terminal, an agent in it, an agenterm daemon, and things
 * left behind. Pids are grouped by who owns them.
 */
const TABLE: ProcRow[] = [
  proc(1, 0, '/sbin/launchd', { uid: 0 }),
  // iTerm2 → login (root) → zsh → npm run dev → sh → vite
  proc(100, 1, '/Applications/iTerm.app/Contents/MacOS/iTerm2'),
  proc(101, 100, 'login -fp me', { uid: 0, comm: 'login' }),
  proc(102, 101, '-zsh', { comm: '-zsh', tty: 'ttys001' }),
  proc(103, 102, 'npm run dev', { comm: 'npm', tty: 'ttys001' }),
  proc(104, 103, 'sh -c vite', { comm: '/bin/sh' }),
  proc(105, 104, 'node /app/node_modules/.bin/vite', { comm: 'node', cpuPercent: 12 }),
  // zsh → claude → zsh -c → pytest --watch; claude's own MCP server and a quick grep
  proc(110, 102, 'claude', { comm: 'claude' }),
  proc(111, 110, '/bin/zsh -c pytest-watch', { comm: '/bin/zsh' }),
  proc(112, 111, 'python3 /venv/bin/pytest-watch', { comm: 'python3' }),
  proc(113, 110, 'node /x/node_modules/.bin/mcp-remote https://example.com/mcp', { comm: 'node' }),
  proc(114, 110, 'rg needle', { comm: 'rg', elapsedSeconds: 0 }),
  // codex's shell exec'd its command in place, so the command is codex's direct child
  proc(120, 102, 'codex', { comm: 'codex' }),
  proc(121, 120, 'cargo watch -x run', { comm: 'cargo' }),
  // agenterm's daemon and a task it runs
  proc(130, 1, 'node /opt/agenterm/daemon.js', { comm: 'node' }),
  proc(131, 130, '/bin/zsh -c next dev', { comm: '/bin/zsh' }),
  proc(132, 131, 'node /app/node_modules/.bin/next dev', { comm: 'node' }),
  // agenterm itself, run from the terminal
  proc(140, 102, 'node /usr/local/bin/agenterm ps', { comm: 'node', elapsedSeconds: 5 }),
  // left behind: a server whose shell is gone, and a shell left behind with its command
  proc(150, 1, 'node server.js --port 4000', { comm: 'node', elapsedSeconds: 7200 }),
  proc(151, 1, '/bin/zsh -c vite', { comm: '/bin/zsh' }),
  proc(152, 151, 'node /old/node_modules/.bin/vite', { comm: 'node' }),
  // adopted by launchd but not left behind: a job, an app, a system agent, tmux
  proc(160, 1, '/usr/bin/ssh-agent -l', { comm: '/usr/bin/ssh-agent' }),
  proc(161, 1, '/Applications/Slack.app/Contents/MacOS/Slack', {
    comm: '/Applications/Slack.app/Contents/MacOS/Slack'
  }),
  proc(162, 1, '/usr/libexec/secd', { comm: '/usr/libexec/secd' }),
  proc(163, 1, '/Users/me/Library/Application Support/Helper/helper', {
    comm: '/Users/me/Library/Application Support/Helper/helper'
  }),
  proc(170, 1, 'tmux new -s work', { comm: 'tmux' }),
  proc(171, 170, '-zsh', { comm: '-zsh', tty: 'ttys009' }),
  proc(172, 171, 'docker compose up', { comm: 'docker' }),
  // someone else's
  proc(180, 102, 'sudo tail -f /var/log/system.log', { uid: 0, comm: 'sudo' })
];

const SOCKETS = [
  { port: 5173, pid: 105, address: '127.0.0.1' },
  { port: 3000, pid: 132, address: '127.0.0.1' },
  { port: 4000, pid: 150, address: '0.0.0.0' }
];

function find(table = TABLE) {
  return findOutside(
    table,
    SOCKETS,
    { launchdJobs: new Set([160]), isService: () => false },
    { uid: ME, ownPids: [130], nowMs: NOW }
  );
}

describe('findOutside', () => {
  it('lists commands run from shells, by agents, and left behind', () => {
    expect(find().map((entry) => entry.pid)).toEqual([152, 150, 103, 112, 121, 172]);
  });

  it('keeps a command and everything under it together, with its ports and usage', () => {
    const dev = find().find((entry) => entry.pid === 103);
    expect(dev).toMatchObject({
      name: 'npm',
      command: 'npm run dev',
      pids: [103, 104, 105],
      ports: [5173],
      startedBy: 'iTerm',
      startedByPid: 100,
      orphaned: false,
      tty: 'ttys001',
      cpuPercent: 14,
      memoryBytes: 3072,
      startedAtMs: NOW - 600_000
    });
  });

  it('names who started it, seeing through shells and launchers', () => {
    const by = Object.fromEntries(find().map((entry) => [entry.pid, entry.startedBy]));
    expect(by).toMatchObject({ 112: 'claude', 121: 'codex', 172: 'tmux' });
  });

  it('marks commands whose starter is gone as orphaned, newest first', () => {
    const [first, second] = find();
    expect(first).toMatchObject({ pid: 152, orphaned: true, startedBy: null });
    expect(second).toMatchObject({ pid: 150, orphaned: true, startedBy: null, ports: [4000] });
  });

  it("leaves out agenterm's own tasks and agenterm itself", () => {
    const pids = find().flatMap((entry) => entry.pids);
    expect(pids).not.toContain(132);
    expect(pids).not.toContain(140);
  });

  it("leaves out agents' tools, quick commands, apps, jobs, and other users' processes", () => {
    const pids = find().map((entry) => entry.pid);
    for (const pid of [113, 114, 160, 161, 162, 163, 170, 180]) expect(pids).not.toContain(pid);
  });

  it('leaves out systemd services on Linux', () => {
    const table = [proc(1, 0, '/sbin/init', { uid: 0 }), proc(2, 1, 'node orphan.js'), proc(3, 1, 'node unit.js')];
    const found = findOutside(
      table,
      [],
      { launchdJobs: null, isService: (pid) => pid === 3 },
      { uid: ME, ownPids: [], nowMs: NOW }
    );
    expect(found.map((entry) => entry.pid)).toEqual([2]);
  });

  it('keeps language runtimes left behind, even when installed in a bundle or /Library', () => {
    const brew =
      '/opt/homebrew/Cellar/python@3.14/3.14.7/Frameworks/Python.framework/Versions/3.14/Resources/Python.app/Contents/MacOS/Python';
    const clt = '/Library/Developer/CommandLineTools/usr/bin/python3';
    const table = [
      proc(1, 0, '/sbin/launchd', { uid: 0 }),
      proc(2, 1, `${brew} -m http.server 8000`, { comm: brew, elapsedSeconds: 60 }),
      proc(3, 1, `${clt} worker.py`, { comm: clt, elapsedSeconds: 30 })
    ];
    const found = findOutside(
      table,
      [],
      { launchdJobs: null, isService: () => false },
      { uid: ME, ownPids: [], nowMs: NOW }
    );
    expect(found.map((entry) => [entry.pid, entry.name])).toEqual([
      [3, 'worker'],
      [2, 'http.server']
    ]);
  });

  it('masks secrets in command lines', () => {
    const table = [proc(1, 0, '/sbin/launchd', { uid: 0 }), proc(2, 1, 'cloudflared tunnel run --token abcdef123456')];
    const [entry] = findOutside(
      table,
      [],
      { launchdJobs: null, isService: () => false },
      { uid: ME, ownPids: [], nowMs: NOW }
    );
    expect(entry?.command).toBe('cloudflared tunnel run --token [REDACTED]');
  });
});

describe('parsers', () => {
  it('reads ps elapsed times', () => {
    expect(parseElapsed('00:05')).toBe(5);
    expect(parseElapsed('12:34')).toBe(754);
    expect(parseElapsed('01:00:00')).toBe(3600);
    expect(parseElapsed('2-03:00:01')).toBe(2 * 86_400 + 3 * 3600 + 1);
    expect(parseElapsed('junk')).toBe(0);
  });

  it('joins the process table with executable names that contain spaces', () => {
    const table = [
      '  100     1   501 01:00 ??       0.0  2048 /Applications/Visual Studio Code.app/Contents/MacOS/Code --x',
      '  101   100   501 00:30 ttys001  1.5  4096 npm run dev',
      '  102   101   501 00:30 pts/3    0.0  1024 node vite'
    ].join('\n');
    const comms = '  100 /Applications/Visual Studio Code.app/Contents/MacOS/Code\n  101 npm\n';
    const rows = parseProcessTable(table, comms);
    expect(rows[0]).toMatchObject({
      pid: 100,
      ppid: 1,
      uid: 501,
      elapsedSeconds: 60,
      tty: null,
      comm: '/Applications/Visual Studio Code.app/Contents/MacOS/Code'
    });
    expect(rows[1]).toMatchObject({ tty: 'ttys001', cpuPercent: 1.5, rssBytes: 4096 * 1024, args: 'npm run dev' });
    // No comm row: the first word of the command line stands in.
    expect(rows[2]).toMatchObject({ tty: 'pts/3', comm: 'node' });
  });

  it('reads launchctl and lsof output', () => {
    expect([...parseLaunchctlList('PID\tStatus\tLabel\n618\t0\tcom.apple.Finder\n-\t0\tcom.apple.idle\n')]).toEqual([
      618
    ]);
    expect(parseLsofCwds('p10\nfcwd\nn/work/app\np11\nfcwd\nn/tmp\n')).toEqual(
      new Map([
        [10, '/work/app'],
        [11, '/tmp']
      ])
    );
  });
});

describe('OutsideScanner', () => {
  const scanner = (rows: ProcRow[]) =>
    new OutsideScanner({
      ownPids: [],
      gitReader: async (cwd) => ({ branch: null, worktreeRoot: cwd === '/work/app/src' ? '/work/app' : null }),
      graceMs: 2000,
      probes: {
        processes: async () => rows,
        sockets: async () => [],
        launchdJobs: async () => null,
        isService: () => false,
        cwds: async (pids) => new Map(pids.map((pid) => [pid, '/work/app/src']))
      }
    });

  it('adds the folder and its project', async () => {
    const uid = process.getuid?.() ?? ME;
    const { processes } = await scanner([
      proc(1, 0, '/sbin/launchd', { uid: 0 }),
      proc(5, 1, 'node a.js', { uid })
    ]).list();
    expect(processes[0]).toMatchObject({ pid: 5, cwd: '/work/app/src', project: 'app' });
  });

  it.skipIf(process.platform === 'win32')('stops a listed command and its children, and nothing else', async () => {
    const child = spawn('sh', ['-c', 'sleep 30 & wait'], { stdio: 'ignore' });
    const exited = new Promise((resolve) => child.once('exit', resolve));
    const uid = process.getuid?.() ?? ME;
    await new Promise((resolve) => setTimeout(resolve, 200));
    const pid = child.pid ?? 0;
    const rows = [proc(1, 0, '/sbin/launchd', { uid: 0 }), proc(pid, 1, 'sh -c sleep 30 & wait', { uid, comm: 'sh' })];
    // sh is a shell, so its sleep is the command; put the real tree in the table.
    const sleeper = Number(
      execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' })
        .trim()
        .split('\n')[0]
    );
    rows.push(proc(sleeper, pid, 'sleep 30', { uid, comm: 'sleep' }));
    const subject = scanner(rows);

    expect(await subject.stop(99_999)).toMatchObject({ ok: false, code: 'unknown_process' });
    expect(await subject.stop(sleeper, { startedAtMs: 1 })).toMatchObject({ ok: false, code: 'process_changed' });
    const result = await subject.stop(sleeper);
    expect(result).toMatchObject({ ok: true, exited: true });
    // The shell that waited on it is not part of the command, but exits once its child is gone.
    await exited;
  });
});
