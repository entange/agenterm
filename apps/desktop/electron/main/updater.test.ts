import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { INSTALL_SCRIPT, installBlocker } from './updater.js';

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) {
    fs.chmodSync(dir, 0o755);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  dirs = [];
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenterm-updater-'));
  dirs.push(dir);
  return dir;
}

function bundle(at: string, marker: string): string {
  fs.mkdirSync(path.join(at, 'Contents'), { recursive: true });
  fs.writeFileSync(path.join(at, 'Contents', marker), '');
  return at;
}

/** Run the install script for a process that has already exited, without reopening anything. */
function install(app: string, next: string, old: string): void {
  const gone = spawnSync('true').pid ?? 999_999;
  const script = path.join(path.dirname(old), 'install.sh');
  fs.writeFileSync(script, INSTALL_SCRIPT, { mode: 0o755 });
  const result = spawnSync('/bin/sh', [script, String(gone), app, next, old, '0']);
  expect(result.status).toBe(0);
}

describe('the install script', () => {
  it('swaps the new app in and removes the old one', () => {
    const root = tempDir();
    const app = bundle(path.join(root, 'Applications', 'agenterm.app'), 'old');
    const next = bundle(path.join(root, 'work', 'unpacked', 'agenterm.app'), 'new');
    const old = path.join(root, 'work', 'previous.app');
    install(app, next, old);
    expect(fs.readdirSync(path.join(app, 'Contents'))).toEqual(['new']);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(next)).toBe(false);
  });

  it('puts the old app back when the new one cannot move in', () => {
    const root = tempDir();
    const app = bundle(path.join(root, 'Applications', 'agenterm.app'), 'old');
    fs.mkdirSync(path.join(root, 'work'));
    install(app, path.join(root, 'work', 'missing.app'), path.join(root, 'work', 'previous.app'));
    expect(fs.readdirSync(path.join(app, 'Contents'))).toEqual(['old']);
  });
});

describe('installBlocker', () => {
  it('allows an app in a folder it can write to', () => {
    expect(installBlocker(bundle(path.join(tempDir(), 'agenterm.app'), 'x'))).toBeNull();
  });

  it('refuses the disk image, a translocated copy, and a read-only folder', () => {
    expect(installBlocker('/Volumes/agenterm 0.4.0/agenterm.app')).toMatch(/disk image/);
    expect(installBlocker('/private/var/folders/x/AppTranslocation/ABC/d/agenterm.app')).toMatch(/temporary copy/);
    const folder = tempDir();
    const app = bundle(path.join(folder, 'agenterm.app'), 'x');
    fs.chmodSync(folder, 0o555);
    expect(installBlocker(app)).toMatch(/cannot write to/);
    expect(installBlocker('/usr/local/bin/agenterm')).toMatch(/not running from an app bundle/);
  });
});
