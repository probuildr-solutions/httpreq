/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

// Decides what a packaging run is building. Used by .github/workflows/desktop-packages.yml, and
// runnable locally (`node apps/desktop/scripts/release-info.mjs`) to check the version before a
// release.
//
// - The version is the root package.json version, which `npm run version:set` writes to every
//   workspace. A workspace that disagrees fails the run: the installer, `app.getVersion()` and the
//   version the renderer shows must be the same release.
// - A push to main (a merged pull request) is a release when it changed that version, or when the
//   pull request it merged carries the `release` label. A manual run is a release when its
//   `release` input is set.
// - A release whose tag (v<version>) already exists fails here, before any platform is built, so
//   a forgotten version bump can never overwrite or duplicate a published release.
//
// Inputs (environment): EVENT_NAME, BASE_SHA (the commit before the push, or a pull request's base
// commit), PR_LABELS (JSON array of the merged pull request's label names), RELEASE_REQUESTED
// ("true" for a manual release run).
// Outputs: version, tag, release, prerelease — written to $GITHUB_OUTPUT when it is set.
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const git = (...args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const fail = (message) => {
    console.error(`::error title=Release check failed::${message}`);
    process.exit(1);
};

const { version, workspaces = [] } = readJson(join(root, 'package.json'));

// Semantic version, optionally with a pre-release (0.2.0-beta.1). Build metadata is not allowed:
// Debian and the update check would both ignore or mangle it.
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/.test(version ?? '')) {
    fail(`The root package.json version "${version}" is not a semantic version like 1.2.3.`);
}

const mismatched = workspaces
    .flatMap((pattern) => {
        const dir = join(root, pattern.replace(/\/\*$/, ''));
        return readdirSync(dir).map((name) => join(dir, name, 'package.json'));
    })
    .filter((path) => existsSync(path))
    .map((path) => ({ path, pkg: readJson(path) }))
    .filter(({ pkg }) => pkg.version !== version)
    .map(({ pkg }) => `${pkg.name} (${pkg.version})`);
if (mismatched.length > 0) {
    fail(
        `Workspace versions differ from the root version ${version}: ${mismatched.join(', ')}. ` +
            `Run \`npm run version:set -- ${version}\`.`,
    );
}

const tag = `v${version}`;
const prerelease = version.includes('-');
const event = process.env.EVENT_NAME ?? 'local';

let release = false;
let reason = 'not a release';
if (event === 'workflow_dispatch') {
    release = process.env.RELEASE_REQUESTED === 'true';
    if (release) reason = 'requested by the manual run';
} else if (event === 'push' || event === 'pull_request_target' || event === 'pull_request') {
    const labels = JSON.parse(process.env.PR_LABELS || '[]');
    let baseVersion = null;
    // A push that creates the branch has no previous commit (all zeros).
    if (process.env.BASE_SHA && !/^0+$/.test(process.env.BASE_SHA)) {
        try {
            baseVersion = JSON.parse(git('show', `${process.env.BASE_SHA}:package.json`)).version;
        } catch {
            console.log(`::warning::Could not read package.json at base ${process.env.BASE_SHA}.`);
        }
    }
    if (baseVersion && baseVersion !== version) {
        release = true;
        reason = `the version changed from ${baseVersion} to ${version}`;
    } else if (labels.includes('release')) {
        release = true;
        reason = 'the pull request has the "release" label';
    }
}

if (release) {
    let tagExists = false;
    try {
        tagExists = git('ls-remote', '--tags', 'origin', `refs/tags/${tag}`).trim() !== '';
    } catch {
        // No remote (a local run): fall back to local tags.
        tagExists = git('tag', '--list', tag).trim() !== '';
    }
    if (tagExists) {
        fail(
            `This run is a release (${reason}), but tag ${tag} already exists. ` +
                'Bump the version with `npm run version:set -- <new version>` in a new pull request.',
        );
    }
}

const outputs = { version, tag, release: String(release), prerelease: String(prerelease) };
console.log(`Version ${version}; ${release ? `release ${tag} (${reason})` : reason}.`);
if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
        process.env.GITHUB_OUTPUT,
        Object.entries(outputs)
            .map(([key, value]) => `${key}=${value}\n`)
            .join(''),
    );
}
if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `### HttpReq ${version}\n\n` +
            (release
                ? `Publishing **${tag}**${prerelease ? ' as a pre-release' : ''}: ${reason}.\n`
                : `Packages only, no release: ${reason}.\n`),
    );
}
