import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * One version for the whole repo: every package.json and packages/core's VERSION.
 *
 *   node scripts/set-version.mjs 0.2.0      set it everywhere
 *   node scripts/set-version.mjs --check    fail unless they all agree
 *   node scripts/set-version.mjs --check v0.2.0
 *                                           ...and match this release tag
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const versionFile = path.join(root, 'packages/core/src/version.ts');
const versionPattern = /export const VERSION = '([^']+)';/;

function manifests() {
  const found = [path.join(root, 'package.json')];
  for (const group of ['apps', 'packages']) {
    for (const name of fs.readdirSync(path.join(root, group))) {
      const file = path.join(root, group, name, 'package.json');
      if (fs.existsSync(file)) found.push(file);
    }
  }
  return found;
}

function current() {
  const versions = new Map();
  for (const file of manifests())
    versions.set(path.relative(root, file), JSON.parse(fs.readFileSync(file, 'utf8')).version);
  versions.set(path.relative(root, versionFile), versionPattern.exec(fs.readFileSync(versionFile, 'utf8'))?.[1]);
  return versions;
}

const args = process.argv.slice(2);
if (args[0] === '--check') {
  const versions = current();
  const expected = args[1]?.replace(/^v/, '') ?? versions.get('package.json');
  const wrong = [...versions].filter(([, version]) => version !== expected);
  if (wrong.length > 0) {
    for (const [file, version] of wrong)
      console.error(`${file} is ${version ?? 'missing a version'}, expected ${expected}`);
    console.error('Run `node scripts/set-version.mjs <version>` to line them up.');
    process.exit(1);
  }
  console.log(`version ${expected} everywhere`);
} else if (args.length === 1 && /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(args[0])) {
  const version = args[0];
  for (const file of manifests()) {
    const text = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, text.replace(/("version":\s*)"[^"]+"/, `$1"${version}"`));
  }
  fs.writeFileSync(
    versionFile,
    fs.readFileSync(versionFile, 'utf8').replace(versionPattern, `export const VERSION = '${version}';`)
  );
  console.log(`set version ${version}; commit, then tag v${version} to release`);
} else {
  console.error('usage: node scripts/set-version.mjs <version> | --check [tag]');
  process.exit(1);
}
