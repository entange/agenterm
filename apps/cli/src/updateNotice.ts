import fs from 'node:fs';
import path from 'node:path';

const DAY_MS = 24 * 60 * 60 * 1000;
const LATEST_URL = 'https://registry.npmjs.org/agenterm/latest';

/** Negative when a is an older x.y.z than b. */
function compare(a: string, b: string): number {
  const left = a.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const right = b.split('.').map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Whether this run should look for a newer CLI: only for a person at a
 * terminal, never for agents (mcp, --json), CI, or the app's own copy,
 * which the app updates.
 */
export function wantsUpdateCheck(argv: string[], env: NodeJS.ProcessEnv, stderrIsTTY: boolean): boolean {
  if (!stderrIsTTY || env['CI'] !== undefined || env['AGENTERM_NO_UPDATE_CHECK'] === '1') return false;
  if (process.versions.electron !== undefined) return false;
  return !argv.includes('mcp') && !argv.includes('--json');
}

/**
 * At most once a day, ask npm for the newest agenterm and return a line
 * saying how to update when it is newer than `current`. Gives up quietly
 * and quickly when offline.
 */
export async function updateNotice(
  current: string,
  dir: string,
  options: { now?: number; fetchImpl?: typeof fetch } = {}
): Promise<string | null> {
  const now = options.now ?? Date.now();
  const file = path.join(dir, 'update-check.json');
  try {
    const last = JSON.parse(fs.readFileSync(file, 'utf8')) as { checkedAtMs?: number };
    if (typeof last.checkedAtMs === 'number' && now - last.checkedAtMs < DAY_MS) return null;
  } catch {
    // Never checked.
  }
  let latest: string | null = null;
  try {
    const response = await (options.fetchImpl ?? fetch)(LATEST_URL, { signal: AbortSignal.timeout(1500) });
    if (response.ok) latest = ((await response.json()) as { version?: string }).version ?? null;
  } catch {
    return null;
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ checkedAtMs: now, latest }));
  } catch {
    // A read-only home only means checking again next time.
  }
  if (latest === null || compare(latest, current) <= 0) return null;
  return `agenterm ${latest} is out (you have ${current}). Update with: npm install -g agenterm`;
}
