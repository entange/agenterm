import os from 'node:os';
import path from 'node:path';

/** Project name: git repository name, else the folder name. Null for home and root. */
export function projectOf(cwd: string, gitRoot: string | null): string | null {
  const folder = gitRoot ?? cwd;
  if (folder === path.parse(folder).root || path.resolve(folder) === path.resolve(os.homedir())) return null;
  return path.basename(folder) || null;
}
