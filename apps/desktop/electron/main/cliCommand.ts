import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { CliStatus } from '../../shared/bridge.js';
import { findOnPath } from './daemonLink.js';

/** Where the app puts the command: on the default PATH of every macOS shell, like VS Code's `code`. */
export const COMMAND_LINK = '/usr/local/bin/agenterm';

/** The agenterm command bundled in this app, or null in development and outside macOS. */
export function bundledCommand(options: { isPackaged: boolean; resourcesPath: string }): string | null {
  if (!options.isPackaged || process.platform !== 'darwin') return null;
  const script = path.join(options.resourcesPath, 'agentermd', 'bin', 'agenterm');
  return fs.existsSync(script) ? script : null;
}

function realpath(file: string): string | null {
  try {
    return fs.realpathSync(file);
  } catch {
    return null;
  }
}

/** True when something is at the link path, even a symlink whose target is gone. */
function linkExists(link: string): boolean {
  try {
    fs.lstatSync(link);
    return true;
  } catch {
    return false;
  }
}

/** A link left by an agenterm.app that moved or was deleted; safe to point at this copy. */
function staleAppLink(link: string): boolean {
  try {
    if (!fs.lstatSync(link).isSymbolicLink()) return false;
    const target = fs.readlinkSync(link);
    return /\.app\/Contents\/Resources\/agentermd\/bin\/agenterm$/.test(target);
  } catch {
    return false;
  }
}

/** Which `agenterm` a terminal runs, judged from the login shell's PATH. */
export function commandStatus(
  bundled: string | null,
  loginPath: string | undefined,
  link: string = COMMAND_LINK
): CliStatus {
  if (bundled === null) return { state: 'unavailable', path: null };
  const ours = realpath(bundled);
  const found = findOnPath('agenterm', loginPath);
  if (found !== null && realpath(found) !== ours) return { state: 'other', path: found };
  if (realpath(link) === ours) return { state: 'installed', path: link };
  return { state: 'missing', path: null };
}

/** Quote for /bin/sh, then for an AppleScript string. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function appleScriptString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Point /usr/local/bin/agenterm at the bundled command. Writes the link
 * directly when it can; otherwise, when `askForPassword` is set, through
 * macOS's administrator prompt. Takes the place of a missing or broken link
 * or one from another agenterm.app; another working symlink (an npm install)
 * only when `replace` is set; a regular file never. Resolves true once the
 * link is in place.
 */
export async function linkCommand(
  bundled: string,
  options: { askForPassword: boolean; replace: boolean; link?: string }
): Promise<boolean> {
  const link = options.link ?? COMMAND_LINK;
  if (realpath(link) === realpath(bundled)) return true;
  if (linkExists(link) && !staleAppLink(link) && realpath(link) !== null) {
    if (!options.replace || !fs.lstatSync(link).isSymbolicLink()) return false;
  }
  try {
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.rmSync(link, { force: true });
    fs.symlinkSync(bundled, link);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if ((code !== 'EACCES' && code !== 'EPERM') || !options.askForPassword) return false;
  }
  const command = `mkdir -p ${shellQuote(path.dirname(link))} && ln -sfn ${shellQuote(bundled)} ${shellQuote(link)}`;
  const script = `do shell script ${appleScriptString(command)} with prompt ${appleScriptString(`agenterm wants to add the agenterm command to ${path.dirname(link)}.`)} with administrator privileges`;
  // osascript fails when the user cancels the prompt; that leaves things as they were.
  await new Promise<void>((resolve) => execFile('osascript', ['-e', script], () => resolve()));
  return realpath(link) === realpath(bundled);
}
