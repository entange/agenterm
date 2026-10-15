# 09 — Build, packaging, testing (Bun, latest stable)

Package manager is Bun everywhere. The model must resolve latest stable at
execution time and record exact versions in `bun.lock` and the commit message.

## Dev

```bash
bun install
bun run dev          # turbo: runtime (watch) + electron (vite)
bun run dev:daemon   # packages/runtime only :37241
bun run dev:desktop  # electron-vite only (attaches to running daemon)
bun run typecheck && bun run lint && bun run test
```

Bun as package manager plus the latest stable Node-compatible runtime for the
daemon (`engines` plus `.nvmrc` or `.node-version` as the model judges best).
Native modules (`node-pty`, `better-sqlite3`) load in the daemon plain process
only — never renderer or Electron main. electron-builder still needs a rebuild
step for the bundled ABI; the model must test the packaged daemon path, not
just `bun run dev`.

Known time sinks the model must budget for: native rebuilds, macOS GUI PATH
forwarding, ConPTY resize and scrollback quirks, lock-file races (stale pid,
port fallback read from lock file), `systeminformation` polling cost (keep the
interval at 1s and scope queries to session subtrees).

## Packaging (electron-builder, latest stable)

As built: the macOS app (`dmg` plus `zip`, arm64 plus x64) and the CLI on npm. Windows is not
shipped. See `RELEASING.md` for the release flow. The app's `Resources/agentermd/` holds the daemon,
the CLI (`cli/`), and `bin/agenterm`, a script that runs that CLI on the app's Electron as Node. The
app links `/usr/local/bin/agenterm` to it (asking for an administrator password when needed), so a
Mac needs no Node.js or npm.

- macOS: `dmg` plus `zip` (arm64 plus x64), hardened runtime, notarize.
- Windows: `nsis` (x64), signed.
- Daemon ships inside Electron resources (`resources/agentermd/`) plus a
  standalone `agenterm` CLI binary. First run spawns the bundled daemon entry.
  The model chooses the exact bundling layout and documents it verbosely.
- Auto-update from GitHub Releases via the updater plugin; manual download is
  acceptable in the earliest cut but the model must not leave dead update code.

## Testing

The model must design verbose test coverage, including at least:

- Unit and API tests with `vitest`: shared-type validation, ring buffer and
  sequence resume, redaction utility, lock and port fallback, Fastify route
  tests via injection, adapter parsers with fixture logs per harness version
  proving mismatch yields `unknown` instead of throwing.
- Smoke test with `playwright` (or the Electron test harness): launch daemon,
  spawn an echo session, attach to a stub PID, assert output streams plus
  resize plus kill-tree freeing the port.
- Manual matrix: macOS zsh plus Windows cmd and powershell crossed with
  claude, codex, and generic spawn plus attach; kill-tree frees port; reopen
  restores scrollback.
- CI: GitHub Actions `macos-latest` plus `windows-latest` for GUI and
  packaging, `ubuntu-latest` for daemon plus CLI only.
- Gate: API plus PTY lifecycle plus attach and discover tests green. No
  coverage-percentage gate initially.

## Agent-folder safety in tests

Tests must never touch the real `~/.claude`, `~/.codex`, or live agent
checkouts. All adapter tests use fixtures under the repo. Any manual
verification against real agent folders requires the user's explicit
permission first.

## Next scaffold step

Using Bun: resolve latest `create-turbo`, `electron-vite` template pieces,
and every library in `01-stack-decision.md`, then scaffold
`apps/desktop`, `apps/cli`, and `packages/{core,runtime,ui,config}` with the
pipeline from `03-monorepo-structure.md`. No Rust toolchain needed. No stage
labels in any generated name.
