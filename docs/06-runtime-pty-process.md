# 06 — Runtime: PTY, supervisor, ports, git

## PTY (`node-pty` in packages/runtime, daemon-only, latest stable)

- `pty.spawn(file, args, { cwd, env, cols, rows, name })` per spawned session.
  Attached sessions have no PTY; daemon tracks PID plus children plus harness
  overlay. No PTY takeover in initial scope.
- Windows: ConPTY path (node-pty handles); test `cmd.exe` plus `powershell.exe`,
  expect scrollback and resize quirks; `wsl` later. Initial scope targets `cmd`
  fallback plus the user's shell.
- macOS GUI PATH: Electron main must forward the login `PATH` (shell
  `path_helper`, homebrew `/opt/homebrew/bin`, `~/.local/bin`) to daemon spawn
  env, else `claude` or `codex` resolve fails. Log the resolved binary path per
  session so missing-binary errors are actionable.
- Env: merge user env minus the secrets blocklist; always set
  `TERM=xterm-256color`, `AGENTERM=1`, `AGENTERM_SESSION_ID`.
- Exit: on exit with code and signal, update the session row, emit the exit
  event, keep the log. Initial kill-tree uses `tree-kill`; precise kill uses
  the supervisor-polled PID list once the skinny supervisor lands.
- Backpressure: in-memory ring (for example last 2MB) plus file append stream.
  Slow WebSocket consumers fall back to `since_seq` re-fetch and must never
  block the PTY.
- Production naming: no stage labels anywhere in code, logs, or terminal
  environment beyond the functional `AGENTERM*` keys above.

Agent adapters in initial scope (all via generic spawn, no transcript parsing):

- `claude` runs the `claude` binary with no forced args.
- `codex` runs the `codex` binary with no forced args.
- `gemini` runs the `gemini` binary with no forced args.
- `opencode` runs the `opencode` binary with no forced args.
- `generic` runs any user-supplied command with argument list.

The model must design verbose launch types for each: exact binary resolution,
argument defaults, cwd rules, env merge rules, and the missing-binary error
shape with install hint. No status inference from terminal bytes.

## Supervisor (skinny first, full later)

- Initial: store spawn pid, cwd, command, start, end, exit only, plus the
  `GET /discover` candidate list via process-name matching for known agent binaries.
- Skinny supervisor next (the demo that sells the product): poll with
  `systeminformation` on a 1s interval scoped to session subtrees. Build
  session pid to child pid mapping, join `networkConnections()` listening
  sockets back to owning pids, emit port opened/closed events. Ports view shows
  port to pid to session plus an action opening `http://localhost:port`.
  Processes view is an honest ugly-but-true table. `killTree` uses the polled
  PID list. Background `npm run dev` becomes visible here because it is a
  child of the session pid.
- Full supervisor later: CPU and memory snapshots, bounded retention with
  pruning (for example keep one day of fine samples), full-text history,
  notifications.

## Git + files (worktree-aware; branch chip early, watchers later)

- Early: show `branch` plus `worktreeRoot` chip per session via
  `simple-git(cwd)` rev-parse only, plus shared-cwd warning. No watchers yet.
- Later: full status and diff stats plus `chokidar` watch with heavy ignores
  (`node_modules`, `.git`, `dist`): debounced `file.changed` events feeding
  lines like "Claude modified src/auth.ts". The product is not a worktree
  manager: create-in-worktree is a `git worktree add` passthrough plus label only.

## Command tracking (later)

Shell integration comes later. The later heuristic clusters process starts and
matches shell prompts to build command rows with duration, exit, and output
line counts. Initial scope ships raw terminal only with no fake parsing.

## Agent-folder safety (hard rule, repeated deliberately)

Discovery may list candidate PIDs and paths, but before opening, reading,
tailing, or indexing anything under `~/.claude`, `~/.codex`, OpenCode or
Gemini state, or any existing agent checkout, the daemon and CLI must stop and
ask the user for permission with exact paths and reasons. Read-only by default.
Never delete, move, rewrite, or reformat those files. Never kill an attached
PID or run destructive git/filesystem commands there without a second explicit
confirmation naming the PID or command.
