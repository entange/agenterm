# Releasing

One version covers the whole repo: the CLI on npm, the macOS app, and the daemon API they share.

Add a `## 0.2.0 · YYYY-MM-DD` section to `CHANGELOG.md` first: short lines about what a user sees, newest
version on top. The release notes and the app's update panel both show it, and the release fails without it.

```sh
node scripts/set-version.mjs 0.2.0      # every package.json and packages/core/src/version.ts
git commit -am "release: 0.2.0"
git tag v0.2.0
git push origin main v0.2.0
```

The tag starts `.github/workflows/release.yml`, which:

1. checks that the tag matches the version everywhere and that `CHANGELOG.md` has a section for it;
2. builds the macOS app for Apple Silicon and Intel, each with its own staged daemon, and boots that daemon once
   to make sure a real terminal starts;
3. creates the GitHub release with the DMGs and the zips, and the changelog section plus the install steps in
   `.github/release-notes.md` as its notes (`node scripts/release-notes.mjs 0.2.0` prints them);
4. publishes `apps/cli` to npm as `agenterm` through trusted publishing (below), skipping a version already there.

Bump `API_VERSION` in `packages/core/src/version.ts` as well when a client of the previous release would get wrong
answers or missing routes from the new daemon. CLIs and apps from other installs then replace an idle daemon or ask
for `agenterm daemon restart`.

## Repository secrets

All optional. Without them the release still succeeds, with an ad-hoc signed app.

| Secret                                                     | What it enables                                                                                                |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `MAC_CERTIFICATE_P12_BASE64`                               | Signing with a Developer ID Application certificate: `base64 -i cert.p12` of the exported certificate and key. |
| `MAC_CERTIFICATE_PASSWORD`                                 | The password of that `.p12`.                                                                                   |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | Notarization, so the app opens without the "could not verify" prompt. Needs the certificate as well.           |

## How the app updates

macOS's own updater (Squirrel) refuses ad-hoc signed apps, so `apps/desktop/electron/main/updater.ts` does it. Five
seconds after launch and every six hours it reads the repository's releases from the GitHub API. When one is newer,
it reads that tag's `CHANGELOG.md` for what changed, shows **Update** in the title bar, and notifies once if the app
is in the background. **Download and install** fetches `agenterm-<version>-<arch>-mac.zip`, checks it against the
sha256 GitHub lists for the asset, unpacks it with `ditto`, and checks its bundle id and version. **Restart to
update** quits, swaps the app bundle in place, and opens the new one; quitting does the same without reopening.
The daemon keeps running, so tasks do too. An app on the disk image, in a translocated copy, or in a folder it
cannot write to links to the release instead.

To try an update before releasing it, build two copies with different versions:
`npx electron-builder --mac dir --arm64 -c.extraMetadata.version=0.3.9` (copy `release/mac-arm64/agenterm.app`
somewhere writable) and `npx electron-builder --mac zip --arm64 -c.extraMetadata.version=0.4.0`. Serve `/releases`
(the API's JSON, with the zip's `browser_download_url`, `size`, and `digest: "sha256:…"`), `/v0.4.0/CHANGELOG.md`,
and the zip from a local server, then start the old copy isolated from your own app and daemon:

```sh
AGENTERM_UPDATE_SOURCE=http://127.0.0.1:8765 AGENTERM_DATA_DIR=/tmp/try/data AGENTERM_PORT=37390 \
  /tmp/try/agenterm.app/Contents/MacOS/agenterm --user-data-dir=/tmp/try/profile
```

Quit it (not Restart, which reopens the app without those variables) to install.

## npm

The CLI publishes without a token. npm trusts `release.yml` in this repository through trusted publishing, set up
once on npmjs.com: package `agenterm` → Settings → Trusted publisher → GitHub Actions, with user `entange`,
repository `agenterm`, and workflow `release.yml`. npm only offers this for a package that exists, so the very first
version is published by hand (below).

## Website

`apps/site` is agenterm.entange.com: a Vite page served as static assets by a Cloudflare Worker (`wrangler.jsonc`).
Deploy it by hand with `bun run deploy` in `apps/site` (after `bunx wrangler login`). `site.yml` deploys it on every
change to `apps/site` on main once the repository has two more secrets: `CLOUDFLARE_API_TOKEN`, a token from the
"Edit Cloudflare Workers" template, and `CLOUDFLARE_ACCOUNT_ID`. Without them it only builds.

The download buttons go through `/download/<arch>/<version>`, the one path the Worker (`worker/index.ts`) handles. It
adds a row to the `agenterm-site` D1 database (version, architecture, country, time) and redirects to the DMG on
GitHub. `bun run downloads` in `apps/site` prints the counts. A new table or column goes in `migrations/`;
`bun run deploy` applies migrations before deploying, and CI only deploys the code.

The page has no version to bump: its download links follow the latest GitHub release.

## Building locally

```sh
bun install && bun run build
cd apps/desktop
bun run dist          # release/agenterm-<version>-{arm64,x64}-mac.{dmg,zip}
```

Set `CSC_LINK` and `CSC_KEY_PASSWORD` (and the `APPLE_*` variables to notarize) to sign; otherwise the build is ad-hoc
signed. To publish the CLI by hand: `npm login`, then `npm publish --access public` in `apps/cli`.
