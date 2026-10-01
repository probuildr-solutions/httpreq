/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { BuildInfo, DesktopBridge } from '@httpreq/shared';
import { Button, Group, Text, notifications } from '../kit';
import {
    checkForUpdates as runUpdateCheck,
    deploymentCheck,
    githubReleaseCheck,
    useUpdates,
    useUpdateService,
    type UpdateInfo,
} from '../updates';

interface Options {
    checkForUpdates: boolean;
    build?: BuildInfo;
    desktop?: DesktopBridge;
    version?: string;
}

/**
 * The update flow: which source to poll (GitHub releases for the desktop app, the deployed build
 * for the web app), the announcement shown once per newly found version, and the manual check.
 * `updateCheck` is null when updates are not being looked for, e.g. in development.
 */
export function useAppUpdates({ checkForUpdates, build, desktop, version }: Options) {
    /* Updates: GitHub releases for the desktop app, the deployed build for the web app. */
    const updateCheck = useMemo(
        () =>
            !checkForUpdates || !build ? null : desktop ? githubReleaseCheck() : deploymentCheck(),
        [checkForUpdates, build, desktop],
    );
    useUpdateService(updateCheck, build);

    const applyUpdate = useCallback(
        (update: UpdateInfo) => {
            if (update.kind === 'deployment') window.location.reload();
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

    // A newly found update is announced once; after that the status bar keeps offering it.
    const availableVersion = useUpdates((state) => state.update?.version);
    const announced = useRef<string | null>(null);
    useEffect(() => {
        const update = useUpdates.getState().update;
        if (!update || announced.current === update.version) return;
        announced.current = update.version;
        announceUpdate(update);
    }, [availableVersion, announceUpdate]);

    const checkUpdatesNow = useCallback(async () => {
        try {
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
    }, [announceUpdate, version]);

    return { updateCheck, applyUpdate, checkUpdatesNow };
}
