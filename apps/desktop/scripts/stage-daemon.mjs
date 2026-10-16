// Stage the daemon for packaging: one bundled ESM file plus the two native
// modules it loads, trimmed to each target's N-API prebuilds (which load
// under Electron's Node without a rebuild). One folder per target, so a
// single machine can package every architecture.
//
// The CLI rides along in cli/, with bin/agenterm to run it on the app's
// Electron; the app links /usr/local/bin/agenterm to that script.
//
//   node scripts/stage-daemon.mjs                  this machine, into build/daemon/<platform>-<arch>
//   node scripts/stage-daemon.mjs --arch arm64,x64 several architectures
//   node scripts/stage-daemon.mjs --verify         then boot this machine's build with ELECTRON_RUN_AS_NODE,
//                                                  run a task in a PTY, and read it back through the staged CLI
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = path.resolve(here, '..');
const bundle = path.join(app, 'build', 'daemon-bundle');
const platform = process.env.AGENTERM_TARGET_PLATFORM ?? process.platform;
const archFlag = process.argv.indexOf('--arch');
const arches = archFlag === -1 ? [process.arch] : (process.argv[archFlag + 1] ?? '').split(',').filter(Boolean);
const stagedDir = (arch) => path.join(app, 'build', 'daemon', `${platform}-${arch}`);

execFileSync(
  process.execPath,
  [path.join(app, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--config', 'vite.daemon.config.ts'],
  {
    cwd: app,
    stdio: 'inherit'
  }
);

// The CLI's own build: dist/index.js and its chunks (its dist/daemon.js is the npm package's daemon).
const cli = path.join(app, '..', 'cli');
execFileSync(
  process.execPath,
  [path.join(cli, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--config', 'vite.bundle.config.ts'],
  {
    cwd: cli,
    stdio: 'inherit'
  }
);

const runtimeRequire = createRequire(path.join(app, '..', '..', 'packages', 'runtime', 'package.json'));
function packageDir(name) {
  return path.dirname(runtimeRequire.resolve(`${name}/package.json`));
}

/**
 * The @lydell/node-pty build for a target. Installs only carry this
 * machine's, so another architecture's is fetched from npm into build/.
 */
function ptyPackage(target) {
  // Its exports hide package.json, so find the folder from its entry.
  const loader = path.dirname(runtimeRequire.resolve('@lydell/node-pty'));
  const name = `@lydell/node-pty-${target}`;
  try {
    // Its exports point at lib/index.js.
    return path.resolve(createRequire(path.join(loader, 'package.json')).resolve(name), '..', '..');
  } catch {
    const version = JSON.parse(fs.readFileSync(path.join(loader, 'package.json'), 'utf8')).optionalDependencies[name];
    if (version === undefined) throw new Error(`@lydell/node-pty has no build for ${target}`);
    const cache = path.join(app, 'build', 'pty', `${target}-${version}`);
    if (!fs.existsSync(path.join(cache, 'package.json'))) {
      fs.mkdirSync(cache, { recursive: true });
      const tarball = execFileSync('npm', ['pack', `${name}@${version}`, '--silent'], {
        cwd: cache,
        encoding: 'utf8'
      }).trim();
      execFileSync('tar', ['-xzf', tarball, '--strip-components=1'], { cwd: cache });
      fs.rmSync(path.join(cache, tarball));
    }
    return cache;
  }
}

/** Copy without tests and source maps; the daemon never loads them. */
function copy(from, to) {
  fs.cpSync(from, to, {
    recursive: true,
    dereference: true,
    filter: (source) => !/\.test\.js$|\.map$/.test(source)
  });
}

fs.rmSync(path.join(app, 'build', 'daemon'), { recursive: true, force: true });
for (const arch of arches) stage(arch);

function stage(arch) {
  const target = `${platform}-${arch}`;
  const out = stagedDir(arch);
  fs.mkdirSync(out, { recursive: true });
  copy(path.join(bundle, 'index.mjs'), path.join(out, 'index.mjs'));
  copy(path.join(cli, 'dist', 'index.js'), path.join(out, 'cli', 'index.js'));
  copy(path.join(cli, 'dist', 'chunks'), path.join(out, 'cli', 'chunks'));
  fs.writeFileSync(path.join(out, 'cli', 'package.json'), '{ "type": "module" }\n');
  copy(path.join(app, 'resources', 'agenterm'), path.join(out, 'bin', 'agenterm'));
  fs.chmodSync(path.join(out, 'bin', 'agenterm'), 0o755);
  const modules = path.join(out, 'native');
  fs.rmSync(modules, { recursive: true, force: true });

  // @lydell/node-pty keeps each platform's build in its own package; the
  // daemon imports that package's lib directly, so its loader is not staged.
  const pty = ptyPackage(target);
  const ptyOut = path.join(modules, 'node-pty');
  copy(path.join(pty, 'package.json'), path.join(ptyOut, 'package.json'));
  copy(path.join(pty, 'lib'), path.join(ptyOut, 'lib'));
  copy(path.join(pty, 'prebuilds', target), path.join(ptyOut, 'prebuilds', target));
  fs.chmodSync(path.join(ptyOut, 'prebuilds', target, 'spawn-helper'), 0o755);

  const sqlite = packageDir('better-sqlite3');
  const sqliteOut = path.join(modules, 'better-sqlite3');
  copy(path.join(sqlite, 'package.json'), path.join(sqliteOut, 'package.json'));
  copy(path.join(sqlite, 'lib'), path.join(sqliteOut, 'lib'));
  const sqlitePrebuild = path.join(sqlite, 'prebuilds', `${target}.node`);
  if (!fs.existsSync(sqlitePrebuild)) throw new Error(`better-sqlite3 has no prebuild for ${target}`);
  copy(sqlitePrebuild, path.join(sqliteOut, 'prebuilds', `${target}.node`));
  console.log(`staged daemon for ${target} in ${path.relative(process.cwd(), out)}`);
}
if (process.argv.includes('--verify')) await verify();

async function verify() {
  const electron = createRequire(path.join(app, 'package.json'))('electron');
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'agenterm-stage-'));
  const port = String(38000 + Math.floor(Math.random() * 1000));
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', AGENTERM_DATA_DIR: data, AGENTERM_PORT: port };
  const daemon = spawn(electron, [path.join(stagedDir(process.arch), 'index.mjs')], {
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
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
    const { task } = await call('POST', '/tasks', { id: 'verify', command: 'echo staged-pty-ok', cwd: os.tmpdir() });
    const output = await waitFor(async () => {
      const page = await call('GET', `/tasks/${task.id}/output`);
      const text = page.chunks.map((chunk) => chunk.data).join('');
      if (!text.includes('staged-pty-ok')) throw new Error('no output yet');
      return text.trim();
    });
    const { tasks } = await call('GET', '/tasks');
    const cliSaid = execFileSync(electron, [path.join(stagedDir(process.arch), 'cli', 'index.js'), 'logs', 'verify'], {
      env,
      encoding: 'utf8'
    });
    if (!cliSaid.includes('staged-pty-ok')) throw new Error(`the staged CLI printed ${JSON.stringify(cliSaid)}`);
    console.log(
      `verify ok: daemon ${health.version} (api ${health.api}) under Electron node, pty said "${output}", sqlite holds ${tasks.length} task, the CLI reads it back`
    );
  } catch (error) {
    console.error('verify failed:', error, stderr);
    process.exitCode = 1;
  } finally {
    daemon.kill('SIGTERM');
    await new Promise((resolve) => daemon.once('exit', resolve));
    fs.rmSync(data, { recursive: true, force: true });
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
