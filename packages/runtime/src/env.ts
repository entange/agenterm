/**
 * Environment for a task.
 *
 * A command should behave as if it ran in the caller's terminal, so the
 * caller's environment (PATH, HOME, API keys it exported) is the base when
 * the CLI or MCP server sends it; otherwise the daemon's own, which it
 * inherited from a login shell. Daemon and Electron internals are removed
 * so they never leak into child tools. The result is never persisted or
 * logged.
 */

/** Keys that describe the daemon or its Electron host, not the user. */
const INTERNAL_KEYS: readonly string[] = [
  'AGENTERM_PORT',
  'AGENTERM_TASK_ID',
  'AGENTERM_SESSION_ID',
  'ELECTRON_RUN_AS_NODE',
  'ELECTRON_NO_ATTACH_CONSOLE',
  'ELECTRON_ENABLE_LOGGING',
  'NODE_CHANNEL_FD'
];

/** Build the spawn env from a base env plus overrides. */
export function buildSpawnEnv(base: NodeJS.ProcessEnv, overrides: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (typeof value !== 'string') continue;
    if (INTERNAL_KEYS.includes(key)) continue;
    env[key] = value;
  }
  if (env['LANG'] === undefined && env['LC_ALL'] === undefined) {
    env['LANG'] = 'en_US.UTF-8';
  }
  return { ...env, ...overrides };
}
