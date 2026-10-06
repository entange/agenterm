import fs from 'node:fs';
import path from 'node:path';
import type { AgentProvider } from '@agenterm/core';

/** Default binary per provider. Generic entries supply their own command. */
export const PROVIDER_BINARIES: Record<AgentProvider, string | null> = {
  claude: 'claude',
  codex: 'codex',
  gemini: 'gemini',
  opencode: 'opencode',
  generic: null
};

/** Install hint per provider shown with missing-binary errors. */
export const PROVIDER_INSTALL_HINTS: Record<AgentProvider, string> = {
  claude: 'Install the Claude CLI and ensure the claude binary is on the login PATH.',
  codex: 'Install the Codex CLI and ensure the codex binary is on the login PATH.',
  gemini: 'Install the Gemini CLI and ensure the gemini binary is on the login PATH.',
  opencode: 'Install opencode and ensure the opencode binary is on the login PATH.',
  generic: 'Provide an explicit command or add its binary to the login PATH.'
};

/** Windows resolves bare names through PATHEXT; POSIX needs no suffix. */
function executableSuffixes(): string[] {
  if (process.platform !== 'win32') return [''];
  const fromEnv = (process.env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((ext) => ext.length > 0);
  return ['', ...fromEnv.map((ext) => ext.toLowerCase())];
}

function isExecutable(file: string): boolean {
  try {
    if (!fs.statSync(file).isFile()) return false;
    if (process.platform === 'win32') return true;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a binary name against PATH without spawning a shell.
 *
 * Absolute commands must point at an executable file. Bare names are
 * searched across PATH entries in order. Returns the resolved absolute
 * path or null when absent. Logs the resolved path per session so
 * missing-binary errors stay actionable.
 */
export function resolveBinary(command: string, envPath?: string, cwd?: string): string | null {
  const suffixes = executableSuffixes();
  if (command.includes('/') || command.includes('\\')) {
    // Relative paths like ./run.sh resolve against the session cwd, not the daemon's.
    const base = path.isAbsolute(command) ? command : path.resolve(cwd ?? process.cwd(), command);
    for (const suffix of suffixes) {
      if (isExecutable(base + suffix)) return base + suffix;
    }
    return null;
  }
  const search = (envPath ?? process.env['PATH'] ?? '').split(path.delimiter);
  for (const dir of search) {
    if (dir.length === 0) continue;
    for (const suffix of suffixes) {
      const candidate = path.join(dir, command + suffix);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

/** Pick the effective command for a spawn request. */
export function effectiveCommand(provider: AgentProvider, override?: string): string | null {
  if (typeof override === 'string' && override.trim().length > 0) {
    return override.trim();
  }
  return PROVIDER_BINARIES[provider];
}
