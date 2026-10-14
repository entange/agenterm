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

## Quick start

Requirements: macOS or Linux, [Bun](https://bun.sh) 1.3+, Node 22+.

```sh
bun install
bun run build
alias agenterm="node $PWD/apps/cli/dist/index.js"
agenterm run "npm run dev"             # starts the daemon on first use
```

The desktop app:

```sh
bun run --filter agenterm-desktop dev
```

## CLI

| Command                      | What it does                                                                  |
| ---------------------------- | ----------------------------------------------------------------------------- |
| `run [--id ID] "<command>"`  | Start a command in a new terminal, or return the one already running         |
| `ls [--running] [--json]`    | List tasks, running first                                                     |
| `show <task>`                | One task in detail                                                            |
| `logs <task> [-n N] [-f]`    | Recent output; `-f` keeps printing until it ends                              |
| `input <task> <text>`        | Type into a task, then press Enter (unless `--no-enter`)                      |
| `stop <task...> [--force]`   | Ctrl+C, then end the process tree; `--force` kills right away                 |
| `rm <task...>`               | Remove tasks and their output, stopping them first                            |
| `clear`                      | Remove every task that is no longer running                                   |
| `settings`                   | Show or change settings, e.g. `--stop-with-agent on`                          |
| `daemon start\|stop\|status` | Manage the background daemon                                                  |
| `mcp`                        | Serve the same tools over the Model Context Protocol (stdio)                  |

`run` also takes `-C <dir>`, `-t <title>`, `--agent <name>`, `--restart`, `--wait <seconds>`, and `--json`. A task
can be named by its id, its title, or a unique id prefix.

## For agents (MCP)

```sh
claude mcp add agenterm -- agenterm mcp
codex mcp add agenterm -- agenterm mcp
```

Any other agent: add `agenterm mcp` as a stdio MCP server. The tools match the CLI: `run`, `list`, `logs`, `input`,
`stop`, and `remove`. Output comes back as plain text with secrets redacted.

Agents can also just call the CLI. Either way, giving each command an id (`--id web`) is what keeps an agent from
starting the same server twice.

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
node scripts/stage-daemon.mjs --verify   # bundle the daemon, boot it under Electron's Node, drive a real terminal
npx electron-builder --dir               # unpacked app in release/
bun run dist                             # installers (dmg/zip, nsis, AppImage/deb)
```

Signing and notarization run when `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and
`APPLE_TEAM_ID` are set. Auto-update reads GitHub releases. Set `publish.owner` and `publish.repo` in
`apps/desktop/electron-builder.yml` once the repository has a home.
