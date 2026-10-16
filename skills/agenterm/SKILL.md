---
name: agenterm
description: Start and manage long-running commands (dev servers, watchers, test loops, long builds) with agenterm so they keep running in a terminal the user can watch, and are never started twice. Use whenever a command does not exit on its own, or when you need to check on, read the output of, type into, or stop something you started earlier. Works through the agenterm MCP tools or the agenterm CLI.
---

# agenterm

agenterm runs commands in background terminals the user can see and type into from the agenterm app. Each command
becomes a task with an id. Use it instead of `&`, `nohup`, `tmux`, or a backgrounded shell for anything that keeps
running.

## When to use it

- Dev servers, `--watch` builds, test watchers, `docker compose up`, tunnels: anything that does not exit.
- A build or test run long enough that you want to check back on it instead of blocking.

Only those. Commands that finish on their own in seconds (`ls`, `pwd`, `cat`, `grep`, `git status`, `npm install`,
a single test run, a quick build) do not belong in agenterm. Run them directly in your own shell, as usual: wrapping
them adds a task the user has to clean up and hides nothing worth watching.

## Always give the task an id

Pick a short, stable id that says what it is: `web`, `api`, `worker`, `tests`, `storybook`. Use the same id every
time you start that thing.

The id is what prevents duplicates. If a task with that id is already running, `run` does not start a second one.
It returns the running task and says `already running`. That is success: the server is up, so use it.

Without an id, agenterm still dedupes the exact same command in the same folder, but an id is reliable across small
command changes and is easy to refer to later.

### Worktrees and other checkouts

Ids are shared by every agent and project on the machine, and an id matches whatever folder it was started in. Two
git worktrees that both use `web` collide: the second `run` gets the first one's server, running the other branch's
code. When you work in a worktree or a second checkout, name the id after it and pass its folder:

```sh
agenterm run --id feature-a-web -C ~/code/app-feature-a "npm run dev"
agenterm run --id feature-b-web -C ~/code/app-feature-b "npm run dev"
```

When `run` says `already running`, check that the folder it prints is the one you are working in before you use
that task. If it is not, pick a different id; don't `restart` a task another checkout is using.

## Tools

With the agenterm MCP server connected (tools named like `mcp__agenterm__run`), use the tools. Otherwise use the
CLI. They do the same things.

| Need                          | MCP tool                              | CLI                                   |
| ----------------------------- | ------------------------------------- | ------------------------------------- |
| Start, or reuse if running    | `run` with `command`, `id`, `cwd`     | `agenterm run --id web "npm run dev"` |
| See what is running           | `list`                                | `agenterm ls`                         |
| Read recent output            | `logs` with `id`, `lines`             | `agenterm logs web -n 200`            |
| Answer a prompt               | `input` with `id`, `text`             | `agenterm input web "y"`              |
| Stop (Ctrl+C, then the tree)  | `stop` with `id`                      | `agenterm stop web`                   |
| Replace a running task        | `run` with `restart: true`            | `agenterm run --id web --restart ...` |
| Remove a task and its output  | `remove` with `id`                    | `agenterm rm web`                     |

- Pass `cwd` as an absolute path to the project folder. The CLI uses the current folder; `-C <dir>` changes it.
- `run` waits about 2 seconds and returns the first output. Raise `wait_seconds` (CLI: `--wait`) for slow starts.
- A task can be named by its id, its title, or a unique prefix of its id.

## Workflow

1. Before starting something, check `list` (or `agenterm ls`) if you are not sure whether it is already running,
   possibly started by the user or another agent.
2. Start it with `run` and an id.
3. Read the result. `list` shows the ports a task is listening on. Use those instead of guessing a URL.
4. If it did not come up as expected, read `logs` before retrying. Do not start it again under a new id.
5. After changing config that needs a fresh process, use `restart`, not a second task.
6. Stop what you started when the work is done, unless the user wants it left running. Leave tasks the user or
   another agent started alone unless asked.

## Reading status

- `running`: alive. A server that printed its URL and keeps running is healthy, not stuck.
- `finished`: exited with code 0.
- `failed (exit N)` or `failed (SIGNAL)`: crashed or errored. Read `logs` to see why, fix the cause, then `run` with
  the same id. Running an id whose task has ended starts it fresh.
- `stopped`: someone stopped it.
- `lost (daemon restarted)`: the process was gone when the daemon came back. Start it again with the same id.

## Don't

- Don't start the same server under a different id to "make sure". Check `list` instead.
- Don't run long-lived commands in your own shell in the background; the user cannot see or stop them.
- Don't use `stop` with `force` unless a normal stop failed.
- Don't remove tasks you did not start; the user may still want their output.
