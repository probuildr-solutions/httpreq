/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { useEffect } from 'react';
import { create } from 'zustand';
import { LATEST_RELEASE_API, RELEASES_URL, type BuildInfo } from '@httpreq/shared';

/**
 * "Is there a newer HttpReq?" — answered differently for each build, behind one interface.
 *
 * - The desktop app asks GitHub for the latest published release and compares versions.
 * - The web app is replaced in place by each deployment, so it asks its own server for the
 *   `version.json` the build published beside `index.html`: a different version or commit means a
 *   newer build is live, and reloading the page picks it up.
 *
 * Checks run once shortly after start-up and then a few times a day, never in a tight loop; a
 * failed check is reported only when the user asked for it.
 */

export interface UpdateInfo {
    /** The newer version, e.g. `0.2.0`. */
    version: string;
    /** `release`: a download to install; `deployment`: reload the page to switch to it. */
    kind: 'release' | 'deployment';
    /** Release page for a `release`. */
    url?: string;
    /** Release notes, when the source has them. */
    notes?: string;
}

/** Resolves the available update, or null when this build is current. Throws when it cannot tell. */
export type UpdateCheck = (current: BuildInfo, signal: AbortSignal) => Promise<UpdateInfo | null>;

type Fetch = typeof fetch;

const numeric = (part: string) => (/^\d+$/.test(part) ? Number(part) : NaN);

/**
 * Compares two semantic versions (a leading `v` is ignored). A pre-release sorts before its
 * release: `1.2.0-beta.1` < `1.2.0`.
 */
export const compareVersions = (a: string, b: string): number => {
    const parse = (value: string) => {
        const [core = '', pre] = value.trim().replace(/^v/i, '').split('+')[0]!.split(/-(.*)/s);
        return { core: core.split('.').map((part) => numeric(part) || 0), pre: pre ?? '' };
    };
    const left = parse(a);
    const right = parse(b);
    for (let index = 0; index < Math.max(left.core.length, right.core.length, 3); index += 1) {
        const difference = (left.core[index] ?? 0) - (right.core[index] ?? 0);
        if (difference) return Math.sign(difference);
    }
    if (left.pre === right.pre) return 0;
    if (!left.pre) return 1;
    if (!right.pre) return -1;
    const leftParts = left.pre.split('.');
    const rightParts = right.pre.split('.');
    for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
        const l = leftParts[index];
        const r = rightParts[index];
        if (l === undefined) return -1;
        if (r === undefined) return 1;
        const ln = numeric(l);
        const rn = numeric(r);
        if (!Number.isNaN(ln) && !Number.isNaN(rn)) {
            if (ln !== rn) return Math.sign(ln - rn);
        } else if (l !== r) {
            return l < r ? -1 : 1;
        }
    }
    return 0;
};

/** Only release pages of this project are ever opened; anything else falls back to the list. */
const releasePage = (value: unknown) =>
    typeof value === 'string' && value.startsWith(`${RELEASES_URL}/`) ? value : RELEASES_URL;

/** The desktop check: the latest GitHub release, when it is newer than this build. */
export const githubReleaseCheck =
    (fetcher: Fetch = fetch): UpdateCheck =>
    async (current, signal) => {
        const response = await fetcher(LATEST_RELEASE_API, {
            headers: { Accept: 'application/vnd.github+json' },
            cache: 'no-store',
            signal,
        });
        // No release has been published yet: nothing can be newer.
        if (response.status === 404) return null;
        if (!response.ok) throw new Error(`The release server answered ${response.status}.`);
        const release = (await response.json()) as Record<string, unknown>;
        if (release.draft === true || release.prerelease === true) return null;
        const version = String(release.tag_name ?? '').replace(/^v/i, '');
        if (!version || compareVersions(version, current.version) <= 0) return null;
        return {
            version,
            kind: 'release',
            url: releasePage(release.html_url),
            notes: typeof release.body === 'string' ? release.body : undefined,
        };
    };

/**
 * The web check: the `version.json` of whatever build is deployed now. A build without one (the
 * dev server, or a host that strips it) is treated as current.
 */
export const deploymentCheck =
    (manifestUrl = './version.json', fetcher: Fetch = fetch): UpdateCheck =>
    async (current, signal) => {
        const url = `${manifestUrl}${manifestUrl.includes('?') ? '&' : '?'}t=${Date.now()}`;
        const response = await fetcher(url, { cache: 'no-store', signal });
        if (response.status === 404) return null;
        if (!response.ok) throw new Error(`The server answered ${response.status}.`);
        const deployed = (await response.json()) as Partial<BuildInfo>;
        if (typeof deployed.version !== 'string') return null;
        const newerVersion = compareVersions(deployed.version, current.version) > 0;
        const sameVersionRebuilt =
            deployed.version === current.version &&
            typeof deployed.commit === 'string' &&
            deployed.commit !== current.commit &&
            deployed.builtAt !== undefined &&
            current.builtAt !== undefined &&
            deployed.builtAt > current.builtAt;
        return newerVersion || sameVersionRebuilt
            ? { version: deployed.version, kind: 'deployment' }
            : null;
    };

export type UpdateStatus = 'idle' | 'checking' | 'current' | 'available' | 'error';

interface UpdateState {
    status: UpdateStatus;
    update: UpdateInfo | null;
    error: string | null;
    checkedAt: string | null;
}

export const useUpdates = create<UpdateState>(() => ({
    status: 'idle',
    update: null,
    error: null,
    checkedAt: null,
}));

let activeCheck: { run: () => Promise<UpdateInfo | null> } | null = null;

/** Runs a check now (for "Check for Updates…"). Resolves with the update, or null. */
export const checkForUpdates = async (): Promise<UpdateInfo | null> =>
    activeCheck ? activeCheck.run() : null;

const FIRST_CHECK_DELAY_MS = 15_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Keeps {@link useUpdates} current for the running build: one check shortly after start-up, then
 * every few hours. Without a check (a build that cannot be updated) nothing runs.
 */
export const useUpdateService = (check: UpdateCheck | null, current: BuildInfo | undefined) => {
    useEffect(() => {
        if (!check || !current) return;
        let controller: AbortController | null = null;
        const run = async () => {
            controller?.abort();
            const own = new AbortController();
            controller = own;
            useUpdates.setState({ status: 'checking', error: null });
            try {
                const update = await check(current, own.signal);
                if (own.signal.aborted) return null;
                useUpdates.setState({
                    status: update ? 'available' : 'current',
                    update,
                    checkedAt: new Date().toISOString(),
                });
                return update;
            } catch (error) {
                if (own.signal.aborted) return null;
                useUpdates.setState({
                    status: 'error',
                    error: error instanceof Error ? error.message : String(error),
                    checkedAt: new Date().toISOString(),
                });
                throw error;
            }
        };
        const handle = { run };
        activeCheck = handle;
        const quiet = () => void run().catch(() => undefined);
        const first = setTimeout(quiet, FIRST_CHECK_DELAY_MS);
        const interval = setInterval(quiet, CHECK_INTERVAL_MS);
        return () => {
            clearTimeout(first);
            clearInterval(interval);
            controller?.abort();
            if (activeCheck === handle) activeCheck = null;
        };
    }, [check, current]);
};
