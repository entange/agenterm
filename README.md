# agenterm

Run long-running commands (dev servers, watchers, builds, tests) in terminals you can watch, type into, and stop
from anywhere.

You or your coding agent start a command with `agenterm run`. It keeps running in the background, even after the
terminal or agent that started it exits. The desktop app lists every task with its live terminal, one click away.

```sh
agenterm run --id web "npm run dev"    # start it (or get the one already running)
agenterm ls                            # what is running
agenterm logs web -f                   # follow its output
agenterm stop web                      # Ctrl+C, then end it
```

## Why

Agents start dev servers and then lose track of them: they start a second copy, forget the port, or leave ten
`node` processes behind. With agenterm every long-running command gets an id:

- **No duplicates.** Running the same `--id`, or the same command in the same folder, returns the task that is
  already running instead of starting another. `--restart` replaces it.
- **One place to look.** `agenterm ls` (or the app) shows every task with its status, ports, folder, and who
  started it.
- **Clean stops.** `stop` sends Ctrl+C, then ends the whole process tree if it keeps running. `--force` kills right
  away.

## Install

### The CLI (macOS and Linux)

Needs [Node.js](https://nodejs.org) 22 or newer.

```sh
npm install -g agenterm --allow-scripts=node-pty
agenterm run --id hello "echo hello"     # starts the background daemon on first use
```

Or run it without installing: `npx agenterm ls`.

`--allow-scripts=node-pty` lets npm 12 and newer build node-pty, the native module behind the terminals. Older npm
ignores the flag. On Linux, that build needs `python3`, `make`, and a C++ compiler (`sudo apt install
build-essential python3`). If the build was skipped, agenterm says so and prints the command that fixes it.

### The desktop app (macOS)

Download the DMG for your Mac from the [latest release](https://github.com/entange/agenterm/releases/latest):

- **Apple Silicon** (M1 and later): `agenterm-<version>-arm64-mac.dmg`
- **Intel**: `agenterm-<version>-x64-mac.dmg`

Open it and drag agenterm into Applications. It runs on macOS 12 or later and brings its own copy of the daemon, so
it works without the CLI. You need the CLI (or MCP) to start tasks.

**First launch.** Until the app is signed with an Apple Developer ID, macOS blocks the first open with "Apple could
not verify agenterm". Either:

- open it once, then go to **System Settings → Privacy & Security**, scroll down, and click **Open Anyway**; or
- run `xattr -dr com.apple.quarantine /Applications/agenterm.app` in a terminal, then open it normally.

The app tells you when a new version is out. The CLI and app check each other's version, and `agenterm daemon
restart` swaps in the daemon from the copy you just installed.

### Connect your agent

See [For agents (MCP)](#for-agents-mcp) below, or **Settings → Connect an agent** in the app.

## CLI

| Command                               | What it does                                                         |
| ------------------------------------- | -------------------------------------------------------------------- |
| `run [--id ID] "<command>"`           | Start a command in a new terminal, or return the one already running |
| `ls [--running] [--json]`             | List tasks, running first                                            |
| `show <task>`                         | One task in detail                                                   |
| `logs <task> [-n N] [-f]`             | Recent output; `-f` keeps printing until it ends                     |
| `input <task> <text>`                 | Type into a task, then press Enter (unless `--no-enter`)             |
| `stop <task...> [--force]`            | Ctrl+C, then end the process tree; `--force` kills right away        |
| `rm <task...>`                        | Remove tasks and their output, stopping them first                   |
| `clear`                               | Remove every task that is no longer running                          |
| `settings`                            | Show or change settings, e.g. `--stop-with-agent on`                 |
| `daemon start\|stop\|restart\|status` | Manage the background daemon                                         |
| `mcp`                                 | Serve the same tools over the Model Context Protocol (stdio)         |

`run` also takes `-C <dir>`, `-t <title>`, `--agent <name>`, `--restart`, `--wait <seconds>`, and `--json`. A task
can be named by its id, its title, or a unique id prefix.

## For agents (MCP)

```sh
claude mcp add --scope user agenterm -- agenterm mcp   # Claude Code, every project
codex mcp add agenterm -- agenterm mcp                 # Codex
```

Cursor, Claude Desktop, and most other agents take the same server in their MCP config file:

```json
{ "mcpServers": { "agenterm": { "command": "agenterm", "args": ["mcp"] } } }
```

Without a global install, use `"command": "npx", "args": ["-y", "agenterm", "mcp"]` (on Linux, add
`"--allow-scripts=node-pty"` before `"agenterm"`).

Apps opened from the Dock may not see your shell's PATH; use the full path from `which agenterm` as the command if
they cannot find it. The app shows all of this under Settings → Connect an agent.

The tools match the CLI: `run`, `list`, `logs`, `input`, `stop`, and `remove`. Output comes back as plain text with
secrets redacted.

Agents can also just call the CLI. Either way, giving each command an id (`--id web`) is what keeps an agent from
starting the same server twice.

### Agent skill

[`skills/agenterm/SKILL.md`](skills/agenterm/SKILL.md) is an [Agent Skill](https://agentskills.io) that teaches an
agent when to use agenterm, to always pass an id, and how to check on, stop, and clean up tasks. To use it, copy
the `skills/agenterm` folder into your agent's skills folder, e.g. `.claude/skills/` in a project for Claude Code.

## The app

A list of tasks on the left, grouped by project or by who started them, and the selected task's terminal on the
right. Click a task and the cursor is in its terminal, ready to type. The header shows its command, folder, ports
(click to open), and Stop, Kill, and Remove.

- `⌘K` finds a task, `⌘1`–`⌘9` jump to one, `⌘[` / `⌘]` go to the previous or next one, `/` filters the list.
- Closing the window leaves tasks running. The tray menu lists them.
- A notification tells you when a task fails while the app is in the background.

The app does not start tasks. That stays with the CLI and MCP, so there is one way to do it.

## When the agent exits

By default a task keeps running until you or an agent stops it. To stop tasks when the program that ran
`agenterm run` (or the MCP server) exits, turn on **Stop a task when the agent that started it exits** in Settings,
or run `agenterm settings --stop-with-agent on`.

agenterm detects who started a task (Claude Code, Codex, an editor, or a terminal) by walking the process tree.
`--agent <name>` sets it explicitly.

## Running many tasks

The task list is virtualized, and the daemon sends one activity summary per second instead of streaming every
terminal, so hundreds of tasks stay responsive.

macOS allows 511 pseudo-terminals system-wide by default, shared with every other terminal app. To run more:

```sh
sudo sysctl -w kern.tty.ptmx_max=999
```

## Where things are stored

| What                                | Where                                                     |
| ----------------------------------- | --------------------------------------------------------- |
| Tasks, output, settings, daemon log | `~/.agenterm/` (`AGENTERM_DATA_DIR` moves it)             |
| App window and theme preferences    | `~/Library/Application Support/agenterm/preferences.json` |
| The app                             | `/Applications/agenterm.app`                              |
| The CLI                             | wherever `npm root -g` points                             |

To remove agenterm completely: `agenterm daemon stop`, `npm uninstall -g agenterm`, delete the app, then
`rm -rf ~/.agenterm ~/Library/Application\ Support/agenterm`.

## Security and privacy

- The daemon listens on `127.0.0.1` only. Every request needs a 32-byte bearer token stored `0600` in
  `~/.agenterm/token`. Only the CLI and Electron main read it. The UI never sees it.
- Environment variables passed to a task are never written to disk. Commands are stored with secrets redacted.
- agenterm never reads or writes `~/.claude`, `~/.codex`, or other agent folders.
- The Electron renderer is sandboxed with a strict CSP. Links in terminal output open in your browser.

## Architecture

```
apps/cli           agenterm CLI and MCP stdio server
apps/desktop       Electron: main (daemon link, tray, notifications, updater) + React renderer
packages/runtime   agentermd: Fastify + ws daemon, node-pty, process and port tracking, SQLite
packages/core      shared types, validation, redaction, typed HTTP client
packages/ui        Radix-based primitives shared by the app
```

The daemon owns every terminal, so tasks keep running when the window or the agent goes away. Clients talk to it
over localhost HTTP plus one WebSocket. Data lives in `~/.agenterm/`: `agenterm.db` (task records), `tasks/<id>/terminal.log`
(output), `settings.json`, and `daemon.log`. Set `AGENTERM_DATA_DIR` to use another folder.

## Development

Needs [Bun](https://bun.sh) 1.3+ and Node.js 22+.

```sh
bun install
bun run build
(cd apps/cli && npm link)  # puts this checkout's `agenterm` on your PATH
bun run --filter agenterm-desktop dev
```

```sh
bun run dev          # watch-compile packages
bun run typecheck && bun run lint && bun run test
bun run format       # prettier
bun run dev:web      # the app UI in a browser against a real daemon (dev-only harness)
```

`bun run dev:web` serves the UI at `http://127.0.0.1:5199/web.html`. A Vite middleware stands in for Electron main,
so the UI can be worked on without Electron. It binds to localhost and checks Host and Origin.

### Packaging

```sh
cd apps/desktop
node scripts/stage-daemon.mjs --verify   # bundle the daemon, boot it under Electron's Node, run a real terminal
bun run pack                             # unpacked app for this Mac in release/
bun run dist                             # DMGs and zips for Apple Silicon and Intel
```

Releases are built by GitHub Actions from a version tag. See [docs/RELEASING.md](docs/RELEASING.md).
