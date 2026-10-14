import { execFileSync } from 'node:child_process';
import path from 'node:path';

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

/** Shells and launchers between a program and the command it ran. */
const PASS_THROUGH = new Set([
  'sh',
  'bash',
  'zsh',
  'fish',
  'dash',
  'ksh',
  'tcsh',
  'csh',
  'nu',
  'pwsh',
  'login',
  'sudo',
  'env',
  'su',
  'script',
  'timeout',
  'nohup',
  'xargs',
  'npm',
  'npx',
  'npm-cli',
  'npx-cli',
  'pnpm',
  'pnpx',
  'yarn',
  'bunx',
  'uv',
  'uvx',
  'pipx',
  'corepack',
  'tsx',
  'ts-node',
  'agenterm'
]);

/** Runtimes whose script, not the runtime, is the program. */
const INTERPRETERS = new Set(['node', 'bun', 'deno', 'python', 'python3', 'ruby', 'perl']);

/** Script names too generic to mean anything on their own. */
const GENERIC_SCRIPTS = new Set(['index', 'cli', 'main', 'bin', 'run', 'entry', 'start']);

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

/** Name a script path: its file name, or its package when the file name is generic. */
export function scriptName(file: string): string | null {
  const base = path.basename(file).replace(/\.(c|m)?(js|ts)$|\.py$|\.rb$/, '');
  if (base.length === 0 || base.startsWith('-')) return null;
  if (!GENERIC_SCRIPTS.has(base)) return base;
  const pkg = /node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(file);
  if (pkg?.[1] !== undefined) return pkg[1].split('/').pop() ?? null;
  return null;
}

/** Display name for one process, before pass-through rules apply. */
export function processName(info: ProcInfo): string {
  // A macOS app: the outermost bundle names it ("Visual Studio Code", not "Code Helper (Plugin)").
  const app = /\/([^/]+)\.app\//.exec(info.comm);
  // Programs that retitle themselves (npm shows "npm exec agenterm …") are named by the first word.
  const retitled = app === null && !info.comm.startsWith('/') && /\s/.test(info.comm);
  let name = app?.[1] ?? (retitled ? (info.comm.split(/\s+/)[0] ?? info.comm) : path.basename(info.comm));
  name = name.replace(/^-/, '').replace(/ Helper( \(.*\))?$/, '');
  if (INTERPRETERS.has(name)) {
    // args: "node /path/to/claude --flag". Skip runtime flags to find the script.
    const parts = info.args.split(/\s+/).slice(1);
    const script = parts.find((part) => !part.startsWith('-'));
    const named = script === undefined ? null : scriptName(script);
    if (named !== null) return named;
  }
  return name;
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
