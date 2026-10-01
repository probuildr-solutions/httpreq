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
// the ones the build asked for. It then writes SHA256SUMS-<platform>.txt beside them.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import {
    appendFileSync,
    mkdirSync,
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
        new RegExp(`^HttpReq-${v}-mac-${arch}\\.dmg$`),
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
        // The deb and dmg are for first installs; only the files the updater downloads are listed.
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

// macOS: an app whose signature does not verify is reported as "damaged" once downloaded, and an
// arm64 app must contain arm64 code. Check what the user will actually install: the app inside
// every zip and every dmg (mounted), for the architecture its file name claims.
if (platform === 'mac') {
    const run = (command, args) =>
        execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const archNames = { x64: 'x86_64', arm64: 'arm64' };
    const signedWithDeveloperId = Boolean(process.env.CSC_LINK || process.env.CSC_NAME);

    const checkApp = (label, appPath, arch) => {
        try {
            run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]);
        } catch (error) {
            errors.push(
                `${label}: the app's code signature is invalid, so macOS would report it as damaged. ${
                    error.stderr ?? error.message
                }`.trim(),
            );
            return;
        }
        const executable = join(appPath, 'Contents', 'MacOS', 'HttpReq');
        const archs = run('lipo', ['-archs', executable]).trim().split(/\s+/);
        if (!archs.includes(archNames[arch])) {
            errors.push(`${label}: the executable contains ${archs.join(', ')}, expected ${arch}.`);
        }
        if (signedWithDeveloperId) {
            try {
                run('spctl', ['--assess', '--type', 'execute', '--verbose=2', appPath]);
                run('xcrun', ['stapler', 'validate', appPath]);
            } catch (error) {
                errors.push(
                    `${label}: Gatekeeper or notarization check failed. ${error.stderr ?? ''}`,
                );
            }
        } else {
            const details = run('codesign', ['--display', '--verbose=2', appPath]);
            const [firstLine] = details.split('\n');
            console.log(`${label}: ad hoc signed (no Developer ID certificate) ${firstLine}`);
        }
    };

    const scratch = mkdtempSync(join(tmpdir(), 'httpreq-verify-'));
    try {
        for (const arch of Object.keys(archNames)) {
            const zip = packages.find((name) => name?.endsWith(`-mac-${arch}.zip`));
            if (zip) {
                const target = join(scratch, `zip-${arch}`);
                run('ditto', ['-x', '-k', join(release, zip), target]);
                checkApp(zip, join(target, 'HttpReq.app'), arch);
            }
            const dmg = packages.find((name) => name?.endsWith(`-mac-${arch}.dmg`));
            if (dmg) {
                const mountPoint = join(scratch, `dmg-${arch}`);
                mkdirSync(mountPoint);
                try {
                    run('hdiutil', ['verify', join(release, dmg)]);
                    run('hdiutil', [
                        'attach',
                        '-nobrowse',
                        '-readonly',
                        '-mountpoint',
                        mountPoint,
                        join(release, dmg),
                    ]);
                    try {
                        checkApp(dmg, join(mountPoint, 'HttpReq.app'), arch);
                    } finally {
                        run('hdiutil', ['detach', '-force', mountPoint]);
                    }
                } catch (error) {
                    errors.push(
                        `${dmg}: the disk image could not be verified or mounted. ${error.stderr ?? error.message}`,
                    );
                }
            }
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
