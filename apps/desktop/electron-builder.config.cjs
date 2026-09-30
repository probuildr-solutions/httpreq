// Packages the desktop app. Main and preload are bundled by Vite except for ssh2 and ws, which
// stay external (they load optional native bindings at runtime) and are collected by
// electron-builder from the production dependencies; the web renderer build ships as a resource.
// Build first (`npm run build` at the repository root), then `npm run package:desktop`.

/** Electron is hoisted to the workspace root, so read the exact installed version from there. */
const electronVersion = require('electron/package.json').version;

/**
 * The version lives in the root package.json, the same one the web build reads, so the installer,
 * `app.getVersion()` and the version the renderer shows are always the same release.
 */
const { version } = require('../../package.json');

/**
 * A Developer ID certificate is available (CI passes it as CSC_LINK; locally CSC_NAME picks one
 * from the keychain). Without one the mac build is signed ad hoc, see `mac` below.
 */
const hasDeveloperId = Boolean(process.env.CSC_LINK || process.env.CSC_NAME);

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'dev.httpreq.desktop',
  productName: 'HttpReq',
  copyright: 'Copyright © 2026 Yamatri Reddy',
  electronVersion,
  extraMetadata: { version },
  directories: { output: 'release', buildResources: 'build' },
  // One naming scheme for every installer: no spaces (GitHub rewrites them in release asset names),
  // and the version and architecture are always visible, e.g. HttpReq-0.2.0-mac-arm64.dmg.
  artifactName: '${productName}-${version}-${os}-${arch}.${ext}',
  // Packages are attached to GitHub Releases by .github/workflows/desktop-packages.yml, never by
  // electron-builder itself, so it must not try to publish when it detects CI and a tag.
  publish: null,
  files: ['dist/**/*', 'resources/**/*', 'package.json', '!**/*.map'],
  extraResources: [{ from: '../web/dist', to: 'renderer', filter: ['**/*', '!**/*.map'] }],
  // Icons: build/icon.ico (Windows), build/icon.icns (macOS), build/icons/*.png (Linux).
  // Regenerate them from build/icon.svg with `npm run icons --workspace=@httpreq/desktop`.
  //
  // Code signing is optional and driven by environment variables, so unsigned builds work
  // everywhere and CI signs only when the repository has the secrets (see the workflow):
  //   Windows  WIN_CSC_LINK + WIN_CSC_KEY_PASSWORD     (.pfx as base64 or a path/URL)
  //   macOS    CSC_LINK + CSC_KEY_PASSWORD             (Developer ID Application .p12)
  //            APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID   (notarization)
  win: { icon: 'build/icon.ico', target: [{ target: 'nsis', arch: ['x64'] }] },
  nsis: {
    artifactName: '${productName}-Setup-${version}-${arch}.${ext}',
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'HttpReq',
    installerIcon: 'build/icon.ico',
    uninstallerIcon: 'build/icon.ico',
    installerHeaderIcon: 'build/icon.ico',
  },
  mac: {
    icon: 'build/icon.icns',
    category: 'public.app-category.developer-tools',
    // Intel and Apple silicon builds; the zip is what a future auto-updater would consume.
    target: [
      { target: 'dmg', arch: ['x64', 'arm64'] },
      { target: 'zip', arch: ['x64', 'arm64'] },
    ],
    // Signing. With a Developer ID certificate the app is signed with it and notarized (the
    // APPLE_* variables), which is the only way to open without any Gatekeeper prompt.
    //
    // Without one it is still signed, ad hoc (`identity: '-'`). That is not optional on Apple
    // silicon: packaging rewrites Electron's Info.plist and resources, which invalidates the
    // signature the prebuilt arm64 binaries ship with, and an arm64 app whose signature no longer
    // verifies is reported by macOS as "damaged and can't be opened" once it has been downloaded
    // (quarantined). electron-builder skipped signing entirely in that case, which is what shipped
    // broken arm64 apps. An ad hoc signature makes the bundle internally consistent, so macOS shows
    // the ordinary "unidentified developer" prompt (System Settings > Privacy & Security > Open
    // Anyway) instead. Notarization needs a Developer ID, so it is off for ad hoc builds.
    ...(hasDeveloperId ? {} : { identity: '-', notarize: false }),
    // Required for notarization only. The entitlements let Electron's V8 JIT run and load the
    // unsigned native modules that ssh2 ships (cpu-features, sshcrypto); an ad hoc signature
    // cannot satisfy library validation, so the hardened runtime is off there.
    hardenedRuntime: hasDeveloperId,
    gatekeeperAssess: false,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
  },
  dmg: { icon: 'build/icon.icns' },
  linux: {
    icon: 'build/icons',
    category: 'Development',
    executableName: 'httpreq',
    synopsis: 'Local-first API client',
    // Keeps the .desktop file named after package.json's desktopName, so docks match the window.
    syncDesktopName: true,
    target: [
      { target: 'AppImage', arch: ['x64'] },
      { target: 'deb', arch: ['x64'] },
    ],
  },
  // The .deb maintainer comes from the author in package.json. The npm name (@httpreq/desktop) is
  // not a valid Debian package name and would put the .deb in a nested release/@httpreq/ folder.
  deb: {
    packageName: 'httpreq',
    artifactName: 'httpreq_${version}_${arch}.${ext}',
  },
};
