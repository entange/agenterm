# 01 — Stack decision (TS-only, lib-first, Bun, latest)

## Locked constraints

1. Only TypeScript until a proven bottleneck forces native code.
2. Turborepo monorepo with Bun as the package manager. All commands use
   `bun install`, `bun run`, `bunx`, `bun --filter`. Never pnpm/npm/yarn.
3. Always scaffold and install the latest stable version of everything at build
   time: Bun runtime, Node target, Electron, electron-vite, electron-builder,
   React, Vite, Tailwind, shadcn/ui deps, xterm.js, Fastify, ws, node-pty,
   systeminformation, better-sqlite3, drizzle-orm, simple-git, chokidar,
   commander, vitest, playwright, eslint, prettier, Turborepo itself.
   The implementing model must resolve "latest" at execution time
   (`bunx npm-view <pkg> version`, official docs, release notes) instead of
   copying version numbers from these docs. Pin exact resolved versions in the
   lockfile (`bun.lock`) and record them in the scaffold commit message.
   Only pin an older major if latest is proven broken, and then document why.
4. Electron shell. No Rust (so no Tauri/GPUI for now).
5. Tailwind for UI. Reuse famous libs maintained by many devs.
6. Production naming only. Words like `v0`, `v1`, `beta`, `alpha`, `preview`
   must never appear in code, file names, UI copy, API routes, env keys,
   package names, or comments as stage labels. Build order lives in
   `08-mvp-roadmap.md` docs only.

## Verdict: Electron now, Electrobun deferred

| | Electron | Electrobun |
|---|---|---|
| Runtime | Bundled Chromium + Node | Bun + OS WebView |
| Maturity | Since 2013, huge fleet, `electron-builder` signing/updater proven | v1-era, smaller ecosystem |
| TS DX | `electron-vite`, DevTools = browser, native modules OK | Fast, tiny deltas, but native modules (`node-pty`) risky under Bun |
| Footprint | Heavy bundle + idle RAM | Lighter in theory, immature bundling in independent benches |
| Mac+Win PTY | `node-pty` works in Node daemon process | `node-pty` under Bun/Electrobun not proven |

Decision: **Electron + electron-vite + electron-builder**, all at latest stable.
Keep daemon protocol (HTTP + WebSocket on localhost) shell-agnostic so a
later shell can reuse `packages/runtime` without rewrite.

## Final stack (all latest stable at scaffold time)

The model scaffolding this repo must pick the newest stable release of each
line below and wire them together in a Bun + Turborepo monorepo. What each
piece is for, in plain verbose terms:

- Monorepo orchestration: Turborepo. It runs `dev`, `build`, `lint`,
  `typecheck`, `test`, `pack` across apps and packages with dependency ordering
  and caching. Bun provides workspaces and the lockfile; Turborepo provides
  the pipeline on top.
- Desktop shell: Electron with electron-vite for the main/preload/renderer
  builds and electron-builder for signed macOS (`dmg`, `zip`, arm64 + x64)
  and Windows (`nsis`, x64) installers plus auto-update from GitHub Releases.
- Frontend framework and styling: React with Vite and TypeScript for the UI,
  Tailwind CSS for all styling, shadcn/ui-style Radix primitives (dialog, tabs,
  dropdown, toast, tooltip, scroll area) for accessible components,
  lucide-react for icons. No custom design system.
- Client state and data: zustand for local UI state such as selected session
  and sidebar filters, plus TanStack Query for caching daemon REST reads and
  TanStack Table for the process/command tables when they arrive.
- Terminal rendering: xterm.js with the fit addon (size terminal to its
  container), the web-links addon (clickable ports/paths), and the search addon
  (in-terminal find). Canvas renderer. Exactly one xterm instance per open
  session tab. The model must handle mount (fetch tail, then subscribe to live
  chunks by sequence number), unmount (dispose locally, daemon keeps truth),
  input (throttled writes to daemon), and resize (debounced columns/rows post).
- Daemon web layer: Fastify for the localhost HTTP API plus a `ws` WebSocket
  server for the live event stream. Fastify owns routing, request validation
  with thorough verbose TypeScript types and runtime checks the model designs,
  error envelopes, and logging. `ws` owns fan-out of terminal chunks and events.
- PTY: node-pty, running only inside the plain daemon process. It spawns the
  agent binary in a real pseudo-terminal, exposes resize, input writing, output
  events, and exit codes, and abstracts ConPTY on Windows. Nothing else in the
  system is allowed to own a PTY.
- Machine truth: systeminformation, polled on an interval and scoped to session
  subtrees. It supplies the process list with parent PIDs, per-process CPU and
  memory, and current TCP listening sockets so ports can be joined back to the
  session that owns them. tree-kill plus the polled PID list implements
  cross-platform kill-tree. get-port resolves daemon port conflicts.
- Git and files: simple-git for branch name, worktree root, staged/unstaged
  state, and diff stats per working directory, plus chokidar for debounced
  recursive file watching with heavy ignores (`node_modules`, `.git`, `dist`).
- Persistence: better-sqlite3 as the embedded database engine plus drizzle-orm
  as the typed query layer, local-first at `~/.agenterm/agenterm.db`. No
  Postgres, no Redis, no Docker. The model must design the full table set
  (machines, projects, workspaces, agents, sessions, processes, commands,
  events) with verbose TypeScript types, indexes for session/time lookups,
  retention pruning, and a capped events table plus full-text search when
  history search arrives.
- Validation approach (no stub-schema library mandated): the model must write
  verbose, explicit TypeScript types for every API request, response, WebSocket
  message, event, and database row, with careful runtime validation at the
  Fastify boundary, tolerant parsing for harness files (unknown on mismatch,
  never throw), and unit tests proving malformed input is rejected or
  downgraded safely. Do not copy a minimal schema from docs; think through
  every field, optional, default, and error case.
- Logging: pino for structured daemon logs with human-readable pretty output
  in development.
- CLI: commander for the `agenterm` command tree (`daemon`, `status`, `list`,
  `discover`, `spawn`, `attach`, `detach`, `kill`, `logs`, `input`, `shutdown`),
  with ws client reuse from the shared core package and readable terminal output.
- Quality: eslint plus prettier for style, vitest for unit and API tests,
  playwright (or the Electron test harness) for the daemon-plus-UI smoke test,
  all wired through Turborepo pipelines.

Why each (lib-first):

- `node-pty`: Microsoft-origin PTY, handles ConPTY on Windows. Don't write PTY.
- `systeminformation`: process list, CPU/mem, ports. Don't write syscalls.
- `better-sqlite3` + `drizzle-orm`: sync SQLite, typed access. No Postgres/Redis — local-first.
- `Fastify` + `ws`: daemon API. Don't invent IPC.
- `simple-git`: branch/status/diff. Don't shell out manually.
- `chokidar`: file-change feed for Files tab.
- `shadcn/ui` + `Tailwind`: dashboard that looks like Linear, not a VS Code clone.
- `zustand` + `tanstack/query`: session selection cache + live event stream.
- `commander`: CLI command tree for free.

## What we explicitly do NOT use yet

- Rust (`portable-pty`, `sysinfo`), Go, GPUI, Tauri — revisit only if Node
  CPU/RAM or PTY throughput becomes a measured problem.
- Postgres, Redis, Docker — local SQLite only.
- Custom terminal emulator, custom UI kit, custom updater.

## Load-bearing rule: native modules live in the daemon only

`node-pty` and `better-sqlite3` must never load in the renderer or Electron
main if avoidable. Daemon is a plain Bun/Node-compatible process, UI is a
client over localhost HTTP + WS. This avoids the classic `better-sqlite3` ABI
trap inside Electron and keeps shell swap possible. Budget real time for
electron-builder native rebuilds, macOS GUI PATH (`/opt/homebrew/bin`,
`~/.local/bin`, agent shims missing in GUI env), ConPTY quirks, and
lock-file races — not component polish.

## Agent-folder safety (hard rule)

The daemon and CLI must treat `~/.claude`, `~/.codex`, OpenCode/Gemini state
directories, and every existing agent working directory as чужой — foreign and
fragile. Before reading or touching any of them, the implementation must ask
the user for permission, name the exact paths, and explain why. Default to
read-only. Never delete, move, rewrite, reformat, or "migrate" files there,
never kill a PID the user did not explicitly approve, and never run
destructive git or filesystem commands inside those folders without a separate
explicit confirmation. Discovery lists candidates; attachment requires approval.
