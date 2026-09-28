# 04 — Data model, events, API (verbose specification, no stub schemas)

The implementing model must design complete verbose TypeScript types for every
row, request, response, and event below — every field, optional, default,
unit, index, and error case thought through and tested. Do not copy a minimal
stub from an example. Think: what does the UI need, what can be null, what
happens on daemon restart, what happens on malformed input.

## SQLite (better-sqlite3 + drizzle-orm) — `~/.agenterm/agenterm.db`

Database engine is embedded SQLite via better-sqlite3, accessed through
drizzle-orm, local-first. The model must create the full relational design
with foreign keys, indexes on session and time lookups, and retention pruning:

- machines: one row per host. Verbose identity the model defines: stable id,
  hostname, platform and architecture, first-seen and last-seen timestamps.
- projects: named grouping with a root path on that machine. The model must
  decide how roots are registered (explicit add vs inferred from session cwd)
  and how renames are handled.
- workspaces: a concrete checkout or working directory inside a project. Must
  carry the absolute cwd, the detected worktree root, branch, and dirty state
  semantics the model defines.
- agents: a configured agent definition per workspace. Provider is one of
  `claude`, `codex`, `gemini`, `opencode`, or `generic`. Must carry display
  name, exact command plus argument list, environment overrides (minus the
  secrets blocklist), and creation time. Generic entries must support any
  binary with full fidelity.
- sessions: the central row. Must carry owning agent, provider, human title,
  cwd, worktree root, branch, origin (`spawned` means daemon owns the PTY,
  `attached` means adopted an existing PID with no PTY takeover), exact
  command line, OS pid, lifecycle status, best-effort overlay status with its
  source, terminal dimensions, start time, end time, and exit code. The model
  must define the full lifecycle and the rule that overlay never overrides
  PTY/process exit truth.
- processes: polled snapshots of the session subtree. The model must define
  pid, parent pid, full command, cwd where knowable, CPU percent, RSS memory,
  start and end times, exit code, and sample time, plus the cap and pruning
  policy (for example keep the most recent day of samples, aggregate older).
- commands: higher-level command records derived later. The model must define
  command text, cwd, pid, start time, duration, exit code, and output line
  count, and must document that the initial scope ships raw terminal only with
  no fake parsing.
- events: the append-only feed backing the Activity views. The model must
  define id, session, typed event name, JSON payload, and creation time, with
  a cap policy and full-text search over payloads when history search arrives.

Files on disk per session:

```
~/.agenterm/
  agenterm.db
  token
  agentermd.lock
  sessions/<session-id>/
    metadata.json
    terminal.log    # raw PTY bytes (append-only)
    events.jsonl    # mirror of events table for tail/debug
```

## Event envelope (verbose TypeScript in packages/core)

The model must write the complete discriminated union with documentation for
each variant: when it fires, who emits it, required vs optional fields, and
ordering guarantees. Required coverage:

- session lifecycle: created and exited with pid and exit code semantics.
- attach lifecycle: attached and detached with pid and origin
  (`spawned` vs `attached`).
- terminal stream: output chunks with monotonically increasing sequence numbers
  supporting `since_seq` resume, plus input echoes.
- process lifecycle: started and exited with pid and command.
- agent status overlay: status changes annotated with source
  (`pty`, `harness`, or `otel`), where harness/otel are best-effort.
- port lifecycle: opened and closed with port number and owning pid.
- workspace conflict: shared-cwd warning listing all involved session ids.

Lifecycle statuses the model must implement in full: the PTY/process truth
(`created`, `starting`, `running`, `exited`, `crashed`, `killed`) plus the
best-effort overlay set (`unknown`, `working`, `waiting_input`,
`waiting_permission`, `completed`, `failed`). Overlay defaults to `unknown`,
is redacted before storage, and never overrides exit truth.

## Daemon HTTP + WS (Fastify + ws, localhost only)

All routes localhost-bound with bearer-token auth. The model must specify
verbose request/response shapes, validation failures, status codes, and
idempotency for each:

- `GET /health` — liveness plus daemon version and uptime detail.
- `GET /sessions` — list with filters the model designs (provider, status, cwd).
- `POST /sessions` — spawn a new owned session. Body carries provider or custom
  command, argument list, cwd, title, terminal dimensions, optional env
  overrides. Must resolve the binary via login PATH, log the resolved path,
  and return a missing-binary error with install hint when absent.
- `POST /sessions/attach` — adopt an existing OS pid by number with optional
  title. Read-only tree join, default detach semantics, explicit approval
  required. Must validate the pid exists and looks like a known agent process.
- `GET /discover` — list running agent PIDs (`claude`, `codex`, `gemini`,
  `opencode` and configured generics) with pid, parent pid, command line, and
  cwd where resolvable. Candidates only; attachment is a separate approved step.
- `GET /sessions/:id` — full session detail including pids, ports, branch,
  origin, and overlay.
- `DELETE /sessions/:id` — end a session. Body flag selects detach vs kill-tree.
  Attached sessions default to detach; killing requires explicit confirmation.
- `POST /sessions/:id/input` — write bytes to the owned PTY stdin. Attached
  sessions without a PTY must reject with a clear error.
- `POST /sessions/:id/resize` — set terminal columns and rows with debounced
  UI calls.
- `POST /sessions/:id/signal` — send interrupt/terminate/kill to the session
  tree with explicit semantics per signal.
- `GET /sessions/:id/output` — paged scrollback with tail length and
  `since_seq` resume cursor.
- `GET /sessions/:id/processes` — skinny child-pid table first, full
  CPU/memory snapshots next.
- `GET /sessions/:id/ports` — listening ports joined back to owning pids.
- `GET /events/stream` — WebSocket fan-out of every event above with resume support.

Auth: `Authorization: Bearer <token>` where token is read from
`~/.agenterm/token` (`0600`, created on first daemon start). Only Electron main
and the CLI read it from disk. Never send the raw token to renderer web
content. No public listener, closed CORS.

MCP: thin stdio bridge in a later step over this HTTP API only
(`list_sessions`, `get_session`, `read_terminal`, `send_input`, `kill`).
ACP is a peer protocol, not the internal bus: an optional later ACP client may
attach to ACP-speaking agents. Never wrap ACP as internal transport.
See `10-integrations-harness-acp.md`.
