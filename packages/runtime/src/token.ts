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
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length >= 16) {
      return existing;
    }
  } catch {
    // Missing file falls through to creation.
  }
  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Best effort on platforms without POSIX modes.
  }
  return token;
}

/** Short hash of the token for lock-file display without exposing secrets. */
export function tokenHash(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex').slice(0, 16);
}
