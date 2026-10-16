## Install

**macOS app.** Download the DMG for your Mac below and drag agenterm into Applications (macOS 12 or later):

- Apple Silicon (M1 and later): `agenterm-{{version}}-arm64-mac.dmg`
- Intel: `agenterm-{{version}}-x64-mac.dmg`

If macOS says it could not verify agenterm, open **System Settings → Privacy & Security** and click **Open
Anyway**, or run `xattr -dr com.apple.quarantine /Applications/agenterm.app`.

The app includes the `agenterm` command and its MCP server. On first launch it offers to add the command to
`/usr/local/bin` (macOS asks for your password once), or later from **Settings → Connect an agent**. No Node.js
needed.

**CLI only** (Linux, or a Mac without the app; Node.js 22+):

```sh
npm install -g agenterm@{{version}}
```

**Updating.** From 0.4.0 on, the app offers each new version itself: **Update** in the title bar lists what
changed and installs it. The CLI updates with `npm install -g agenterm`; run `agenterm daemon restart` afterwards.

See the [README](https://github.com/entange/agenterm#readme) to connect Claude Code, Codex, and other agents.
