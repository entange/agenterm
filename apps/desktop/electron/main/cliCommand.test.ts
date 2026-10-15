import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { commandStatus, linkCommand } from './cliCommand.js';

let root: string;
let bundled: string;
let bin: string;
let link: string;

function executable(file: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '#!/bin/sh\n');
  fs.chmodSync(file, 0o755);
  return file;
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agenterm-cli-link-')));
  bundled = executable(path.join(root, 'agenterm.app', 'Contents', 'Resources', 'agentermd', 'bin', 'agenterm'));
  bin = path.join(root, 'bin');
  link = path.join(bin, 'agenterm');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const quietly = { askForPassword: false, replace: false };

describe('commandStatus', () => {
  it('is unavailable without a bundled copy', () => {
    expect(commandStatus(null, bin, link)).toEqual({ state: 'unavailable', path: null });
  });

  it('is missing until the link exists, then installed', async () => {
    expect(commandStatus(bundled, bin, link)).toEqual({ state: 'missing', path: null });
    expect(await linkCommand(bundled, { ...quietly, link })).toBe(true);
    expect(fs.readlinkSync(link)).toBe(bundled);
    expect(commandStatus(bundled, bin, link)).toEqual({ state: 'installed', path: link });
  });

  it('reports another agenterm earlier on the PATH', async () => {
    await linkCommand(bundled, { ...quietly, link });
    const npm = executable(path.join(root, 'npm-bin', 'agenterm'));
    expect(commandStatus(bundled, [path.dirname(npm), bin].join(path.delimiter), link)).toEqual({
      state: 'other',
      path: npm
    });
  });
});

describe('linkCommand', () => {
  it('repoints a link left by an app that moved', async () => {
    fs.mkdirSync(bin, { recursive: true });
    fs.symlinkSync('/Users/me/Downloads/agenterm.app/Contents/Resources/agentermd/bin/agenterm', link);
    expect(await linkCommand(bundled, { ...quietly, link })).toBe(true);
    expect(fs.readlinkSync(link)).toBe(bundled);
  });

  it('replaces a broken link', async () => {
    fs.mkdirSync(bin, { recursive: true });
    fs.symlinkSync(path.join(root, 'gone'), link);
    expect(await linkCommand(bundled, { ...quietly, link })).toBe(true);
  });

  it('leaves a working npm link alone unless asked to replace it', async () => {
    const npm = executable(path.join(root, 'lib', 'node_modules', 'agenterm', 'dist', 'index.js'));
    fs.mkdirSync(bin, { recursive: true });
    fs.symlinkSync(npm, link);
    expect(await linkCommand(bundled, { ...quietly, link })).toBe(false);
    expect(fs.readlinkSync(link)).toBe(npm);
    expect(await linkCommand(bundled, { askForPassword: false, replace: true, link })).toBe(true);
    expect(fs.readlinkSync(link)).toBe(bundled);
  });

  it('never replaces a regular file', async () => {
    executable(link);
    expect(await linkCommand(bundled, { askForPassword: false, replace: true, link })).toBe(false);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(false);
  });

  it('gives up quietly when the folder is not writable and no password may be asked', async () => {
    fs.mkdirSync(bin, { recursive: true });
    fs.chmodSync(bin, 0o555);
    try {
      expect(await linkCommand(bundled, { ...quietly, link })).toBe(false);
    } finally {
      fs.chmodSync(bin, 0o755);
    }
  });
});
