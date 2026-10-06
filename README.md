# agenterm

A local control room for the AI coding agents, terminals, and dev processes on your machine.

agenterm is not a multiplexer or an orchestrator. It is an observability and control layer that sits on top of real
pseudo-terminals. Start Claude Code, Codex, Gemini CLI, opencode, or any command through it, or attach to agents you
started elsewhere, and see every one of them in one place: which ones need you, what they are doing, what they changed,
which ports they opened, and what they cost.

```
┌─ agenterm ─────────────────────────────────────────────────────────────────┐
│ NEEDS YOU 1        │ CLD-7B01  fix login flow   ● Waiting for your approval │
│ ▌CLD-7B01 fix lo…  │ Terminal  Commands  Changes 2  Files  Processes  Activity│
│ WORKING 2          │                                                        │
│ ▌CDX-41A2 api re…  │   live terminal (xterm.js)                             │
│ ▌BUN-0C9D dev se…  │                                                        │
│ QUIET 1  ENDED 3   │                                                        │
└────────────────────┴────────────────────────────────────────────────────────┘
```

## What it does

- **Strip board of every session**, grouped by what it needs from you: _Needs you_, _Working_, _Quiet_, _Ended_. Each
  strip carries a live heartbeat of the agent's output over the last two minutes, so busy, idle, and stuck agents look
  different at a glance.
- **Real agent status.** Claude Code and Codex sessions started by agenterm push their own state (waiting for approval,
  waiting for a reply, working, failed) through per-session hooks. No transcript scraping.
- **Spend per agent.** Claude Code sessions report cost and tokens through their own telemetry.
- **Live terminals** that survive closing the window and daemon restarts (scrollback is kept on disk), with search,
  Ctrl+C, restart, and safe kill-tree.
- **Workspace truth:** process trees, listening ports (click to open), git changes with diffs, and files edited as they
  happen.
- **Attach read-only** to agents you started in another terminal, with their real working directory, ports, and changes.
- **Native notifications** and a dock badge when an agent waits on you, plus a tray menu.
- **Search every agent's output** from the command palette, the CLI, or MCP.
- **CLI and MCP server**, so you (or another agent) can do everything from a terminal.

## Quick start

Requirements: macOS or Linux, [Bun](https://bun.sh) 1.3+, Node 22+.

```sh
bun install
bun run build
bun run --filter agenterm-desktop dev   # the desktop app; it starts the daemon for you
```

From a terminal instead:

```sh
alias agenterm="node $PWD/apps/cli/dist/index.js"
agenterm daemon start
agenterm spawn --provider claude --cwd ~/code/my-app
agenterm ls
agenterm logs <id> --follow
```

Session ids accept unique prefixes, like git hashes.

## CLI

| Command                                    | What it does                                                                 |
| ------------------------------------------ | ---------------------------------------------------------------------------- |
| `daemon start \| stop \| status \| logs`   | Manage the background daemon                                                 |
| `spawn --provider <p> [--command c] ...`   | Start an agent or command in a daemon-owned terminal                         |
| `ls [--live]`                              | Sessions with status, age, pid, folder                                       |
| `logs <id> [-f]`                           | Scrollback; `-f` follows until the session ends                              |
| `input <id> <text>`                        | Type into a session (adds Enter unless `--no-enter`)                         |
| `signal <id> interrupt\|terminate\|kill`   | Send a signal (Ctrl+C for interrupt)                                         |
| `kill <id>`                                | End a session and its whole process tree; confirms first                     |
| `close <id>`                               | Remove an ended session, or detach an attached one                           |
| `rename`, `restart`                        | Rename, or start an ended session again with the same command                |
| `discover`, `attach <pid>`                 | Find agents started elsewhere and watch one read-only                        |
| `git <id>`, `diff <id> <file>`, `files <id>` | Workspace changes                                                          |
| `grep <text>`                              | Search every session's output                                                |
| `commands <id>`, `events`, `usage`         | Inferred command history, activity feed, model spend                         |
| `mcp`                                      | Serve the Model Context Protocol on stdio                                    |

## Let your agents see each other (MCP)

```sh
claude mcp add agenterm -- agenterm mcp
codex mcp add agenterm -- agenterm mcp
```

Tools: `list_sessions`, `get_session`, `read_output` (plain text, secrets redacted, resumable), `search_output`,
`send_input`,
`interrupt`, `kill_session` (requires the exact pid), and `recent_activity`.

## Agent integration and privacy

When agenterm starts Claude Code it passes `--settings` with hooks, and Codex gets a `notify` program. Both `curl` a
per-session URL on the local daemon. When agenterm starts Claude Code it also points Claude's OpenTelemetry logs at
the daemon for cost and token totals, unless you already configured `OTEL_*` yourself.

- Each session gets its own random ingest token that can only update that session's status. The daemon token never
  enters an agent's environment.
- agenterm never reads or writes `~/.claude`, `~/.codex`, or other agent folders. The transcript watcher is a separate
  opt-in (`AGENTERM_HARNESS_WATCH=1` plus `agenterm harness grant`).
- Opt out per session with `--no-status-hooks`, or everywhere with `AGENTERM_AGENT_HOOKS=0`. Your own `--settings` or
  `notify` always wins.
- Git status, diffs, and file watching apply only to folders you start or attach a session in, never your home or root
  folder.

## Running hundreds of terminals

agenterm is built for fleets: the sidebar is virtualized and groups by status or project, sub-sessions nest under the
session that started them, and the daemon sends one activity summary per second instead of streaming every terminal.
In a load test with 250 live terminals the daemon used about 5% CPU and 160 MB.

macOS allows 511 pseudo-terminals system-wide by default, shared with every other terminal app. To run more:

```sh
sudo sysctl -w kern.tty.ptmx_max=999
```

When the limit is hit, agenterm reports it with this hint instead of a generic spawn error.

## Security model

- The daemon listens on `127.0.0.1` only. Every HTTP route and the event socket require a 32-byte bearer token stored
  `0600` in `~/.agenterm/token`. Only the CLI and Electron main read it. The UI never sees it.
- The Electron renderer is sandboxed with a strict CSP. Links printed by agents open in your browser and never navigate
  the app. IPC is an allowlist, and calls are checked against the calling frame.
- Killing a process agenterm did not start requires naming its pid. Kill and signal only touch sessions that are still
  alive, so a recycled pid is never hit.
- Terminal bytes and typed input are never written to the event database. Stored events are redacted. Data files are
  owner-only, and events and commands are pruned after 30 days.

## Architecture

```
apps/desktop   Electron: main (daemon link, tray, notifications, updater) + React renderer
apps/cli       agenterm CLI and MCP stdio server
packages/runtime   agentermd: Fastify + ws daemon, node-pty, supervisor (ps/lsof), SQLite, git, file watch
packages/core      shared types, validation, redaction, typed HTTP client
packages/ui        Radix-based primitives shared by the app
```

The daemon owns every PTY, so agents keep running when the window closes. Clients talk to it over localhost HTTP plus
one WebSocket. Lifecycle, status, port, and file events reach every client. Terminal bytes reach only clients that
subscribed to that session. Data lives in `~/.agenterm/`: `agenterm.db` (SQLite, WAL), `sessions/<id>/`
(`terminal.log`, `events.jsonl`, `metadata.json`), and `daemon.log`.

More detail is in [`docs/`](docs/README.md).

## Development

```sh
bun run dev          # watch-compile packages
bun run typecheck && bun run lint && bun run test
bun run format       # prettier
bun run dev:web      # the renderer in a browser against a real daemon (dev-only harness)
```

`bun run dev:web` serves the app UI at `http://127.0.0.1:5199/web.html`. A Vite middleware plays Electron main's role,
so the UI can be iterated on without Electron. It binds to localhost and checks Host and Origin.

### Packaging

```sh
cd apps/desktop
node scripts/stage-daemon.mjs --verify   # bundle the daemon, boot it under Electron's Node, drive a real PTY
npx electron-builder --dir               # unpacked app in release/
bun run dist                             # installers (dmg/zip, nsis, AppImage/deb)
```

Signing and notarization run when `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and
`APPLE_TEAM_ID` are set. Auto-update reads GitHub releases. Set `publish.owner` and `publish.repo` in
`apps/desktop/electron-builder.yml` once the repository has a home. CI runs on every push (`.github/workflows`).
