/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { Plugin } from 'vite';

/**
 * The one place a build learns what it is. The version comes from the root package.json, the
 * single source of truth that `npm run version:set` updates for every workspace, so the web
 * build, the desktop app and its installer can never disagree. The commit and time identify the
 * exact build, which is how a deployed web app notices that a newer one has replaced it.
 */
export interface BuildInfo {
    version: string;
    /** Short commit hash, or `dev` outside a git checkout. */
    commit: string;
    /** ISO 8601 time the bundle was built. */
    builtAt: string;
}

const gitCommit = () => {
    const fromCi = process.env.GITHUB_SHA ?? process.env.COMMIT_SHA;
    if (fromCi) return fromCi.slice(0, 7);
    try {
        return execSync('git rev-parse --short=7 HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
            .toString()
            .trim();
    } catch {
        return 'dev';
    }
};

export const readBuildInfo = (): BuildInfo => {
    const { version } = JSON.parse(
        readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    return { version, commit: gitCommit(), builtAt: new Date().toISOString() };
};

/**
 * Publishes the build's identity as `version.json` beside `index.html`. A running copy of the web
 * app fetches it to find out whether a newer build has been deployed since it loaded.
 */
export const versionManifest = (info: BuildInfo): Plugin => ({
    name: 'httpreq-version-manifest',
    generateBundle() {
        this.emitFile({
            type: 'asset',
            fileName: 'version.json',
            source: `${JSON.stringify(info, null, 2)}\n`,
        });
    },
});
