/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import type { DesktopUpdateState } from '@httpreq/shared';

/**
 * Background updates, in the way VS Code does them: the app looks for a newer release shortly
 * after it starts and then every few hours, downloads it quietly, tells the user once it is ready
 * and installs it on request (or, failing that, when the app next quits).
 *
 * The controller holds the state machine and knows nothing about Electron: the real updater
 * (`electron-updater`) is injected, so every transition is covered by a unit test. Nothing here
 * may stop the installed version from starting or running: the updater is loaded lazily, every
 * failure becomes an `error` state, and the controller never throws to its caller.
 */

/** The part of `electron-updater`'s `autoUpdater` the controller uses. */
export interface UpdaterLike {
    autoDownload: boolean;
    autoInstallOnAppQuit: boolean;
    on(event: string, listener: (...args: any[]) => void): unknown;
    checkForUpdates(): Promise<unknown>;
    quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

export interface UpdateControllerOptions {
    /** Loads the updater on first use. A rejection turns updates off for this run. */
    loadUpdater: () => Promise<UpdaterLike>;
    /** False for builds that cannot replace themselves; they report `unsupported`. */
    supported: boolean;
    onState: (state: DesktopUpdateState) => void;
    /** Runs before the app quits to install: close sockets, sessions and tunnels. */
    prepareInstall?: () => Promise<void>;
    firstCheckDelayMs?: number;
    intervalMs?: number;
}

const FIRST_CHECK_DELAY_MS = 20_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

const message = (error: unknown) =>
    // The first line is the reason; electron-updater appends request details after it.
    (error instanceof Error ? error.message : String(error)).split('\n')[0]!.slice(0, 300);

export const createUpdateController = ({
    loadUpdater,
    supported,
    onState,
    prepareInstall,
    firstCheckDelayMs = FIRST_CHECK_DELAY_MS,
    intervalMs = CHECK_INTERVAL_MS,
}: UpdateControllerOptions) => {
    let state: DesktopUpdateState = { status: supported ? 'idle' : 'unsupported' };
    let updater: Promise<UpdaterLike | null> | undefined;
    let timers: NodeJS.Timeout[] = [];

    const set = (next: DesktopUpdateState) => {
        state = next;
        try {
            onState(state);
        } catch {
            // A window that is going away must not break the update flow.
        }
    };

    /** Loads the updater once and wires its events to the state. */
    const ensureUpdater = () =>
        (updater ??= loadUpdater().then(
            (instance) => {
                // The download is automatic; the user is asked only about the restart.
                instance.autoDownload = true;
                instance.autoInstallOnAppQuit = true;
                instance.on('checking-for-update', () => set({ status: 'checking' }));
                instance.on('update-available', (info: { version?: string }) =>
                    set({ status: 'available', version: info?.version }),
                );
                instance.on('update-not-available', () => set({ status: 'current' }));
                instance.on('download-progress', (progress: { percent?: number }) =>
                    set({
                        status: 'downloading',
                        version: state.version,
                        percent: Math.min(100, Math.max(0, Math.round(progress?.percent ?? 0))),
                    }),
                );
                instance.on('update-downloaded', (info: { version?: string }) =>
                    set({ status: 'ready', version: info?.version ?? state.version }),
                );
                instance.on('error', (error: unknown) =>
                    set({ status: 'error', version: state.version, error: message(error) }),
                );
                return instance;
            },
            (error: unknown) => {
                set({ status: 'error', error: message(error) });
                return null;
            },
        ));

    const check = async (): Promise<DesktopUpdateState> => {
        if (!supported) return state;
        // A download in progress, or one that finished, is not interrupted by another check.
        if (state.status === 'downloading' || state.status === 'ready') return state;
        const instance = await ensureUpdater();
        if (!instance) return state;
        try {
            await instance.checkForUpdates();
        } catch (error) {
            set({ status: 'error', version: state.version, error: message(error) });
        }
        return state;
    };

    return {
        getState: () => state,
        check,
        /** Starts the periodic checks. Safe to call more than once. */
        start: () => {
            if (!supported || timers.length) return;
            timers = [
                setTimeout(() => void check(), firstCheckDelayMs),
                setInterval(() => void check(), intervalMs),
            ];
            // Timers must never keep the process alive on their own.
            for (const timer of timers) timer.unref?.();
        },
        stop: () => {
            for (const timer of timers) {
                clearTimeout(timer);
                clearInterval(timer);
            }
            timers = [];
        },
        /** Quits, installs the downloaded update and relaunches. Ignored unless one is ready. */
        install: async () => {
            if (state.status !== 'ready') return;
            const instance = await ensureUpdater();
            if (!instance) return;
            try {
                await prepareInstall?.();
            } catch {
                // Installing matters more than a tidy shutdown.
            }
            try {
                instance.quitAndInstall(false, true);
            } catch (error) {
                set({ status: 'error', version: state.version, error: message(error) });
            }
        },
    };
};

export type UpdateController = ReturnType<typeof createUpdateController>;

/**
 * Whether this run can replace itself: only an installed (packaged) app, and on Linux only an
 * AppImage; a .deb is updated by the system's package manager.
 */
export const supportsSelfUpdate = (
    packaged: boolean,
    platform: NodeJS.Platform,
    env: NodeJS.ProcessEnv,
) =>
    packaged &&
    (platform === 'win32' || platform === 'darwin' || (platform === 'linux' && !!env.APPIMAGE));

/** Loads `electron-updater` (a CommonJS module) from this ES-module bundle. */
export const loadElectronUpdater = async (): Promise<UpdaterLike> => {
    const loaded = (await import('electron-updater')) as unknown as {
        autoUpdater?: UpdaterLike;
        default?: { autoUpdater?: UpdaterLike };
    };
    const instance = loaded.autoUpdater ?? loaded.default?.autoUpdater;
    if (!instance) throw new Error('The updater module is not available.');
    return instance;
};
