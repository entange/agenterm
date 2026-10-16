# agenterm

Run dev servers, watchers, builds, and tests in terminals that you and your coding agents can watch, type into,
and stop. Each command gets an id, so an agent never starts the same server twice.

```sh
npm install -g agenterm

agenterm run --id web "npm run dev"    # start it (or get the one already running)
agenterm ls                            # what is running, with ports
agenterm logs web -f                   # follow its output
agenterm stop web                      # Ctrl+C, then end it
```

Or without installing: `npx agenterm ls`.

Tasks keep running in a small background daemon after the terminal or agent that started them exits. The
[agenterm desktop app](https://github.com/entange/agenterm/releases/latest) shows every task as a live terminal. On a
Mac it also includes this CLI and adds the `agenterm` command for you, so you do not need this package as well.

## For agents (MCP)

```sh
claude mcp add --scope user agenterm -- agenterm mcp   # Claude Code
codex mcp add agenterm -- agenterm mcp                 # Codex
```

Other agents (Cursor, Claude Desktop, …) take this in their MCP config:

```json
{ "mcpServers": { "agenterm": { "command": "agenterm", "args": ["mcp"] } } }
```

Without a global install, use `"command": "npx", "args": ["-y", "agenterm", "mcp"]`.

The tools match the CLI: `run`, `list`, `logs`, `input`, `stop`, `remove`, `processes`, and `kill`.

## Commands

| Command                              | What it does                                                          |
| ------------------------------------ | --------------------------------------------------------------------- |
| `run [--id ID] "<command>"`          | Start a command in a new terminal, or return the one already running  |
| `ls [--running] [--json]`            | List tasks, running first                                             |
| `show <task>`                        | One task in detail                                                    |
| `logs <task> [-n N] [-f]`            | Recent output; `-f` keeps printing until it ends                      |
| `input <task> <text>`                | Type into a task, then press Enter (unless `--no-enter`)              |
| `stop <task...> [--force]`           | Ctrl+C, then end the process tree; `--force` kills right away         |
| `rm <task...>`                       | Remove tasks and their output, stopping them first                    |
| `clear`                              | Remove every task that is no longer running                           |
| `ps [--orphaned] [--json]`           | Commands running outside agenterm: in terminals, under agents, orphaned |
| `kill <pid...> [--force]`            | End a command from `ps` and everything under it                       |
| `settings`                           | Show or change settings, e.g. `--stop-with-agent on`                  |
| `daemon start\|stop\|restart\|status` | Manage the background daemon                                          |
| `mcp`                                | Serve the same tools over the Model Context Protocol (stdio)          |

## Requirements

- macOS or Linux (x64 or arm64; on Linux, glibc rather than musl, so not Alpine), Node.js 22 or newer. Everything
  installs prebuilt: nothing compiles, and npm runs no install scripts.
- Installed with a different version than the daemon already running? `agenterm daemon restart` swaps it (the CLI
  does this by itself when nothing is running).

Data lives in `~/.agenterm/`. The daemon listens on `127.0.0.1` only and every request needs a token stored there.

MIT licensed. Website: <https://agenterm.entange.com>. Source, issues, and the desktop app:
<https://github.com/entange/agenterm>.
