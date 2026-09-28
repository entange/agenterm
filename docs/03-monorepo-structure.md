# 03 — Monorepo structure (Turborepo + Bun)

Package manager is Bun, always. `bun install`, `bun run`, `bunx`, `bun --filter`.
Bun workspaces are declared in the root `package.json`. There is no
`pnpm-workspace.yaml`. Resolve every dependency at its latest stable version at
scaffold time and record exact versions in `bun.lock` plus the scaffold commit
message. Never put stage labels (`v0`, `v1`, `beta`, `alpha`) in package names,
folder names, or script names.

```
agenterm/
  apps/
    desktop/            # Electron shell (electron-vite + React)
      electron/main/    # ensures agentermd, tray, updater, deep links
      electron/preload/ # contextBridge only, no node exposure to renderer
      src/              # React: routes, screens, xterm wrapper, stores
    cli/                # `agenterm` (commander, published as bin)
  packages/
    runtime/            # agentermd: Fastify + ws + node-pty + supervisor
      src/
        pty/            # spawn/resize/write/kill, ring buffer, attach handling
        supervisor/     # systeminformation poll, ports join, kill-tree
        adapters/       # harness overlay: claude.ts codex.ts opencode.ts gemini.ts (read-only, flagged)
        store/          # sqlite access via drizzle-orm, full-text search, retention pruning
        api/            # Fastify routes + ws fan-out + verbose request/response types
    core/               # shared verbose TypeScript types, event definitions, api client
    ui/                 # shared React components (shadcn wrappers, tables)
    config/             # eslint / prettier / tsconfig bases
  docs/                 # this folder
  turbo.json
  package.json          # bun workspaces + scripts
  bun.lock
```

## Workspace deps

- `apps/desktop` depends on `@agenterm/core` (api client, verbose types).
- `apps/cli` depends on `@agenterm/core`.
- `packages/runtime` depends on `@agenterm/core` (shared types).
- `packages/ui` is dumb components only; app state lives in apps.
- Native modules (`node-pty`, `better-sqlite3`) are dependencies of
  `packages/runtime` only, never of `apps/desktop` directly.

## turbo.json pipelines (the model must write the real file)

The pipeline must include at least: `build` (depends on `^build`, outputs
`dist/**`), `dev` (uncached, persistent), `lint`, `typecheck`
(depends on `^build`), `test` (depends on `^build`), `pack` (depends on
`build`). All runnable via Bun: `bun run dev`, `bun run build`, and so on.

Root scripts: `dev` (daemon watch + electron), `dev:daemon`, `dev:desktop`,
`dev:cli`, `build`, `pack:mac`, `pack:win`, `lint`, `typecheck`, `test`.

## Versioning

Single production version across `apps/desktop` + `apps/cli` +
`packages/runtime`. No stage suffixes in code or artifacts. Use `changesets`
only if publishing the CLI to npm. Electron auto-update via
`electron-builder` publish (GitHub releases or S3).
