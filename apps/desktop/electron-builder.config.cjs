/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

// Packages the desktop app. Main and preload are bundled and minified by Vite except for ssh2 and
// ws, which stay external (they load optional native bindings at runtime) and are collected by
// electron-builder from the production dependencies; the web renderer build ships inside the same
// app.asar as the main process.
// Build first (`npm run build` at the repository root), then `npm run package:desktop`.
//
// What the package does to resist casual inspection and tampering:
//   - application code and the renderer live in one app.asar, never as loose files;
//   - the Electron fuses below disable the escape hatches (ELECTRON_RUN_AS_NODE, NODE_OPTIONS,
//     --inspect), turn on asar integrity validation and refuse to load code from anywhere but
//     the asar, so a modified or replaced file stops the app from starting;
//   - source maps are never shipped, and the main process is minified with mangled identifiers.
// None of this makes the code unreadable to a determined reader; it removes the easy routes.

/** Electron is hoisted to the workspace root, so read the exact installed version from there. */
const electronVersion = require('electron/package.json').version;

/**
 * The version lives in the root package.json, the same one the web build reads, so the installer,
 * `app.getVersion()` and the version the renderer shows are always the same release.
 */
const { version } = require('../../package.json');

const { describeMacSigning } = require('./scripts/mac-signing.cjs');
const afterSign = require('./scripts/after-sign.cjs').default;

/**
 * A Developer ID certificate is available (CI passes it as CSC_LINK; locally CSC_NAME picks one
 * from the keychain). Without one the mac build is signed ad hoc, see `mac` below. What else a
 * trusted macOS package needs (the installer certificate, notarization) is described, and
 * enforced, in scripts/mac-signing.cjs and docs/distribution.md.
 */
const hasDeveloperId = describeMacSigning(process.env).application;

/**
 * Set by the release workflow when it is publishing a release: the macOS build then fails rather
 * than producing an app or installer that is not signed with a Developer ID certificate.
 */
const requireSigning = process.env.HTTPREQ_REQUIRE_SIGNING === '1';

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
    // electron-builder itself (the package script passes `--publish never`). This block is what the
    // installed app's updater reads: it is written into the app as `app-update.yml`, and it makes
    // electron-builder emit the update metadata (`latest.yml`, `latest-mac.yml`, `latest-linux.yml`)
    // that the workflow uploads to the release beside the installers. The app finds a newer version
    // by reading that file from the latest GitHub Release, downloads it in the background, checks
    // its SHA-512 against the metadata and installs it on the next restart.
    publish: [
        { provider: 'github', owner: 'yamatrireddy', repo: 'httpreq', releaseType: 'release' },
    ],
    asar: true,
    // The renderer is copied into the asar as `renderer/`, which is where the main process loads it.
    files: [
        'dist/**/*',
        'resources/**/*',
        'package.json',
        '!**/*.map',
        { from: '../web/dist', to: 'renderer', filter: ['**/*', '!**/*.map'] },
    ],
    removePackageScripts: true,
    removePackageKeywords: true,
    // Runs right after the app is signed (and notarized, when credentials are present); fails a
    // Developer ID build that could not be notarized instead of letting it ship.
    afterSign,
    // Flipped on the Electron binary after it is copied, before it is signed.
    electronFuses: {
        // Flipping a fuse rewrites the Electron Framework binary, which invalidates the signature
        // the prebuilt arm64 binaries ship with, and Apple silicon kills (or reports as "damaged")
        // any arm64 code whose signature does not verify. Re-signing it ad hoc right after the
        // flip keeps the bundle valid even if the signing step that follows is skipped; a
        // Developer ID build then replaces that signature with the real one. A no-op off macOS.
        resetAdHocDarwinSignature: true,
        runAsNode: false,
        enableCookieEncryption: true,
        enableNodeOptionsEnvironmentVariable: false,
        enableNodeCliInspectArguments: false,
        enableEmbeddedAsarIntegrityValidation: true,
        onlyLoadAppFromAsar: true,
        loadBrowserProcessSpecificV8Snapshot: false,
        // The renderer is served from file:// (its IndexedDB data is keyed to that origin, so it
        // cannot move to a custom protocol without orphaning every user's workspaces); the fuse that
        // trims file:// privileges would break its module scripts, so it stays on.
        grantFileProtocolExtraPrivileges: true,
    },
    // Icons: build/icon.ico (Windows), build/icon.icns (macOS), build/icons/*.png (Linux).
    // Regenerate them from build/icon.svg with `npm run icons --workspace=@httpreq/desktop`.
    //
    // Code signing is optional and driven by environment variables, so unsigned builds work
    // everywhere and CI signs only when the repository has the secrets (see the workflow):
    //   Windows  WIN_CSC_LINK + WIN_CSC_KEY_PASSWORD     (.pfx as base64 or a path/URL)
    //   macOS    CSC_LINK + CSC_KEY_PASSWORD             (Developer ID Application .p12)
    //            CSC_INSTALLER_LINK + CSC_INSTALLER_KEY_PASSWORD   (Developer ID Installer .p12, for the .pkg)
    //            APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID   (notarization)
    // docs/distribution.md explains each, what a user sees without them, and how to check a build.
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
        // Intel and Apple silicon builds, each its own app (not one universal binary: the auto-updater
        // matches the download to the architecture by file name, a universal build doubles every
        // download, and nothing in the app needs a binary that runs on both).
        //   dmg  drag-and-drop install, the standard for a first install
        //   pkg  the native installer, for managed fleets and scripted installs (`installer -pkg`)
        //   zip  what the auto-updater downloads; never offered for a first install
        // They are built from the same signed app, in the same run.
        target: [
            { target: 'dmg', arch: ['x64', 'arm64'] },
            { target: 'pkg', arch: ['x64', 'arm64'] },
            { target: 'zip', arch: ['x64', 'arm64'] },
        ],
        // Signing. With a Developer ID certificate the app is signed with it, and notarized and
        // stapled when Apple credentials are present (the APPLE_* variables), which is the only
        // way to open without any Gatekeeper prompt. The DMG itself is not signed (see `dmg`).
        //
        // Without one it is still signed, ad hoc (`identity: '-'`). That is not optional on Apple
        // silicon: packaging rewrites Electron's Info.plist and resources, which invalidates the
        // signature the prebuilt arm64 binaries ship with, and an arm64 app whose signature no longer
        // verifies is reported by macOS as "damaged and can't be opened" once it has been downloaded
        // (quarantined). electron-builder skipped signing entirely in that case, which is what shipped
        // broken arm64 apps. An ad hoc signature makes the bundle internally consistent, so macOS shows
        // the "Apple could not verify" prompt (System Settings > Privacy & Security > Open Anyway)
        // instead, which is the best an app without an Apple Developer ID can do. Notarization needs a
        // Developer ID, so it is off for ad hoc builds.
        ...(hasDeveloperId ? {} : { identity: '-', notarize: false }),
        // A release must be Developer ID signed: fail the build rather than publish one that is not
        // (the workflow sets this for a release; see scripts/check-mac-signing.mjs).
        forceCodeSigning: requireSigning,
        // Required for notarization: Apple rejects an app without the hardened runtime. The
        // entitlements let Electron's V8 JIT run and load the native modules that ssh2 ships
        // (cpu-features, sshcrypto); an ad hoc signature cannot satisfy library validation, so the
        // hardened runtime is off there.
        hardenedRuntime: hasDeveloperId,
        gatekeeperAssess: false,
        entitlements: 'build/entitlements.mac.plist',
        entitlementsInherit: 'build/entitlements.mac.plist',
    },
    // The disk image holds the notarized, stapled app; Gatekeeper checks the app when it is opened
    // and finds the ticket stapled to it, with no network needed. The image is deliberately not
    // signed: a signed image would have to be notarized too, and stapling it afterwards changes its
    // bytes after electron-builder has already recorded its checksum in latest-mac.yml.
    dmg: { icon: 'build/icon.icns', sign: false },
    // The installer is signed with a Developer ID Installer certificate (CSC_INSTALLER_LINK in CI,
    // or the keychain locally) and notarized, which electron-builder does for it when the APPLE_*
    // credentials are present. An installer without that certificate is built unsigned.
    pkg: {
        // Installs into /Applications for every user, as a drag-and-drop install does.
        installLocation: '/Applications',
        // Always installs to the location above, never into a copy of the app found elsewhere on
        // disk, and replaces an older version in place instead of leaving its files behind.
        isRelocatable: false,
        overwriteAction: 'upgrade',
        // Refuses to install over a newer version.
        isVersionChecked: true,
        // The installer is for this Mac, not the user's home or a mounted volume.
        allowAnywhere: false,
        allowCurrentUserHome: false,
        allowRootDirectory: true,
    },
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
