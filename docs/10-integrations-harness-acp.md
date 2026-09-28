# 10 — Harness integrations, OTEL, ACP (read-only overlay)

Rule: PTY bytes plus process tree are truth. Everything here is a best-effort
overlay status that may return `unknown`. Never gate display or kill on it.
No stage labels in code. Verbose types the model designs must cover every
parse outcome including version mismatch.

## Adapters (`packages/runtime/src/adapters/`, behind `AGENTERM_HARNESS_WATCH`)

Each adapter implements three verbose responsibilities the model must design:
`detect` (is this pid/cwd one of mine), `watch` (efficient tail without
hammering disk), and `parse` (bytes to overlay status plus redacted summary).

- `claude.ts`: reads `~/.claude/projects/**/*.jsonl` plus hooks events. Lenient
  runtime validation with pinned fixture tests per harness version. Maps
  permission prompts to `waiting_permission` and idleness to
  `completed`/`waiting_input` heuristically, always falling back to `unknown`.
- `codex.ts`: reads the Codex sessions directory or sqlite store. Same lenient
  pattern: open read-only, copy WAL databases before reading, `unknown` on
  any mismatch.
- `opencode.ts`: reads the local sqlite store read-only with the same guards.
- `gemini.ts`: harness log location unpinned — ship `unknown` until a real
  path and schema are confirmed with the user. Never guess and never write.

Churn guard: per-harness supported-version list, fixture tests in `vitest`,
parse failure emits `overlay_status: unknown` and never throws into the event
bus. Flag off means zero file reads outside `~/.agenterm/`.

## Agent-folder permission rule (hard rule, repeated deliberately)

Harness file paths churn and live next to live agent state. Before the daemon
or CLI opens, tails, or indexes anything under `~/.claude`, `~/.codex`,
OpenCode/Gemini state, or an existing checkout, it must ask the user for
permission with exact paths and purpose, default to read-only, and log the
grant. Never delete, move, rewrite, or reformat those files. This rule
overrides any adapter convenience.

## OTEL (later step, sink-only, localhost)

Claude Code OTEL data is accepted at a localhost collector endpoint such as
`http://127.0.0.1:4318/v1/*` handled by the daemon purely as a sink. Trace and
span attributes are joined to `sessionId` for overlay status only. No remote
export, no SaaS, same redactor as logs. Disabled by default until the later
observability step.

## ACP (optional later client)

The Zed Agent Client Protocol with `terminal/*` methods is a peer protocol.
`agenterm` may add an ACP client to attach to ACP-speaking agents and later
expose terminal creation to them. The internal bus stays localhost HTTP plus
WebSocket. No ACP transport inside the daemon in early steps.

## MCP (later)

Thin stdio bridge over the HTTP API only: session listing, session detail,
terminal read, input send, and kill. The model must design each tool's verbose
input/output contract with redaction applied.
