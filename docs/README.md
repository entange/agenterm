# agenterm — docs index

Project: `agenterm` (folder name is source of truth).
Previous working name `AgentOS` is deprecated. Use `agenterm` everywhere:
daemon `agentermd`, CLI `agenterm`, data dir `~/.agenterm/`.

## Constraint (user-locked)

- TypeScript-only until proven needed. No Rust / Go / GPUI.
- Turborepo monorepo with Bun as the package manager (`bun install`, `bun run`, `bunx`).
- Always use the latest stable version of every dependency and tool at scaffold time
  (Bun, Node, Electron, React, Tailwind, libraries below). No pinned-old majors unless
  a latest-version breakage is proven, then document the exception.
- Desktop shell: Electron (primary) — Electrobun evaluated, deferred.
- UI: Tailwind + shadcn-style libs. No hand-rolled design system.
- Lib-first: prefer maintained libs over custom code for PTY, process info,
  DB, validation, logging, packaging.
- Production code only: never put version/stage labels (`v0`, `v1`, `beta`, `alpha`,
  `preview`, `next`) in code, UI strings, API paths, package names, or config keys.
  Build-order phases live in `08-mvp-roadmap.md` docs only and must not leak into the product.
- Agent-folder safety: before reading anything outside `~/.agenterm/` — especially
  `~/.claude`, `~/.codex`, OpenCode/Gemini state, or any existing agent working
  directory — the implementation must ask the user for permission first, state exactly
  which paths will be read or touched, and default to read-only. Never delete, move,
  rewrite, or "clean up" existing agent files or running sessions without explicit approval.

## Files

- `00-overview.md` — what we build, non-goals, thesis
- `01-stack-decision.md` — final TS stack + why Electron over Electrobun + version policy
- `02-architecture.md` — daemon-first architecture, processes
- `03-monorepo-structure.md` — Turborepo + Bun layout, apps/packages, scripts
- `04-data-model-events-api.md` — SQLite schema, events, HTTP/WS API (verbose, no stubs)
- `05-ui-ux.md` — screens, components, xterm.js integration
- `06-runtime-pty-process.md` — node-pty, supervisor, ports, git
- `07-security-privacy.md` — localhost-only, token, redaction, agent-folder safety
- `08-mvp-roadmap.md` — build order (docs-only phases, never in code) + acceptance
- `09-build-packaging-testing.md` — build, sign, update, test strategy (Bun)
- `10-integrations-harness-acp.md` — read-only harness overlay, OTEL sink, ACP client
