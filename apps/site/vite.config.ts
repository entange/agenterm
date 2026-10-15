import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

// The release this build links to. The page also asks GitHub for the latest
// release when it loads, so downloads stay current between deploys.
const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
  version: string;
};

export default defineConfig({
  define: { __VERSION__: JSON.stringify(version) },
  build: { target: 'es2022' }
});
