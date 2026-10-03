/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

'use strict';

// electron-builder `afterPack` hook (runs before signing). The macOS Intel and Apple silicon apps
// are built by one runner, and that runner is arm64: `npm ci` there compiles ssh2's optional
// `sshcrypto.node` for arm64, and electron-builder's native rebuild only re-targets modules with a
// top-level binding.gyp (cpu-features), not the one nested inside ssh2. The x64 app therefore
// shipped an arm64-only Mach-O file, which fails scripts/verify-packages.mjs ("do not contain
// x86_64") and is exactly what breaks the x64 package while arm64 builds fine.
//
// Both modules are optional: ssh2 loads them in a try/catch and falls back to its pure JavaScript
// ciphers, and cpu-features is only a tuning hint. A native module that does not hold the target
// architecture is therefore removed instead of shipped, which is correct on any runner, whatever
// its own architecture.

const { spawnSync } = require('node:child_process');
const { existsSync, readdirSync, rmSync } = require('node:fs');
const { join } = require('node:path');

/** electron-builder's `Arch` enum values. */
const ARCH_NAMES = { 0: 'i386', 1: 'x86_64', 3: 'arm64' };
const OPTIONAL_NATIVE_MODULES = ['ssh2', 'cpu-features'];

const nodeFiles = (directory) => {
    const found = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) found.push(...nodeFiles(path));
        else if (entry.name.endsWith('.node')) found.push(path);
    }
    return found;
};

/** @param {{ electronPlatformName: string, arch: number, appOutDir: string, packager: { appInfo: { productFilename: string } } }} context */
async function afterPack(context) {
    if (context.electronPlatformName !== 'darwin') return;
    const wanted = ARCH_NAMES[context.arch];
    if (!wanted) return; // universal builds carry both architectures by design
    const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
    const unpacked = join(appPath, 'Contents', 'Resources', 'app.asar.unpacked', 'node_modules');
    for (const name of OPTIONAL_NATIVE_MODULES) {
        const directory = join(unpacked, name);
        if (!existsSync(directory)) continue;
        for (const file of nodeFiles(directory)) {
            const result = spawnSync('lipo', ['-archs', file], { encoding: 'utf8' });
            if (result.status !== 0) continue; // not a Mach-O file, or lipo is unavailable
            if (result.stdout.trim().split(/\s+/).includes(wanted)) continue;
            console.warn(
                `  • removing ${name} native module built for ${result.stdout.trim()}, not ${wanted}: ` +
                    `${file.slice(directory.length + 1)} (the pure JavaScript fallback is used)`,
            );
            rmSync(file, { force: true });
        }
    }
}

module.exports = { default: afterPack };
