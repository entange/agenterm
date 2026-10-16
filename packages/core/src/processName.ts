/**
 * Naming processes the way a person would: the agent or app, not the
 * runtime or helper underneath. Shared by the CLI (who is running
 * `agenterm`) and the daemon (who started a process outside agenterm).
 */

/** Shells and launchers between a program and the command it ran. */
export const PASS_THROUGH: ReadonlySet<string> = new Set([
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

/** Interactive shells. A command whose parent is one of these was typed or run by someone. */
export const SHELLS: ReadonlySet<string> = new Set([
  'sh',
  'bash',
  'zsh',
  'fish',
  'dash',
  'ksh',
  'tcsh',
  'csh',
  'nu',
  'pwsh'
]);

/** Coding agents. They run commands for someone, so they are who started them, never a command themselves. */
export const AGENTS: ReadonlySet<string> = new Set([
  'claude',
  'codex',
  'opencode',
  'gemini',
  'cursor-agent',
  'aider',
  'amp',
  'goose',
  'crush',
  'qwen',
  'droid',
  'copilot',
  'kiro-cli',
  'cline',
  'kilo'
]);

/** Runtimes whose script, not the runtime, is the program. */
const INTERPRETERS = new Set(['node', 'bun', 'deno', 'python', 'python3', 'ruby', 'perl']);

/** Script names too generic to mean anything on their own. */
const GENERIC_SCRIPTS = new Set(['index', 'cli', 'main', 'bin', 'run', 'entry', 'start']);

function basename(file: string): string {
  return file.split('/').pop() ?? file;
}

/** Name a script path: its file name, or its package when the file name is generic. */
export function scriptName(file: string): string | null {
  const base = basename(file).replace(/\.(c|m)?(js|ts)$|\.py$|\.rb$/, '');
  if (base.length === 0 || base.startsWith('-')) return null;
  if (!GENERIC_SCRIPTS.has(base)) return base;
  const pkg = /node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(file);
  if (pkg?.[1] !== undefined) return pkg[1].split('/').pop() ?? null;
  return null;
}

/**
 * The program an interpreter runs: "node /path/to/claude --flag" is claude,
 * "python -m http.server" is http.server. Inline code (-e, -c) has no name.
 */
function scriptOf(parts: string[]): string | null {
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] ?? '';
    if (['-e', '-c', '-p', '--eval', '--print'].includes(part)) return null;
    if (part === '-m') return parts[i + 1] ?? null;
    if (!part.startsWith('-')) return scriptName(part);
  }
  return null;
}

/**
 * Display name for one process.
 *
 * comm: executable path or name, as `ps -o comm=` reports it.
 * args: the full command line.
 */
export function processName(info: { comm: string; args: string }): string {
  // A macOS app: the outermost bundle names it ("Visual Studio Code", not "Code Helper (Plugin)").
  const app = /\/([^/]+)\.app\//.exec(info.comm);
  // Programs that retitle themselves (npm shows "npm exec agenterm …") are named by the first word.
  const retitled = app === null && !info.comm.startsWith('/') && /\s/.test(info.comm);
  let name = app?.[1] ?? (retitled ? (info.comm.split(/\s+/)[0] ?? info.comm) : basename(info.comm));
  name = name.replace(/^-/, '').replace(/ Helper( \(.*\))?$/, '');
  if (INTERPRETERS.has(name)) return scriptOf(info.args.split(/\s+/).slice(1)) ?? name;
  return name;
}
