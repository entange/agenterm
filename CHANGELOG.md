# Changelog

Every release, newest first. The app shows these when an update is available.

## 0.4.0 · 2026-10-17

- The app updates itself: when a new version is out, an **Update** button lists what changed, downloads it, and
  restarts into it. Running tasks keep running.
- `agenterm ps` and the app's **Outside** tab list commands agenterm did not start: in other terminals, under
  agents, or orphaned after their terminal or agent exited. `agenterm kill <pid>` ends one and everything under it.
- **Move to agenterm** restarts an outside command as a task, so you can watch its output and type into it.
- A notification says when a command is left running after its terminal or agent exits.
- Hide programs you keep running on purpose, like `cloudflared`: `agenterm ps --hide cloudflared`, or Hide in the
  app.
- Agents get `processes` and `kill` MCP tools to find what holds a port or what was left behind.
- `npm install -g agenterm` installs prebuilt on macOS and Linux, x64 and arm64, with nothing to compile.
- Ports show on Linux without `lsof`.

## 0.3.2 · 2026-10-15

- The app keeps its data under `agenterm` rather than `agenterm-desktop`.

## 0.3.1 · 2026-10-15

- The app includes the `agenterm` command and offers to add it to `/usr/local/bin`, so Node.js is not needed.
- Ambiguous task names list their matches in a stable order.

## 0.3.0 · 2026-10-14

- First release: a daemon that runs dev servers and watchers in real terminals, the `agenterm` CLI and MCP server
  for agents, and a macOS app to watch, type into, and stop them.
