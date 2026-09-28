# 07 — Security & privacy

Daemon can spawn/kill processes, write stdin, read all output. Treat as privileged.

## Defaults

- Bind `127.0.0.1` only. No `0.0.0.0`, no remote, no UPnP. Any OTEL sink added
  later is also localhost-only.
- Token auth: random 32 bytes on first start stored at `~/.agenterm/token`
  with `0600`. Every HTTP and WebSocket call requires
  `Authorization: Bearer`. Only Electron main and the CLI read the token file
  from disk as the same user. Never expose the raw token to renderer web
  content; the preload layer proxies daemon calls without forwarding it.
- CORS closed except the app protocol. `contextIsolation: true`,
  `nodeIntegration: false`, preload-only bridge.
- Kill semantics: deleting a session ends only that tree. Full daemon shutdown
  requires an explicit CLI or menu action plus UI confirmation. Attached
  sessions default to detach; killing an attached tree requires explicit
  `killTree: true` confirmation naming the PID.

## Agent-folder safety (hard rule)

`~/.claude`, `~/.codex`, OpenCode/Gemini state, and every existing agent
working directory are out of bounds until the user explicitly allows access:

1. Ask first, every time a new root is introduced. State exact absolute paths
   and whether access is read-only listing, log tailing, or full attach.
2. Default to read-only discovery. Listing a candidate PID is allowed;
   opening its logs, indexing its history, writing stdin, signalling, or
   killing requires separate approval.
3. Never delete, move, rewrite, reformat, "migrate", or "clean up" files in
   those folders. Never run destructive git commands there without explicit
   permission naming the command and directory.
4. Log every approved access (path, time, action) to the daemon log so the
   user can audit what touched their agents.

## Secrets

Terminal logs plus harness logs plus a privileged daemon are a local exfil
risk if handling slips. Treat all ingested logs and traces as untrusted input.

- Environment blocklist never stored: anything matching `*KEY*`, `*TOKEN*`,
  `*SECRET*`, `*PASSWORD*`, `DATABASE_URL`, `AWS_*`, `GH_*`, `OPENAI_*`,
  `ANTHROPIC_*`.
- Redaction on display and on export via pattern matching (examples the model
  must cover verbosely: `sk-...`, `ghp_...`, `xox...`, `Bearer ...`). Simple
  mask in initial scope, configurable patterns immediately after,
  `agenterm export --redact` default-on.
- `terminal.log` is local only, never uploaded. Default retention 30 days
  (`agenterm config set retentionDays N`). Harness overlay reads pass through
  the same redactor before events or database writes.

## Permissions (later)

Roles for future multi-client use: `observer` (read), `controller`
(input plus signal), `admin` (spawn, kill, shutdown). Initial scope is
single-user admin implicitly. Role names are production names, never stage labels.
