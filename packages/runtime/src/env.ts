/**
 * Environment for spawned agents.
 *
 * Agents need the user's real login environment: HOME and USER for config
 * and keychain auth, SHELL and LANG for sane tooling, and any provider API
 * keys the user exported. The daemon inherits that environment from the
 * shell or from Electron main (which resolves the login shell env), so
 * spawns start from it. Daemon and Electron internals are removed so they
 * never leak into child tools, request overrides apply on top, and the
 * result is never persisted or logged.
 */

/** Keys that describe the daemon or its Electron host, not the user. */
const INTERNAL_KEYS: readonly string[] = [
  'AGENTERM_PORT',
  'AGENTERM_HARNESS_WATCH',
  'ELECTRON_RUN_AS_NODE',
  'ELECTRON_NO_ATTACH_CONSOLE',
  'ELECTRON_ENABLE_LOGGING',
  'NODE_CHANNEL_FD'
];

/** Build the spawn env from an inherited base plus validated overrides. */
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
