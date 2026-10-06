# 08 — Build order (docs-only phases, never in code)

Phase names below exist only in this document so humans can sequence the work.
They must never appear in code, folder names, UI copy, API routes, env keys,
package names, comments, or artifact names. The product ships as production
code from the first commit.

## Status (kept current)

Done and verified:

- Runtime: PTY spawn/resize/write/kill with login env, ring buffer plus on-disk scrollback that survives restarts,
  forward-paging resume cursor, single-flight lock with stale-pid probing, token auth on HTTP and socket (checked before
  upgrade), WAL SQLite with 30-day retention, discover (real argv, cwd, provider) and read-only attach with exit
  detection, kill-tree limited to live sessions, rename, restart, close, ports join, git status and diff, file watch,
  activity heartbeat, events feed.
- Agent status: Claude Code hooks and Codex notify push status to per-session ingest endpoints. Claude telemetry feeds
  per-session cost and tokens.
- Desktop: strip board, control room, session workspace (terminal, commands, changes, files, processes, activity),
  palette, notifications, badge, tray, menus, sandbox plus CSP, login-shell env, packaging with a bundled daemon,
  updater.
- CLI: full command set including daemon lifecycle, follow logs, git, files, usage. MCP stdio bridge.
- CI: typecheck, lint, format, and tests on macOS and Linux, plus a macOS package smoke job and a release workflow.

Not done yet:

- Windows: paths validate and binaries resolve, but signals and the supervisor are POSIX-first and untested on Windows.
- Full supervisor history (stored CPU/memory snapshots). Output search covers retained output only (ring and the last
  2 MB of each terminal.log), not an index.
- ACP client.
- Gemini and opencode status (no documented hook mechanism yet; output heartbeat only).
- Signed and notarized release builds need credentials.

## Foundation — "it runs, survives, reattaches"

Runtime (`packages/runtime`):

- [ ] `node-pty` spawn, resize, write, kill, exit capture (daemon-only natives, latest stable)
- [ ] Fastify plus ws API: sessions, input, resize, signal, output, stream, plus attach and discover
- [ ] `better-sqlite3` plus drizzle-orm tables (machines, projects, workspaces, agents, sessions, events) with verbose types the model designs
- [ ] Per-session `terminal.log` plus `events.jsonl` plus ring buffer plus sequence resume
- [ ] Single-flight lock plus token `0600` plus port fallback
- [ ] Generic provider spawns (claude, codex, gemini, opencode, custom) plus missing-binary hint with resolved PATH logging
- [ ] `GET /discover` plus `POST /sessions/attach {pid}` (read-only tree join, detach by default, approval required)

Desktop (`apps/desktop`):

- [ ] Electron main ensures daemon (forwards login PATH), tray, window; preload bridge with no raw token to renderer
- [ ] Dashboard list plus Discover view plus detail with live xterm.js (fit, web-links)
- [ ] Create, attach, detach, kill, restart, rename, send, Ctrl+C
- [ ] Show PID, cwd, branch chip, origin, command, started, exit; shared-cwd badge

CLI (`apps/cli`):

- [ ] `daemon`, `status`, `list`, `discover`, `spawn`, `attach`, `detach`, `kill`, `logs`, `input`, `shutdown`
- [ ] Linux and WSL support for daemon plus CLI (GUI packaging macOS plus Windows first)

Acceptance: spawn claude plus attach an existing codex running in another
terminal, close the window, reopen, both visible with scrollback and tree;
kill-tree frees ports; macOS plus Windows pass.

Explicitly out of foundation: CPU and RAM graphs, full tree snapshots, command
history, full git views, search, notifications, MCP and ACP bridges, updater
polish, worktree manager, billing UI.

## Machine-truth demo — skinny supervisor plus overlay

- [ ] Skinny supervisor: child pids plus listening-socket join to Ports tab with Open action
- [ ] Precise kill-tree from polled PID list; port opened and closed events
- [ ] Harness overlay behind `AGENTERM_HARNESS_WATCH`: best-effort status
  (`unknown`, `working`, `waiting_input`, `waiting_permission`, `completed`,
  `failed`), redacted, permission-gated per `07-security-privacy.md` and
  `10-integrations-harness-acp.md`
- [ ] Branch and worktree chip plus shared-cwd warning
- [ ] Configurable redaction patterns

## Observability — full supervisor and history

- [ ] Full supervisor: CPU and memory, bounded snapshots, full-text history search
- [ ] Command heuristic to Commands tab
- [ ] `simple-git` status and diff plus `chokidar` feed to Git and Files tabs
- [ ] Live Activity screen, local notifications (permission needed, nonzero exit)
- [ ] Optional Claude OTEL sink on localhost (sink-only, see `10-...`)

## Agent awareness — adapters and control bridges

- [ ] Real adapters plus full state machine, resume flags the harnesses already
  support (`claude -r`, `codex resume`)
- [ ] MCP stdio bridge (list, get, read, send, kill) plus API docs
- [ ] Optional ACP client consuming terminal creation; never the internal bus

## Control center — production completeness

Agents plus terminals plus processes plus commands plus logs plus events plus
git plus ports plus files plus notifications plus history plus MCP plus updater
plus remote-protocol-ready design (still localhost-only unless explicitly
enabled). No orchestrator features: no kanban, no fleet queues, no mobile
handoff, no marketplace.
