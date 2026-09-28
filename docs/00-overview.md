# 00 — Overview

## One sentence

> A local control center that gives developers complete visibility and control
> over every AI agent, terminal, process, command, and workspace on their machine.

Not another terminal multiplexer. An observability / control layer on top of PTYs.

## Problem (from PRD)

Agent says "I'll run the tests" — developer doesn't know:

- which process ran, where, in what cwd / shell
- if it's still running, if children are alive
- if agent is waiting / failed silently / started a server
- what the terminal actually showed, how to reconnect

With N agents in N terminals, the developer becomes the orchestrator.

## Thesis

```
Human
  ↓
Agent (Claude / Codex / Gemini / OpenCode / generic CLI)
  ↓
Shell → Process
```

AI inserted a layer and removed visibility. `agenterm` reinserts:

```
Human
  ↓
agenterm Control Center (agents, terminals, processes, files, git, events)
  ↓
Machine
```

## Core model

```
Machine
  └── Project
       └── Workspace
            └── Agent
                 └── Session
                      ├── PTY
                      ├── Processes
                      ├── Commands
                      ├── Events
                      ├── Files
                      ├── Git
                      └── Logs
```

## Non-goals

- No AI model, no orchestration engine, no prompt editor
- No code editor, no cloud hosted service or cloud control plane
- No remote execution by default (protocol must allow it later)
- No worktree manager, no kanban / task claiming / mobile handoff,
  no prompt queues, no token-billing headline UI, no marketplace
- No fleet orchestration. We own "what is this process doing to my machine",
  not "we orchestrate your fleet".

## Category positioning

Three layers got conflated. `agenterm` is only the third:

- Traces / cost (tokens, tools, dollars): Agent Trail, Langfuse, OTEL viewers — not us.
- Orchestration (N agents, worktrees, kanban, handoff): Claude Squad, Conductor,
  Vibe Kanban, Omnara — not us.
- Machine control (which PTY, which children, which port, kill tree, reattach):
  still thin — this is `agenterm`.

Keep: "Not another terminal multiplexer. An observability / control layer on top of PTYs."

## Platform

Runtime (`packages/runtime` plus `apps/cli`): macOS plus Windows plus Linux/WSL
from the first cut, code-wise. Bun plus Node-compatible code is portable; the
daemon must never depend on Electron. GUI packaging (`apps/desktop`): macOS
plus Windows first, Linux GUI later.
