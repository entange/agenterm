import { builtinModules } from 'node:module';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

/**
 * Bundle the daemon into one file for the packaged app.
 *
 * Everything is inlined except native modules, which electron-builder
 * ships rebuilt for Electron's Node ABI inside the app, and Node builtins.
 * The app runs the result with ELECTRON_RUN_AS_NODE.
 */
const native = ['node-pty', 'better-sqlite3'];

export default defineConfig({
  build: {
    ssr: resolve(__dirname, '../../packages/runtime/src/index.ts'),
    outDir: resolve(__dirname, 'build/agentermd'),
    emptyOutDir: true,
    target: 'node22',
    minify: false,
    sourcemap: true,
    rollupOptions: {
      external: [...native, ...builtinModules, ...builtinModules.map((name) => `node:${name}`)],
      output: {
        format: 'es',
        entryFileNames: 'index.mjs',
        inlineDynamicImports: true,
        // Packagers drop folders named node_modules from resources, so the
        // staged native modules live in ./native and are imported by path.
        paths: {
          'node-pty': './native/node-pty/lib/index.js',
          'better-sqlite3': './native/better-sqlite3/lib/index.js'
        }
      }
    }
  },
  ssr: { noExternal: true, target: 'node' }
});
