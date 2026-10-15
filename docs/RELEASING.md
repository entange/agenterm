# Releasing

One version covers the whole repo: the CLI on npm, the macOS app, and the daemon API they share.

```sh
node scripts/set-version.mjs 0.2.0      # every package.json and packages/core/src/version.ts
git commit -am "release: 0.2.0"
git tag v0.2.0
git push origin main v0.2.0
```

The tag starts `.github/workflows/release.yml`, which:

1. checks that the tag matches the version everywhere;
2. builds the macOS app for Apple Silicon and Intel, each with its own staged daemon, and boots that daemon once
   to make sure a real terminal starts;
3. creates the GitHub release with the DMGs, the zips, their blockmaps, and `latest-mac.yml` (the app's updater
   reads it);
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

Signed builds also install updates by themselves when the app quits. Ad-hoc signed builds cannot, because macOS
refuses to replace them, so the app shows a notification that links to the new release instead.

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

The page has no version to bump: its download links follow the latest GitHub release.

## Building locally

```sh
bun install && bun run build
cd apps/desktop
bun run dist          # release/agenterm-<version>-{arm64,x64}-mac.{dmg,zip}
```

Set `CSC_LINK` and `CSC_KEY_PASSWORD` (and the `APPLE_*` variables to notarize) to sign; otherwise the build is ad-hoc
signed. To publish the CLI by hand: `npm login`, then `npm publish --access public` in `apps/cli`.
