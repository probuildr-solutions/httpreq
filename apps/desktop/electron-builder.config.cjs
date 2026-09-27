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

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'dev.httpreq.desktop',
  productName: 'HttpReq',
  copyright: 'Copyright © 2026 Yamatri Reddy',
  electronVersion,
  extraMetadata: { version },
  directories: { output: 'release', buildResources: 'build' },
  files: ['dist/**/*', 'resources/**/*', 'package.json', '!**/*.map'],
  extraResources: [{ from: '../web/dist', to: 'renderer', filter: ['**/*', '!**/*.map'] }],
  // Icons: build/icon.ico (Windows), build/icon.icns (macOS), build/icons/*.png (Linux).
  // Regenerate them from build/icon.svg with `npm run icons --workspace=@httpreq/desktop`.
  win: { icon: 'build/icon.ico', target: 'nsis' },
  nsis: {
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
    target: ['dmg', 'zip'],
  },
  dmg: { icon: 'build/icon.icns' },
  linux: {
    icon: 'build/icons',
    category: 'Development',
    executableName: 'httpreq',
    synopsis: 'Local-first API client',
    target: ['AppImage', 'deb'],
  },
};
