// Packaging for the agenterm desktop app.
//
// The daemon ships as a resource staged per architecture by
// scripts/stage-daemon.mjs and runs under Electron's Node with
// ELECTRON_RUN_AS_NODE.
//
// macOS signing: with a Developer ID certificate (CSC_LINK + CSC_KEY_PASSWORD,
// or one in the keychain named by CSC_NAME) the app is signed, and notarized
// when APPLE_API_KEY / APPLE_API_KEY_ID / APPLE_API_ISSUER or APPLE_ID /
// APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID are set. Without one it is
// ad-hoc signed, which Apple Silicon needs to run it at all; users then
// confirm the first launch once (see README).
const signed = Boolean(process.env.CSC_LINK || process.env.CSC_NAME);

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'com.entange.agenterm',
  productName: 'agenterm',
  copyright: 'Copyright © 2026 Entange',
  directories: { output: 'release', buildResources: 'resources' },
  files: ['out/**/*', 'package.json'],
  // Read by the updater: unsigned builds cannot install updates on macOS, so they only announce them.
  extraMetadata: { agenterm: { signed } },
  extraResources: [
    { from: 'build/daemon/${platform}-${arch}', to: 'agentermd' },
    { from: 'resources/icon.png', to: 'icon.png' },
    { from: 'resources/trayTemplate.png', to: 'trayTemplate.png' },
    { from: 'resources/trayTemplate@2x.png', to: 'trayTemplate@2x.png' }
  ],
  asar: true,
  npmRebuild: false,
  mac: {
    category: 'public.app-category.developer-tools',
    icon: 'resources/icon.png',
    target: [
      { target: 'dmg', arch: ['arm64', 'x64'] },
      { target: 'zip', arch: ['arm64', 'x64'] }
    ],
    artifactName: 'agenterm-${version}-${arch}-mac.${ext}',
    minimumSystemVersion: '12.0',
    hardenedRuntime: true,
    entitlements: 'resources/entitlements.mac.plist',
    entitlementsInherit: 'resources/entitlements.mac.plist',
    ...(signed ? {} : { identity: '-' })
  },
  linux: {
    icon: 'resources/icon.png',
    category: 'Development',
    target: ['AppImage', 'deb'],
    maintainer: 'Entange',
    artifactName: 'agenterm-${version}-${arch}.${ext}'
  },
  publish: { provider: 'github', owner: 'entange', repo: 'agenterm' }
};
