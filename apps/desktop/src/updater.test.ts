/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

// @vitest-environment node
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DesktopUpdateState } from '@httpreq/shared';
import {
    createUpdateController,
    describeUpdateError,
    supportsSelfUpdate,
    type UpdaterLike,
} from './updater';

class FakeUpdater extends EventEmitter {
    autoDownload = false;
    autoInstallOnAppQuit = false;
    checkForUpdates = vi.fn(async () => undefined);
    quitAndInstall = vi.fn();
}

const setup = (overrides: Partial<Parameters<typeof createUpdateController>[0]> = {}) => {
    const updater = new FakeUpdater();
    const states: DesktopUpdateState[] = [];
    const controller = createUpdateController({
        loadUpdater: async () => updater as unknown as UpdaterLike,
        supported: true,
        onState: (state) => states.push(state),
        ...overrides,
    });
    return { updater, states, controller };
};

afterEach(() => vi.useRealTimers());

describe('update controller', () => {
    it('downloads in the background and reports each step until the update is ready', async () => {
        const { updater, states, controller } = setup();
        await controller.check();
        expect(updater.autoDownload).toBe(true);
        expect(updater.autoInstallOnAppQuit).toBe(true);

        updater.emit('checking-for-update');
        updater.emit('update-available', { version: '1.2.0' });
        updater.emit('download-progress', { percent: 41.6 });
        updater.emit('update-downloaded', { version: '1.2.0' });

        expect(states.map((state) => state.status)).toEqual([
            'checking',
            'available',
            'downloading',
            'ready',
        ]);
        expect(states[2]).toMatchObject({ version: '1.2.0', percent: 42 });
        expect(controller.getState()).toEqual({ status: 'ready', version: '1.2.0' });
    });

    it('does not interrupt a download or a ready update with another check', async () => {
        const { updater, controller } = setup();
        await controller.check();
        updater.emit('download-progress', { percent: 10 });
        updater.checkForUpdates.mockClear();
        await controller.check();
        expect(updater.checkForUpdates).not.toHaveBeenCalled();
    });

    it('turns every failure into an error state and recovers on the next check', async () => {
        const { updater, controller } = setup();
        updater.checkForUpdates.mockRejectedValueOnce(new Error('offline\nstack'));
        expect(await controller.check()).toMatchObject({
            status: 'error',
            errorKind: 'unknown',
            diagnostics: 'offline',
        });
        updater.emit('update-not-available');
        expect(controller.getState().status).toBe('current');
        updater.emit('error', new Error('signature mismatch'));
        expect(controller.getState()).toMatchObject({
            status: 'error',
            errorKind: 'signature',
            diagnostics: 'signature mismatch',
        });
        await controller.check();
        expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
    });

    it('stays usable when the updater module cannot be loaded', async () => {
        const { states, controller } = setup({
            loadUpdater: async () => {
                throw new Error('Cannot find module');
            },
        });
        expect((await controller.check()).status).toBe('error');
        expect(states).toHaveLength(1);
        await expect(controller.install()).resolves.toBeUndefined();
    });

    it('installs only a downloaded update, after preparing the shutdown', async () => {
        const order: string[] = [];
        const { updater, controller } = setup({
            prepareInstall: async () => void order.push('prepare'),
        });
        await controller.check();
        await controller.install();
        expect(updater.quitAndInstall).not.toHaveBeenCalled();

        updater.quitAndInstall.mockImplementation(() => order.push('install'));
        updater.emit('update-downloaded', { version: '2.0.0' });
        await controller.install();
        expect(order).toEqual(['prepare', 'install']);
        expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true);
    });

    it('still installs when the shutdown preparation fails', async () => {
        const { updater, controller } = setup({
            prepareInstall: async () => {
                throw new Error('stuck socket');
            },
        });
        await controller.check();
        updater.emit('update-downloaded', { version: '2.0.0' });
        await controller.install();
        expect(updater.quitAndInstall).toHaveBeenCalled();
    });

    it('reports an unsupported build without ever loading the updater', async () => {
        const loadUpdater = vi.fn();
        const { controller } = setup({ supported: false, loadUpdater });
        controller.start();
        expect((await controller.check()).status).toBe('unsupported');
        expect(loadUpdater).not.toHaveBeenCalled();
    });

    it('checks shortly after start-up and then on a schedule', async () => {
        vi.useFakeTimers();
        const { updater, controller } = setup({ firstCheckDelayMs: 1000, intervalMs: 5000 });
        controller.start();
        controller.start();
        await vi.advanceTimersByTimeAsync(1000);
        expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
        updater.emit('update-not-available');
        await vi.advanceTimersByTimeAsync(5000);
        expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
        controller.stop();
        await vi.advanceTimersByTimeAsync(20_000);
        expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
    });
});

describe('self-update support', () => {
    it('needs an installed app, and an AppImage on Linux', () => {
        expect(supportsSelfUpdate(true, 'win32', {})).toBe(true);
        expect(supportsSelfUpdate(true, 'darwin', {})).toBe(true);
        expect(supportsSelfUpdate(true, 'linux', { APPIMAGE: '/x.AppImage' })).toBe(true);
        expect(supportsSelfUpdate(true, 'linux', {})).toBe(false);
        expect(supportsSelfUpdate(false, 'win32', {})).toBe(false);
    });
});

describe('update error descriptions', () => {
    it('explains a 404 from the feed without showing the bare status code', () => {
        const described = describeUpdateError(
            new Error(
                'Cannot find latest.yml in the latest release artifacts (https://x): HttpError: 404',
            ),
        );
        expect(described.errorKind).toBe('feed-not-found');
        expect(described.error).not.toMatch(/404/);
        expect(described.diagnostics).toMatch(/404/);
    });

    it('classifies network and integrity failures and scrubs credentials', () => {
        expect(describeUpdateError(new Error('getaddrinfo ENOTFOUND github.com')).errorKind).toBe(
            'network',
        );
        expect(describeUpdateError(new Error('sha512 checksum mismatch')).errorKind).toBe(
            'integrity',
        );
        expect(describeUpdateError(new Error('bad token=ghp_secret123')).diagnostics).not.toMatch(
            /ghp_secret123/,
        );
    });

    it('attaches the version, platform and architecture the update is matched to', async () => {
        const { controller } = setup({
            context: { currentVersion: '0.6.0', platform: 'darwin', arch: 'x64' },
        });
        expect(controller.getState()).toMatchObject({ arch: 'x64', platform: 'darwin' });
    });
});
