# 02 — Architecture (daemon-first, TS)

## Principle

UI never owns PTYs. `agentermd` (Node daemon) owns them. Electron is a client.
Close the window → agents keep running. Reopen → attach.

```
                  +----------------+
                  |   agentermd    |  Node 22 plain process, Fastify + ws
                  | 127.0.0.1:37241|  single-flight lock
                  +-------+--------+
                          |
        +-----------------+------------------+
        |                 |                  |
  +-----+-----+    +------+------+    +------+------+    +------+------+
  | PTY mgr   |    | supervisor  |    | store       |    | harness    |
  | node-pty  |    | systeminfo  |    | sqlite+logs |    | overlay    |
  | per sess  |    | skinny then |    | ~/.agenterm |    | read-only  |
  |           |    | full poll   |    |             |    | flagged    |
  +-----+-----+    +------+------+    +------+------+    +------+------+
        |                 |                  |                  |
        +-----------------+------------------+------------------+
                          | event bus (mitt / tsup pub)
                          |
        +-----------------+------------------+
        |                 |                  |
 +------+------+   +-----+-------+   +--------+------+
 | Electron UI|   | CLI agenterm|   | future MCP/ACP|
 | React+xterm|   | commander   |   | stdio bridges |
 +-------------+   +-------------+   +---------------+
```

Two session paths: `spawn` (daemon owns PTY) and `attach` (discover existing
agent PIDs, join their process trees, stream via polling plus
permission-gated harness files where approved; no PTY takeover in initial scope).

## Processes (OS-level)

- `agentermd`: started on demand by Electron main OR `agenterm daemon --start`.
  Lock file `~/.agenterm/agentermd.lock` (pid + port + token hash). Second
  starter becomes client.
- `Electron main`: ensures daemon, opens window, quits window ≠ kills daemon.
  Explicit `Quit + Stop daemon` or `agenterm shutdown` kills tree.
- `CLI`: pure API client, never spawns PTYs directly.

## Data flow (terminal bytes)

```
Agent (claude/codex/...) stdout
  → node-pty master
  → ring buffer (last N KB in mem) + append to terminal.log
  → ws broadcast `terminal.output` (utf8 chunks with sequence numbers)
  → xterm.js write() + event recorder + full-text indexer (later step)
stdin: UI/CLI → POST /sessions/:id/input or ws `terminal.input` → pty.write()
resize: UI xterm onResize → POST /sessions/:id/resize {cols,rows}
```

No parsing of Claude output needed to render — real bytes, real renderer.
Semantic status (working/waiting) comes from harness files / OTEL overlay
(see `10-integrations-harness-acp.md`), never from TUI scraping, and is never
required to display.

## Event bus

Daemon-internal pub/sub + ws fan-out. Event shape in `04-data-model-events-api.md`.
UI subscribes `GET /events/stream` (ws). CLI can `agenterm logs --follow`.

## Failure modes

- Daemon crash → lock stale → next start detects dead pid, replays
  `sessions/` metadata, marks live sessions `crashed`, PTYs gone (resume hooks
  for supported harnesses arrive in the later agent-awareness step).
- Electron crash → daemon unaffected.
- Port taken → `get-port` fallback + write actual port to lock file; clients
  read lock file, not hardcoded port.
