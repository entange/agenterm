// Stage the daemon for packaging: one bundled ESM file plus the two native
// modules it loads, trimmed to the target platform's N-API prebuilds (which
// load under Electron's Node without a rebuild).
//
//   node scripts/stage-daemon.mjs            build into build/agentermd
//   node scripts/stage-daemon.mjs --verify   then boot it with ELECTRON_RUN_AS_NODE,
//                                            spawn a PTY session, and read it back
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = path.resolve(here, '..');
const out = path.join(app, 'build', 'agentermd');
const platform = process.env.AGENTERM_TARGET_PLATFORM ?? process.platform;
const arch = process.env.AGENTERM_TARGET_ARCH ?? process.arch;
const target = `${platform}-${arch}`;

execFileSync(
  process.execPath,
  [path.join(app, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--config', 'vite.daemon.config.ts'],
  {
    cwd: app,
    stdio: 'inherit'
  }
);

const runtimeRequire = createRequire(path.join(app, '..', '..', 'packages', 'runtime', 'package.json'));
function packageDir(name) {
  return path.dirname(runtimeRequire.resolve(`${name}/package.json`));
}

/** Copy without tests and source maps; the daemon never loads them. */
function copy(from, to) {
  fs.cpSync(from, to, {
    recursive: true,
    dereference: true,
    filter: (source) => !/\.test\.js$|\.map$/.test(source)
  });
}

const modules = path.join(out, 'native');
fs.rmSync(modules, { recursive: true, force: true });

const pty = packageDir('node-pty');
const ptyOut = path.join(modules, 'node-pty');
copy(path.join(pty, 'package.json'), path.join(ptyOut, 'package.json'));
copy(path.join(pty, 'lib'), path.join(ptyOut, 'lib'));
// node-pty ships prebuilds for macOS and Windows; Linux installs compile into build/Release.
const ptyPrebuild = path.join(pty, 'prebuilds', target);
const ptyCompiled = path.join(pty, 'build', 'Release');
const ptyBinaries = fs.existsSync(ptyPrebuild)
  ? { from: ptyPrebuild, to: path.join(ptyOut, 'prebuilds', target) }
  : fs.existsSync(path.join(ptyCompiled, 'pty.node'))
    ? { from: ptyCompiled, to: path.join(ptyOut, 'build', 'Release') }
    : null;
if (ptyBinaries === null) throw new Error(`node-pty has no prebuild or compiled binary for ${target}`);
copy(ptyBinaries.from, ptyBinaries.to);
const helper = path.join(ptyBinaries.to, 'spawn-helper');
if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755);

const sqlite = packageDir('better-sqlite3');
const sqliteOut = path.join(modules, 'better-sqlite3');
copy(path.join(sqlite, 'package.json'), path.join(sqliteOut, 'package.json'));
copy(path.join(sqlite, 'lib'), path.join(sqliteOut, 'lib'));
const sqlitePrebuild = path.join(sqlite, 'prebuilds', `${target}.node`);
if (!fs.existsSync(sqlitePrebuild)) throw new Error(`better-sqlite3 has no prebuild for ${target}`);
copy(sqlitePrebuild, path.join(sqliteOut, 'prebuilds', `${target}.node`));

console.log(`staged daemon for ${target} in ${path.relative(process.cwd(), out)}`);

if (process.argv.includes('--verify')) await verify();

async function verify() {
  const electron = createRequire(path.join(app, 'package.json'))('electron');
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'agenterm-stage-'));
  const port = String(38000 + Math.floor(Math.random() * 1000));
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', AGENTERM_DATA_DIR: data, AGENTERM_PORT: port };
  const daemon = spawn(electron, [path.join(out, 'index.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  daemon.stderr.on('data', (chunk) => (stderr += chunk));
  try {
    const token = await waitFor(() => fs.readFileSync(path.join(data, 'token'), 'utf8').trim());
    const call = async (method, pathname, body) => {
      const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      return response.json();
    };
    const health = await waitFor(() => call('GET', '/health'));
    const { session } = await call('POST', '/sessions', {
      provider: 'generic',
      command: '/bin/echo',
      args: ['staged-pty-ok'],
      cwd: os.tmpdir()
    });
    const output = await waitFor(async () => {
      const page = await call('GET', `/sessions/${session.id}/output`);
      const text = page.chunks.map((chunk) => chunk.data).join('');
      if (!text.includes('staged-pty-ok')) throw new Error('no output yet');
      return text.trim();
    });
    const events = await call('GET', '/events?limit=5');
    console.log(
      `verify ok: daemon ${health.version} under Electron node, pty said "${output}", sqlite holds ${events.events.length} events`
    );
  } catch (error) {
    console.error('verify failed:', error, stderr);
    process.exitCode = 1;
  } finally {
    daemon.kill('SIGTERM');
  }
}

async function waitFor(read, timeoutMs = 10000) {
  const started = Date.now();
  for (;;) {
    try {
      return await read();
    } catch (error) {
      if (Date.now() - started > timeoutMs) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}
