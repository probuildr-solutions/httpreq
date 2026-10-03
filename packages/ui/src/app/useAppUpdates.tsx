/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    RELEASES_URL,
    type BuildInfo,
    type DesktopBridge,
    type DesktopUpdateState,
} from '@httpreq/shared';
import { Button, Group, Text, notifications } from '../kit';
import {
    checkForUpdates as runUpdateCheck,
    deploymentCheck,
    githubReleaseCheck,
    useUpdates,
    useUpdateService,
    type UpdateInfo,
} from '../updates';

/** Stands in for a check function when the desktop updater (not the renderer) does the polling. */
const selfUpdatingMarker = () => Promise.resolve(null);

interface Options {
    checkForUpdates: boolean;
    build?: BuildInfo;
    desktop?: DesktopBridge;
    version?: string;
}

/**
 * Mirrors the desktop updater (which checks, downloads and installs on its own, in the main
 * process) into the shared update state, and says so once when a download starts and again when
 * the update is ready to install. Returns the updater's latest state, or null until it has
 * answered, and null for builds without a native updater.
 */
function useNativeUpdates(desktop: DesktopBridge | undefined, enabled: boolean) {
    const updates = enabled ? desktop?.updates : undefined;
    const [native, setNative] = useState<DesktopUpdateState | null>(null);
    const announced = useRef<string | null>(null);

    useEffect(() => {
        if (!updates) return;
        const apply = (state: DesktopUpdateState) => {
            setNative(state);
            const { version } = state;
            switch (state.status) {
                case 'checking':
                    useUpdates.setState({ status: 'checking', error: null });
                    break;
                case 'current':
                    useUpdates.setState({
                        status: 'current',
                        update: null,
                        error: null,
                        checkedAt: new Date().toISOString(),
                    });
                    break;
                case 'available':
                case 'downloading':
                    if (!version) break;
                    useUpdates.setState({
                        status: 'available',
                        update: { version, kind: 'release', progress: state.percent ?? 0 },
                        error: null,
                    });
                    if (announced.current !== `download-${version}`) {
                        announced.current = `download-${version}`;
                        notifications.show({
                            id: 'update-available',
                            color: 'violet',
                            autoClose: 6000,
                            title: `HttpReq ${version} is available`,
                            message: 'Downloading it in the background. You can keep working.',
                        });
                    }
                    break;
                case 'ready':
                    if (!version) break;
                    useUpdates.setState({
                        status: 'available',
                        update: { version, kind: 'restart' },
                        error: null,
                    });
                    if (announced.current !== `ready-${version}`) {
                        announced.current = `ready-${version}`;
                        notifications.show({
                            id: 'update-available',
                            color: 'violet',
                            autoClose: false,
                            title: `HttpReq ${version} is ready to install`,
                            message: (
                                <Group gap="xs" className="mt-1">
                                    <Text size="sm">Restart to finish updating.</Text>
                                    <Button
                                        size="compact-xs"
                                        variant="light"
                                        onClick={() => {
                                            notifications.hide('update-available');
                                            updates.install();
                                        }}
                                    >
                                        Restart now
                                    </Button>
                                </Group>
                            ),
                        });
                    }
                    break;
                case 'installing':
                    notifications.show({
                        id: 'update-installing',
                        color: 'violet',
                        autoClose: false,
                        title: 'Installing update',
                        message: 'HttpReq will restart in a moment.',
                    });
                    break;
                case 'error':
                    // A failed update never affects the running version. If the new version is
                    // known, it can still be downloaded by hand.
                    useUpdates.setState({
                        status: 'error',
                        error: state.error ?? 'The update could not be completed.',
                        update: version ? { version, kind: 'release', url: RELEASES_URL } : null,
                        checkedAt: new Date().toISOString(),
                    });
                    break;
            }
        };
        void updates.getState().then(apply, () => undefined);
        return updates.onStateChange(apply);
    }, [updates]);

    return updates ? native : null;
}

/**
 * The update flow: which source to poll (the desktop updater, or GitHub releases for a desktop
 * build that cannot update itself, or the deployed build for the web app), the announcement shown
 * once per newly found version, and the manual check. `updateCheck` is null when updates are not
 * being looked for, e.g. in development.
 */
export function useAppUpdates({ checkForUpdates, build, desktop, version }: Options) {
    const enabled = checkForUpdates && !!build;
    const native = useNativeUpdates(desktop, enabled);
    // The desktop updater does the work itself, unless this build cannot replace itself; until it
    // has answered, nothing is polled, so the two never race.
    const selfUpdating = !!desktop?.updates && (native === null || native.status !== 'unsupported');

    /* Updates: GitHub releases for a desktop build that cannot self-update, the deployment for the web. */
    const updateCheck = useMemo(
        () =>
            !enabled || selfUpdating ? null : desktop ? githubReleaseCheck() : deploymentCheck(),
        [enabled, selfUpdating, desktop],
    );
    useUpdateService(updateCheck, build);

    const applyUpdate = useCallback(
        (update: UpdateInfo) => {
            if (update.kind === 'restart') desktop?.updates?.install();
            else if (update.progress !== undefined) return;
            else if (update.kind === 'deployment') window.location.reload();
            else if (update.url && desktop) desktop.openExternal(update.url);
            else if (update.url) window.open(update.url, '_blank', 'noopener,noreferrer');
        },
        [desktop],
    );

    const announceUpdate = useCallback(
        (update: UpdateInfo) =>
            notifications.show({
                id: 'update-available',
                color: 'violet',
                autoClose: 12_000,
                title: `HttpReq ${update.version} is available`,
                message: (
                    <Group gap="xs" className="mt-1">
                        <Text size="sm">
                            {update.kind === 'deployment'
                                ? 'A newer version has been deployed.'
                                : `You are using ${version ?? 'an older version'}.`}
                        </Text>
                        <Button
                            size="compact-xs"
                            variant="light"
                            onClick={() => {
                                notifications.hide('update-available');
                                applyUpdate(update);
                            }}
                        >
                            {update.kind === 'deployment' ? 'Reload' : 'Download'}
                        </Button>
                    </Group>
                ),
            }),
        [applyUpdate, version],
    );

    // A newly found update is announced once; after that the status bar keeps offering it. The
    // desktop updater announces its own updates (see useNativeUpdates).
    const availableVersion = useUpdates((state) => state.update?.version);
    const announced = useRef<string | null>(null);
    useEffect(() => {
        const update = useUpdates.getState().update;
        if (selfUpdating || !update || announced.current === update.version) return;
        announced.current = update.version;
        announceUpdate(update);
    }, [availableVersion, announceUpdate, selfUpdating]);

    const checkUpdatesNow = useCallback(async () => {
        try {
            if (selfUpdating && desktop?.updates) {
                // An update shows up through the updater's state; only the outcome is reported here.
                const state = await desktop.updates.check();
                if (state.status === 'current') {
                    notifications.show({
                        color: 'teal',
                        message: `You are up to date: HttpReq ${version ?? ''} is the latest version.`,
                    });
                } else if (state.status === 'error') {
                    notifications.show({
                        color: 'red',
                        title: 'Update failed',
                        message: (
                            <Group gap="xs" className="mt-1">
                                <Text size="sm">
                                    {state.error ?? 'The update could not be completed.'}
                                </Text>
                                {state.diagnostics && (
                                    <Text
                                        size="xs"
                                        className="opacity-70"
                                        title="Technical details"
                                    >
                                        {state.diagnostics}
                                        {state.currentVersion
                                            ? ` · v${state.currentVersion} ${state.platform}-${state.arch}`
                                            : ''}
                                    </Text>
                                )}
                                {state.errorKind === 'feed-not-found' && (
                                    <Button
                                        size="compact-xs"
                                        variant="light"
                                        onClick={() => desktop.openExternal(RELEASES_URL)}
                                    >
                                        Open releases
                                    </Button>
                                )}
                            </Group>
                        ),
                    });
                }
                return;
            }
            const update = await runUpdateCheck();
            if (update) {
                announced.current = update.version;
                announceUpdate(update);
            } else {
                notifications.show({
                    color: 'teal',
                    message: `You are up to date: HttpReq ${version ?? ''} is the latest version.`,
                });
            }
        } catch (error) {
            notifications.show({
                color: 'red',
                title: 'Could not check for updates',
                message: error instanceof Error ? error.message : String(error),
            });
        }
    }, [announceUpdate, desktop, selfUpdating, version]);

    return {
        // Truthy whenever updates are being looked for, by whichever updater does it.
        updateCheck: enabled ? (updateCheck ?? selfUpdatingMarker) : null,
        applyUpdate,
        checkUpdatesNow,
    };
}
