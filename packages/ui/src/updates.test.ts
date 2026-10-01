/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { describe, expect, it, vi } from 'vitest';
import { LATEST_RELEASE_API } from '@httpreq/shared';
import { compareVersions, deploymentCheck, githubReleaseCheck } from './updates';

const current = { version: '0.1.0', commit: 'abc1234', builtAt: '2026-09-01T00:00:00.000Z' };
const signal = new AbortController().signal;

const respond = (status: number, body?: unknown) =>
    vi.fn(async () => new Response(body === undefined ? null : JSON.stringify(body), { status }));

describe('compareVersions', () => {
    it('orders semantic versions, pre-releases before their release', () => {
        expect(compareVersions('0.2.0', '0.1.9')).toBe(1);
        expect(compareVersions('v1.0.0', '1.0.0')).toBe(0);
        expect(compareVersions('1.10.0', '1.9.0')).toBe(1);
        expect(compareVersions('1.0.0-beta.2', '1.0.0')).toBe(-1);
        expect(compareVersions('1.0.0-beta.10', '1.0.0-beta.2')).toBe(1);
        expect(compareVersions('1.0', '1.0.0')).toBe(0);
    });
});

describe('githubReleaseCheck', () => {
    it('reports a newer release with its page', async () => {
        const fetcher = respond(200, {
            tag_name: 'v0.2.0',
            html_url: 'https://github.com/yamatrireddy/httpreq/releases/tag/v0.2.0',
            body: 'Notes',
        });
        const update = await githubReleaseCheck(fetcher)(current, signal);
        expect(fetcher).toHaveBeenCalledWith(LATEST_RELEASE_API, expect.anything());
        expect(update).toEqual({
            version: '0.2.0',
            kind: 'release',
            url: 'https://github.com/yamatrireddy/httpreq/releases/tag/v0.2.0',
            notes: 'Notes',
        });
    });

    it('ignores the same or an older release, and a missing one', async () => {
        expect(
            await githubReleaseCheck(respond(200, { tag_name: 'v0.1.0' }))(current, signal),
        ).toBe(null);
        expect(await githubReleaseCheck(respond(404))(current, signal)).toBe(null);
    });

    it('never opens a page outside the project', async () => {
        const update = await githubReleaseCheck(
            respond(200, { tag_name: '9.0.0', html_url: 'https://evil.example/download' }),
        )(current, signal);
        expect(update?.url).toBe('https://github.com/yamatrireddy/httpreq/releases');
    });

    it('fails loudly on server errors', async () => {
        await expect(githubReleaseCheck(respond(500))(current, signal)).rejects.toThrow('500');
    });
});

describe('deploymentCheck', () => {
    it('finds a newer deployed version', async () => {
        const update = await deploymentCheck('./version.json', respond(200, { version: '0.2.0' }))(
            current,
            signal,
        );
        expect(update).toEqual({ version: '0.2.0', kind: 'deployment' });
    });

    it('finds a newer build of the same version', async () => {
        const check = deploymentCheck(
            './version.json',
            respond(200, { ...current, commit: 'def5678', builtAt: '2026-09-02T00:00:00.000Z' }),
        );
        expect(await check(current, signal)).toEqual({ version: '0.1.0', kind: 'deployment' });
    });

    it('treats the running build, or no manifest, as current', async () => {
        expect(
            await deploymentCheck('./version.json', respond(200, current))(current, signal),
        ).toBe(null);
        expect(await deploymentCheck('./version.json', respond(404))(current, signal)).toBe(null);
    });
});
