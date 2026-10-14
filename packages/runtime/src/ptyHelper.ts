import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

/** node-pty's spawn helper for this platform, in either its prebuilt or its compiled location. */
function spawnHelpers(): string[] {
  let root: string;
  try {
    root = path.dirname(createRequire(import.meta.url).resolve('node-pty/package.json'));
  } catch {
    // Bundled into the app, where packaging already set the mode bit.
    return [];
  }
  return [
    path.join(root, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
    path.join(root, 'build', 'Release', 'spawn-helper')
  ].filter((helper) => fs.existsSync(helper));
}

/**
 * Make node-pty's spawn helper executable.
 *
 * node-pty sets the mode bit in an install script, and npm skips dependency
 * install scripts for global installs unless they are allowed. Without the
 * bit every terminal fails with "posix_spawnp failed". Returns the helper
 * that is still not executable (a root-owned install), or null.
 */
export function ensureSpawnHelper(): string | null {
  if (process.platform === 'win32') return null;
  for (const helper of spawnHelpers()) {
    if ((fs.statSync(helper).mode & 0o111) !== 0) continue;
    try {
      fs.chmodSync(helper, 0o755);
    } catch {
      return helper;
    }
  }
  return null;
}
