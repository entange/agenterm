import { createApp } from './server.js';
import { acquireLock } from './lock.js';
import { dataDir } from './paths.js';
import { loadOrCreateToken } from './token.js';

/**
 * Daemon entry.
 *
 * Ensures the data dir, loads the token, acquires the single-flight lock,
 * then listens on 127.0.0.1 only. A second starter exits as a client.
 */
async function main(): Promise<void> {
  const dir = dataDir();
  const token = loadOrCreateToken(dir);
  const desiredPort = Number(process.env['AGENTERM_PORT'] ?? '37241');
  const { lock, isOwner } = await acquireLock({
    dir,
    token,
    desiredPort: Number.isInteger(desiredPort) ? desiredPort : 37241
  });
  if (!isOwner) {
    console.log(`daemon already running on port ${lock.port} (pid ${lock.pid})`);
    return;
  }
  const app = createApp({ token, port: lock.port, startedAtMs: lock.startedAtMs });
  await app.listen({ host: '127.0.0.1', port: lock.port });
  console.log(`agentermd listening on 127.0.0.1:${lock.port}`);
}

await main();
