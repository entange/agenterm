import fs from 'node:fs';
import path from 'node:path';

/**
 * Restore the executable bit on node-pty spawn helpers.
 *
 * Some installs drop the mode bit on the helper binary, which makes every
 * PTY spawn fail. This runs at install time, stays silent on success, and
 * never fails the install when the helper layout differs.
 */
function main() {
  try {
    const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'node_modules', '.bun');
    let entries = [];
    try {
      entries = fs.readdirSync(root);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.startsWith('node-pty@')) continue;
      const helper = path.join(
        root,
        entry,
        'node_modules',
        'node-pty',
        'prebuilds',
        'darwin-arm64',
        'spawn-helper'
      );
      try {
        const stat = fs.statSync(helper);
        if ((stat.mode & 0o111) === 0) {
          fs.chmodSync(helper, 0o755);
        }
      } catch {
        // Layout differs; leave the install alone.
      }
    }
  } catch {
    // Never break installs.
  }
}

main();
