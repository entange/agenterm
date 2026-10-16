import { builtinModules } from 'node:module';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

/**
 * Bundle the CLI and the daemon it starts into dist/, so the published
 * package needs no workspace packages. Native modules stay external and are
 * the package's only dependencies; both ship N-API prebuilds.
 */
const native = ['@lydell/node-pty', 'better-sqlite3'];

export default defineConfig({
  build: {
    ssr: true,
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    target: 'node22',
    minify: false,
    sourcemap: false,
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'src/index.ts'),
        daemon: resolve(__dirname, '../../packages/runtime/src/index.ts')
      },
      external: [...native, ...builtinModules, ...builtinModules.map((name) => `node:${name}`)],
      output: {
        format: 'es',
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js'
      }
    }
  },
  ssr: { noExternal: true, target: 'node' }
});
