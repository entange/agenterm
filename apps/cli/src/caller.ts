import { execFileSync } from 'node:child_process';
import { PASS_THROUGH, processName } from '@agenterm/core';

/** The program that ran `agenterm`: an agent, an editor, or a terminal app. */
export interface Caller {
  name: string;
  pid: number;
}

/** One process as `ps` reports it. */
export interface ProcInfo {
  ppid: number;
  /** Executable path or name. */
  comm: string;
  /** Full command line. */
  args: string;
}

export type ProcReader = (pid: number) => ProcInfo | null;

/** Reaching one of these means nothing interesting started us. */
const ROOTS = new Set(['launchd', 'systemd', 'init', 'kernel_task']);

function readWithPs(pid: number): ProcInfo | null {
  try {
    const head = execFileSync('ps', ['-o', 'ppid=', '-o', 'comm=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 2000
    }).trim();
    const match = /^(\d+)\s+(.*)$/.exec(head);
    if (match === null) return null;
    const args = execFileSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 }).trim();
    return { ppid: Number(match[1]), comm: (match[2] ?? '').trim(), args };
  } catch {
    return null;
  }
}

/**
 * Walk up from our parent to the first process that is not a shell or a
 * launcher. For an agent running `bash -c "agenterm run …"` that is the
 * agent itself; for a person it is their terminal app. Returns null on
 * Windows or when nothing but system roots started us.
 */
export function detectCaller(startPid = process.ppid, read: ProcReader = readWithPs): Caller | null {
  if (process.platform === 'win32') return null;
  let pid = startPid;
  for (let depth = 0; depth < 16 && pid > 1; depth++) {
    const info = read(pid);
    if (info === null) return null;
    const name = processName(info);
    if (ROOTS.has(name)) return null;
    if (!PASS_THROUGH.has(name.toLowerCase())) return { name, pid };
    pid = info.ppid;
  }
  return null;
}
