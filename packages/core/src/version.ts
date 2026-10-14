/** agenterm release version. `scripts/set-version.mjs` keeps it in step with every package.json. */
export const VERSION = '0.1.0';

/**
 * Revision of the daemon's HTTP API. Bump it when a client of the previous
 * revision would get wrong answers or missing routes from the new daemon,
 * so CLIs and apps from other installs notice and can replace it.
 */
export const API_VERSION = 2;
