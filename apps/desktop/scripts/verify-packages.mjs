/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

// Checks a platform's packages before they are uploaded, so a broken or mislabelled build fails
// its job instead of reaching a release. Run after `npm run package:desktop`:
//
//   node apps/desktop/scripts/verify-packages.mjs <win|mac|linux>
//
// It fails unless every expected installer exists, is not empty and is named for the current
// version, and unless every packaged app (app.asar) reports that same version, which is what
// `app.getVersion()` returns at runtime. It also fails if a packaged app.asar is missing its
// bundled renderer or contains source maps, or if the Electron binary's security fuses are not
// the ones the build asked for. On macOS it also checks the signature of every app and installer
// (see the macOS section below). It then writes SHA256SUMS-<platform>.txt beside them.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';
import {
    appendFileSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const desktop = join(dirname(fileURLToPath(import.meta.url)), '..');
const release = join(desktop, 'release');
const { version } = JSON.parse(readFileSync(join(desktop, '..', '..', 'package.json'), 'utf8'));
const v = version.replace(/[.+]/g, '\\$&');

/** Every installer each platform must produce; electron-builder.config.cjs sets these names. */
const expected = {
    win: [new RegExp(`^HttpReq-Setup-${v}-x64\\.exe$`)],
    mac: ['x64', 'arm64'].flatMap((arch) => [
        new RegExp(`^HttpReq-${v}-mac-${arch}\\.pkg$`),
        new RegExp(`^HttpReq-${v}-mac-${arch}\\.zip$`),
    ]),
    linux: [
        new RegExp(`^HttpReq-${v}-linux-(x86_64|x64)\\.AppImage$`),
        new RegExp(`^httpreq_${v}_amd64\\.deb$`),
    ],
};

/** The metadata the installed app's updater reads from the release; it must name this version. */
const updateMetadata = { win: 'latest.yml', mac: 'latest-mac.yml', linux: 'latest-linux.yml' };

const platform = process.argv[2];
if (!expected[platform]) {
    console.error(`Usage: verify-packages.mjs <${Object.keys(expected).join('|')}>`);
    process.exit(2);
}

const errors = [];
const files = readdirSync(release).filter((name) => statSync(join(release, name)).isFile());
const packages = expected[platform].map((pattern) => {
    const name = files.find((file) => pattern.test(file));
    if (!name) errors.push(`Missing package matching ${pattern} in ${release}.`);
    else if (statSync(join(release, name)).size === 0) errors.push(`${name} is empty.`);
    return name;
});

// Without its update metadata a release cannot be installed over by the app's auto-updater.
const metadataName = updateMetadata[platform];
if (!files.includes(metadataName)) {
    errors.push(`Missing update metadata ${metadataName} in ${release}.`);
} else {
    const metadata = readFileSync(join(release, metadataName), 'utf8');
    if (!new RegExp(`^version: ['"]?${v}['"]?\\s*$`, 'm').test(metadata)) {
        errors.push(`${metadataName} does not report version ${version}.`);
    }
    for (const name of packages.filter(Boolean)) {
        // The deb and pkg are for first installs; only the files the updater downloads are listed.
        if (/\.(exe|zip|AppImage)$/.test(name) && !metadata.includes(name.replaceAll(' ', '-'))) {
            errors.push(`${metadataName} does not list ${name}.`);
        }
    }
}

// The version baked into each packaged app.
const { extractFile, listPackage } = require('@electron/asar');
const findAsars = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        if (entry.isFile() && entry.name === 'app.asar') return [path];
        return entry.isDirectory() && !entry.isSymbolicLink() ? findAsars(path) : [];
    });
const asars = findAsars(release);
if (asars.length === 0) errors.push('No packaged app.asar found to check the app version.');
for (const asar of asars) {
    const packaged = JSON.parse(extractFile(asar, 'package.json').toString('utf8')).version;
    if (packaged !== version) {
        errors.push(`${relative(release, asar)} reports version ${packaged}, expected ${version}.`);
    }

    // The renderer ships inside the asar (so the integrity check covers it), and source maps
    // never ship at all.
    const entries = listPackage(asar, { isPack: false }).map((entry) =>
        entry.replaceAll('\\', '/'),
    );
    if (!entries.some((entry) => entry.endsWith('/renderer/index.html'))) {
        errors.push(`${relative(release, asar)} does not contain the bundled renderer.`);
    }
    const maps = entries.filter((entry) => entry.endsWith('.map'));
    if (maps.length > 0) {
        errors.push(`${relative(release, asar)} contains source maps, e.g. ${maps[0]}.`);
    }
}

// The Electron fuses are what stop the packaged app from being started in a debuggable, patchable
// way. Read them back from the unpacked binary rather than trusting the build configuration.
const { getCurrentFuseWire, FuseV1Options } = require('@electron/fuses');
const EXPECTED_FUSES = {
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
};
const ENABLED = 49; // ASCII '1' in the fuse wire; '0' (48) is disabled, 'r' (114) is removed.
const findExecutables = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        if (!entry.isDirectory() || entry.isSymbolicLink()) return [];
        if (entry.name === 'win-unpacked') return [join(path, 'HttpReq.exe')];
        if (entry.name === 'linux-unpacked') return [join(path, 'httpreq')];
        if (entry.name.startsWith('mac'))
            return [join(path, 'HttpReq.app', 'Contents', 'MacOS', 'HttpReq')];
        return [];
    });
for (const executable of findExecutables(release)) {
    let wire;
    try {
        wire = await getCurrentFuseWire(executable);
    } catch {
        continue; // Not produced on this platform (a mac folder on a Windows runner, say).
    }
    for (const [fuse, expected] of Object.entries(EXPECTED_FUSES)) {
        const enabled = wire[fuse] === ENABLED;
        if (enabled !== expected) {
            errors.push(
                `${relative(release, executable)}: fuse ${FuseV1Options[fuse]} is ${enabled ? 'on' : 'off'}, expected ${expected ? 'on' : 'off'}.`,
            );
        }
    }
}

// The Debian control file carries its own version field.
const deb = packages.find((name) => name?.endsWith('.deb'));
if (deb) {
    const debVersion = execFileSync('dpkg-deb', ['--field', join(release, deb), 'Version'], {
        encoding: 'utf8',
    }).trim();
    if (debVersion !== version)
        errors.push(`${deb} has Version ${debVersion}, expected ${version}.`);
}

// macOS: an app whose signature does not verify is reported as "damaged" once downloaded, an
// arm64 app must contain arm64 code, and an app that is not signed with a Developer ID certificate
// and notarized is met with "Apple could not verify ..." on first open. Check what the user will
// actually install: the app inside every zip, and every pkg (expanded), for the
// architecture its file name claims, and the pkg's own signature and notarization.
//
// Whether the build was meant to be trusted is read from the packages, not from the environment
// (this step does not hold the certificates): a Developer ID signature is fully checked, an ad hoc
// one is reported. HTTPREQ_REQUIRE_SIGNING=1, which the release workflow sets, makes an ad hoc or
// unsigned package an error, so a release can never contain one by accident.
if (platform === 'mac') {
    const archNames = { x64: 'x86_64', arm64: 'arm64' };
    const requireSigning = process.env.HTTPREQ_REQUIRE_SIGNING === '1';

    /** Runs a tool and returns what it printed, whatever stream it chose, and whether it succeeded. */
    const inspect = (command, args) => {
        const result = spawnSync(command, args, { encoding: 'utf8' });
        return { ok: result.status === 0, text: `${result.stdout ?? ''}${result.stderr ?? ''}` };
    };

    /**
     * Every Mach-O file in the app (helpers, frameworks and the native `.node` modules) must hold the
     * architecture the package is for. A module built for the build machine instead of the target,
     * easy to get when one runner builds both Intel and Apple silicon, either fails to load or makes
     * the signature check disagree with the executable, and is a plausible reason for an app that
     * works for one architecture only.
     */
    const checkMachOArchitectures = (label, appPath, arch) => {
        const wanted = archNames[arch];
        const wrong = [];
        for (const entry of readdirSync(appPath, { recursive: true, withFileTypes: true })) {
            if (!entry.isFile()) continue;
            const path = join(entry.parentPath ?? entry.path, entry.name);
            if (!/\.(node|dylib|so)$/.test(entry.name) && !path.includes('/Contents/MacOS/')) {
                const folder = path.includes('.framework/Versions/') || path.includes('/Helpers/');
                if (!folder) continue;
            }
            const archs = inspect('lipo', ['-archs', path]);
            if (!archs.ok) continue; // not a Mach-O file
            if (!archs.text.trim().split(/\s+/).includes(wanted)) {
                wrong.push(`${relative(appPath, path)} (${archs.text.trim()})`);
            }
        }
        if (wrong.length > 0) {
            errors.push(
                `${label}: ${wrong.length} file(s) do not contain ${wanted}: ${wrong.slice(0, 8).join(', ')}`,
            );
        }
    };

    const checkApp = (label, appPath, arch) => {
        const verified = inspect('codesign', [
            '--verify',
            '--deep',
            '--strict',
            '--verbose=2',
            appPath,
        ]);
        if (!verified.ok) {
            errors.push(
                `${label}: the app's code signature is invalid, so macOS would report it as damaged. ${verified.text}`.trim(),
            );
            return;
        }
        const executable = join(appPath, 'Contents', 'MacOS', 'HttpReq');
        const archs = inspect('lipo', ['-archs', executable]).text.trim().split(/\s+/);
        if (!archs.includes(archNames[arch])) {
            errors.push(`${label}: the executable contains ${archs.join(', ')}, expected ${arch}.`);
        }
        checkMachOArchitectures(label, appPath, arch);

        const details = inspect('codesign', ['--display', '--verbose=4', appPath]).text;
        const developerId = /Authority=Developer ID Application/.test(details);
        if (!developerId) {
            const kind = /Signature=adhoc/.test(details)
                ? 'ad hoc signed'
                : 'not signed by Developer ID';
            if (requireSigning) {
                errors.push(
                    `${label}: the app is ${kind}, so macOS would show "Apple could not verify" when it is opened. A release needs a Developer ID Application certificate and notarization (see docs/distribution.md).`,
                );
            } else {
                console.log(
                    `${label}: ${kind}; macOS will ask the user to allow it in Privacy & Security.`,
                );
            }
            return;
        }

        // Developer ID: everything notarization demands, and Gatekeeper's own verdict.
        if (!/flags=0x[0-9a-f]+\([^)]*runtime/.test(details)) {
            errors.push(
                `${label}: the hardened runtime is off, so Apple would have rejected it for notarization.`,
            );
        }
        const entitlements = inspect('codesign', [
            '--display',
            '--entitlements',
            ':-',
            appPath,
        ]).text;
        if (!entitlements.includes('com.apple.security.cs.allow-jit')) {
            errors.push(
                `${label}: the allow-jit entitlement is missing, so the JIT would be killed under the hardened runtime and the app would crash on launch.`,
            );
        }
        const assessed = inspect('spctl', [
            '--assess',
            '--type',
            'execute',
            '--verbose=2',
            appPath,
        ]);
        if (!assessed.ok || !/Notarized Developer ID/.test(assessed.text)) {
            errors.push(
                `${label}: Gatekeeper does not accept it as notarized. ${assessed.text}`.trim(),
            );
        }
        const stapled = inspect('xcrun', ['stapler', 'validate', appPath]);
        if (!stapled.ok)
            errors.push(
                `${label}: no notarization ticket is stapled to the app. ${stapled.text}`.trim(),
            );
    };

    /** The installer's own signature, then the app it installs. */
    const checkPkg = (label, pkgPath, arch, scratch) => {
        const signature = inspect('pkgutil', ['--check-signature', pkgPath]).text;
        const signed = /Status: signed/.test(signature);
        if (!signed) {
            if (requireSigning) {
                errors.push(
                    `${label}: the installer is not signed, so macOS would refuse to open it without the user overriding Gatekeeper. A release needs a Developer ID Installer certificate (see docs/distribution.md).`,
                );
            } else {
                console.log(
                    `${label}: not signed; macOS will ask the user to allow it in Privacy & Security.`,
                );
            }
        } else {
            if (!/Developer ID Installer/.test(signature)) {
                errors.push(
                    `${label}: signed, but not with a Developer ID Installer certificate. ${signature}`.trim(),
                );
            }
            const assessed = inspect('spctl', [
                '--assess',
                '--type',
                'install',
                '--verbose=2',
                pkgPath,
            ]);
            if (!assessed.ok || !/Notarized Developer ID/.test(assessed.text)) {
                errors.push(
                    `${label}: Gatekeeper does not accept the installer as notarized. ${assessed.text}`.trim(),
                );
            }
            const stapled = inspect('xcrun', ['stapler', 'validate', pkgPath]);
            if (!stapled.ok) {
                errors.push(
                    `${label}: no notarization ticket is stapled to the installer. ${stapled.text}`.trim(),
                );
            }
        }

        const expanded = join(scratch, `pkg-${arch}`);
        const expansion = inspect('pkgutil', ['--expand-full', pkgPath, expanded]);
        if (!expansion.ok) {
            errors.push(`${label}: the installer could not be expanded. ${expansion.text}`.trim());
            return;
        }
        const app = readdirSync(expanded, { recursive: true }).find(
            (path) => String(path).endsWith('HttpReq.app') && !String(path).includes('Contents'),
        );
        if (!app) {
            errors.push(`${label}: the installer does not contain HttpReq.app.`);
            return;
        }
        checkApp(label, join(expanded, String(app)), arch);
    };

    const scratch = mkdtempSync(join(tmpdir(), 'httpreq-verify-'));
    try {
        for (const arch of Object.keys(archNames)) {
            const zip = packages.find((name) => name?.endsWith(`-mac-${arch}.zip`));
            if (zip) {
                const target = join(scratch, `zip-${arch}`);
                execFileSync('ditto', ['-x', '-k', join(release, zip), target]);
                checkApp(zip, join(target, 'HttpReq.app'), arch);
            }
            const pkg = packages.find((name) => name?.endsWith(`-mac-${arch}.pkg`));
            if (pkg) checkPkg(pkg, join(release, pkg), arch, scratch);
        }
    } finally {
        rmSync(scratch, { recursive: true, force: true });
    }
}

if (errors.length > 0) {
    for (const error of errors)
        console.error(`::error title=Invalid ${platform} package::${error}`);
    process.exit(1);
}

const sums = packages
    .map((name) => {
        const hash = createHash('sha256')
            .update(readFileSync(join(release, name)))
            .digest('hex');
        return `${hash}  ${name}\n`;
    })
    .join('');
writeFileSync(join(release, `SHA256SUMS-${platform}.txt`), sums);
console.log(`Verified ${platform} packages for ${version}:\n${sums}`);
if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `### ${platform} packages (${version})\n\n` +
            packages
                .map(
                    (name) =>
                        `- \`${name}\` (${(statSync(join(release, name)).size / 1e6).toFixed(1)} MB)`,
                )
                .join('\n') +
            '\n',
    );
}
