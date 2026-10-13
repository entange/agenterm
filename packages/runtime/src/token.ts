import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { tokenPath } from './paths.js';

/**
 * Load the bearer token, creating it on first start.
 *
 * Stored at the token path with 0600. Only the daemon, Electron main, and
 * the CLI read it from disk as the same user. Never forwarded to web
 * content.
 */
export function loadOrCreateToken(dir?: string): string {
  const file = tokenPath(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Two first-time starters (the app and the CLI) can race here. Creation is exclusive,
  // and the loser reads the winner's token once it is written.
  for (let attempt = 0; attempt < 20; attempt++) {
    const existing = readToken(file);
    if (existing !== null) return existing;
    const token = crypto.randomBytes(32).toString('hex');
    try {
      const stat = fs.statSync(file, { throwIfNoEntry: false });
      if (stat !== undefined && Date.now() - stat.mtimeMs < 2000) {
        // Another starter is writing it right now.
        throw Object.assign(new Error('token being written'), { code: 'EEXIST' });
      }
      if (stat !== undefined) {
        // Present but unusable: replace it atomically.
        const temp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(temp, `${token}\n`, { mode: 0o600 });
        fs.renameSync(temp, file);
      } else {
        fs.writeFileSync(file, `${token}\n`, { mode: 0o600, flag: 'wx' });
      }
      try {
        fs.chmodSync(file, 0o600);
      } catch {
        // Best effort on platforms without POSIX modes.
      }
      return token;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  throw new Error(`could not create or read the token at ${file}`);
}

function readToken(file: string): string | null {
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    return existing.length >= 16 ? existing : null;
  } catch {
    return null;
  }
}

/** Short hash of the token for lock-file display without exposing secrets. */
export function tokenHash(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex').slice(0, 16);
}
