## Install

**macOS app.** Download the DMG for your Mac below and drag agenterm into Applications (macOS 12 or later):

- Apple Silicon (M1 and later): `agenterm-{{version}}-arm64-mac.dmg`
- Intel: `agenterm-{{version}}-x64-mac.dmg`

If macOS says it could not verify agenterm, open **System Settings → Privacy & Security** and click **Open
Anyway**, or run `xattr -dr com.apple.quarantine /Applications/agenterm.app`.

**CLI and MCP server** (macOS and Linux, Node.js 22+):

```sh
npm install -g agenterm@{{version}} --allow-scripts=node-pty
```

Already running an older agenterm? Run `agenterm daemon restart` after updating.

See the [README](https://github.com/entange/agenterm#readme) to connect Claude Code, Codex, and other agents.
