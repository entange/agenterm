import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The GitHub release notes for a version: its CHANGELOG.md section, then
 * the install steps in .github/release-notes.md. Fails when the changelog
 * has no section for the version, so a release cannot go out without one.
 *
 *   node scripts/release-notes.mjs v0.4.0 > notes.md
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = (process.argv[2] ?? '').replace(/^v/, '');
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('usage: node scripts/release-notes.mjs <version>');
  process.exit(2);
}

const lines = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8').split('\n');
const start = lines.findIndex((line) => new RegExp(`^## \\[?v?${version.replace(/\./g, '\\.')}\\b`).test(line));
if (start === -1) {
  console.error(`CHANGELOG.md has no "## ${version}" section. Add one before releasing.`);
  process.exit(1);
}
const end = lines.findIndex((line, i) => i > start && line.startsWith('## '));
const changes = lines
  .slice(start + 1, end === -1 ? undefined : end)
  .join('\n')
  .trim();
if (changes === '') {
  console.error(`CHANGELOG.md's ${version} section is empty.`);
  process.exit(1);
}

const install = fs.readFileSync(path.join(root, '.github/release-notes.md'), 'utf8').replaceAll('{{version}}', version);
process.stdout.write(`## What changed\n\n${changes}\n\n${install}`);
