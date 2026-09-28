# 05 — UI/UX (Tailwind + shadcn + xterm.js)

## Philosophy

Activity Monitor × Linear × terminal. Not a VS Code clone.
Home screen answers in 3 seconds:

1. What is running? (N agents, N processes, N servers)
2. What needs me? (permission, failed, completed)
3. What is actually happening? (current command + last output line)

Production naming: no stage labels in UI copy. No "beta" badges, no version
tabs, no experimental ribbons unless a feature is genuinely hidden behind a
user-facing toggle with a plain-language name.

## Screens (initial scope plus the machine-truth demo)

- Dashboard: left lists Projects plus Agents (status dot from PTY truth plus
  harness overlay chip), right shows Overview counts plus Activity feed. Search
  filters sessions. A workspace-conflict badge appears when two or more
  sessions share a cwd.
- Discover view: lists running agent PIDs found via process matching with an
  Attach action per row. Attachment creates an `attached` session and requires
  explicit user approval naming the PID. Spawn is the secondary path.
- Agent detail: header with provider, title, status pill, overlay pill, cwd,
  branch chip, PID, origin chip, and actions. Tabs for Terminal, Activity,
  Processes (honest table in the demo step), and Ports.
- Terminal tab: single `XTermView` (xterm.js plus fit plus web-links), input box
  plus Send, Ctrl+C, Kill tree, Restart, Rename. Attached sessions show a
  read-only banner with the process tree and no PTY takeover in initial scope.
- New session modal: provider select (claude, codex, gemini, opencode,
  generic), command override, cwd picker with worktree root and branch preview,
  title. Warns when the cwd is already used by another session.

Later steps add full Processes, Commands, Git, and Files tabs, a cross-session
Live Activity screen, and searchable history.

## Component libs (no custom kit, all latest stable)

- `tailwindcss` plus shadcn/ui-style Radix primitives (Dialog, Tabs, Dropdown,
  Toast, Tooltip, ScrollArea) plus `lucide-react` icons.
- `zustand` for session selection plus WebSocket cache; `@tanstack/react-query`
  for REST reads; `@tanstack/react-table` for process and command tables when
  they arrive.
- `xterm.js`: one instance per open session tab, `fit` on resize via
  ResizeObserver, `web-links` for ports and paths, `search` addon for history
  when it arrives. Canvas renderer.

## XTerm ↔ daemon wiring

The model must implement and document verbosely:

- mount: fetch tail of scrollback, write into xterm, then subscribe to the
  WebSocket stream from the returned sequence number.
- unmount: unsubscribe and dispose locally; daemon keeps truth.
- input: throttled terminal data to daemon input endpoint or socket message.
- resize: debounced columns and rows post from the fit addon proposal.

Scrollback in UI is cosmetic; truth is `terminal.log` plus the daemon ring
buffer. Copy, paste, ligatures, and themes come from xterm options.
