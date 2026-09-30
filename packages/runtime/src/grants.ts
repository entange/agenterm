import fs from 'node:fs';
import path from 'node:path';
import type { HarnessProvider } from '@agenterm/core';

/** Explicit user approval to read harness state for one provider. */
export interface HarnessGrant {
  provider: HarnessProvider;
  /** Absolute root the daemon may list and tail. Never a single live DB. */
  path: string;
  grantedAtMs: number;
}

const KNOWN: readonly string[] = ['claude', 'codex', 'opencode', 'gemini'];

/** Grants file inside the data dir. The only approval record. */
export function grantsFile(dataDir: string): string {
  return path.join(dataDir, 'harness-grants.json');
}

function isGrant(value: unknown): value is HarnessGrant {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['provider'] === 'string' &&
    KNOWN.includes(record['provider']) &&
    typeof record['path'] === 'string' &&
    typeof record['grantedAtMs'] === 'number'
  );
}

/** Load grants. Missing or corrupt files read as empty, never throw. */
export function loadGrants(dataDir: string): HarnessGrant[] {
  try {
    const raw = fs.readFileSync(grantsFile(dataDir), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isGrant);
  } catch {
    return [];
  }
}

function writeGrants(dataDir: string, grants: HarnessGrant[]): void {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(grantsFile(dataDir), JSON.stringify(grants, null, 2), 'utf8');
}

/**
 * Record explicit approval for a provider root.
 *
 * The path must be absolute. Adding a path here is the approval act;
 * the CLI grant command is the only writer in normal use.
 */
export function addGrant(dataDir: string, provider: HarnessProvider, root: string): HarnessGrant {
  if (!path.isAbsolute(root)) {
    throw new Error('grant path must be absolute');
  }
  const grants = loadGrants(dataDir);
  const existing = grants.find((entry) => entry.provider === provider && entry.path === root);
  if (existing !== undefined) return existing;
  const grant: HarnessGrant = { provider, path: root, grantedAtMs: Date.now() };
  grants.push(grant);
  writeGrants(dataDir, grants);
  return grant;
}

/** Remove one approval. Returns true when a grant was removed. */
export function revokeGrant(dataDir: string, provider: HarnessProvider, root: string): boolean {
  const grants = loadGrants(dataDir);
  const kept = grants.filter((entry) => !(entry.provider === provider && entry.path === root));
  if (kept.length === grants.length) return false;
  writeGrants(dataDir, kept);
  return true;
}

/** Granted roots for one provider. */
export function rootsFor(grants: HarnessGrant[], provider: HarnessProvider): string[] {
  return grants.filter((entry) => entry.provider === provider).map((entry) => entry.path);
}
