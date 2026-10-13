import { resolve } from 'node:path';
import type { IncomingMessage } from 'node:http';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { WebSocketServer } from 'ws';
import { API_METHODS, type ConnectionInfo } from './shared/bridge.js';
import { DaemonLink } from './electron/main/daemonLink.js';
import { loadLoginEnv } from './electron/main/loginEnv.js';

const PORT = Number(process.env['AGENTERM_WEB_PORT'] ?? '5199');

/**
 * Development-only browser harness for the renderer.
 *
 * Plays Electron main's role inside the Vite dev server: holds the daemon
 * token server-side, runs allowlisted client calls, and relays events and
 * activity ticks over a local socket. Bound to 127.0.0.1 and refuses
 * requests whose Host or Origin is not this server, so other pages cannot
 * drive the daemon through it. Never part of the packaged app.
 */
function devBridge(): Plugin {
  return {
    name: 'agenterm-dev-bridge',
    apply: 'serve',
    configureServer(server) {
      const link = new DaemonLink({ loginEnv: loadLoginEnv(), isPackaged: false, resourcesPath: '' });
      void link.ensure();
      const allowed = (request: IncomingMessage): boolean => {
        const host = request.headers.host ?? '';
        const origin = request.headers.origin;
        const local = [`127.0.0.1:${PORT}`, `localhost:${PORT}`];
        return local.includes(host) && (origin === undefined || local.some((entry) => origin === `http://${entry}`));
      };
      server.middlewares.use('/__agenterm/call', (request, response) => {
        if (!allowed(request) || request.method !== 'POST') {
          response.statusCode = 403;
          response.end();
          return;
        }
        let body = '';
        request.on('data', (chunk: Buffer) => {
          body += chunk.toString('utf8');
        });
        request.on('end', () => {
          void (async () => {
            const { method, args } = JSON.parse(body) as { method: string; args: unknown[] };
            response.setHeader('Content-Type', 'application/json');
            if (!(API_METHODS as readonly string[]).includes(method)) {
              response.end(
                JSON.stringify({ ok: false, error: { status: 400, code: 'bad_call', message: 'unknown method' } })
              );
              return;
            }
            try {
              const client = link.client() as unknown as Record<string, (...rest: unknown[]) => Promise<unknown>>;
              const value = await client[method]?.(...args);
              response.end(JSON.stringify({ ok: true, value }));
            } catch (error) {
              const record = error as { status?: number; code?: string; message?: string; hint?: string };
              response.end(
                JSON.stringify({
                  ok: false,
                  error: {
                    status: record.status ?? 0,
                    code: record.code ?? 'internal',
                    message: record.message ?? String(error),
                    hint: record.hint
                  }
                })
              );
            }
          })();
        });
      });
      const wss = new WebSocketServer({ noServer: true });
      server.httpServer?.on('upgrade', (request, socket, head) => {
        if (request.url !== '/__agenterm/stream') return;
        if (!allowed(request)) {
          socket.destroy();
          return;
        }
        wss.handleUpgrade(request, socket, head, (ws) => {
          const send = (kind: string, payload: unknown): void => {
            if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ kind, payload }));
          };
          send('connection', link.connection());
          const mine = new Set<string>();
          const offs = [
            link.onEvent((event) => send('event', event)),
            link.onActivity((tick) => send('activity', tick)),
            link.onConnection((info: ConnectionInfo) => send('connection', info))
          ];
          ws.on('message', (raw) => {
            const message = JSON.parse(String(raw)) as { kind: string; sessionId?: string; data?: string };
            if (message.kind === 'input' && typeof message.sessionId === 'string' && typeof message.data === 'string') {
              link.sendInput(message.sessionId, message.data);
            }
            if (message.kind === 'start') void link.ensure();
            if (message.kind === 'subscribe' && typeof message.sessionId === 'string' && !mine.has(message.sessionId)) {
              mine.add(message.sessionId);
              link.subscribe(message.sessionId);
            }
            if (
              message.kind === 'unsubscribe' &&
              typeof message.sessionId === 'string' &&
              mine.delete(message.sessionId)
            ) {
              link.unsubscribe(message.sessionId);
            }
          });
          ws.on('close', () => {
            offs.forEach((off) => off());
            for (const sessionId of mine) link.unsubscribe(sessionId);
          });
        });
      });
    }
  };
}

export default defineConfig({
  root: '.',
  plugins: [react(), tailwindcss(), devBridge()],
  server: { host: '127.0.0.1', port: PORT, strictPort: true },
  build: { rollupOptions: { input: resolve(__dirname, 'web.html') } }
});
