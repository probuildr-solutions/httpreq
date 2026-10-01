/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { createContext, useCallback, useContext, useEffect, useMemo } from 'react';
import {
    sshErrorOf,
    type SshErrorInfo,
    type TunnelBridge,
    type TunnelProfile,
} from '@httpreq/shared';
import { useConnectionsStore } from '../connections';
import { resolveSshProfile } from '../ssh/useSsh';
import { useWorkbenchStore } from '../store';

/**
 * The renderer's view of SSH tunnels. Listening sockets live in the main process; this hook only
 * starts and stops them and mirrors the state they report.
 */

export interface TunnelApi {
    readonly available: boolean;
    /** Resolves to null on success, or the reason it could not start. */
    start: (tunnel: TunnelProfile) => Promise<SshErrorInfo | null>;
    stop: (tunnelId: string) => Promise<void>;
    restart: (tunnel: TunnelProfile) => Promise<SshErrorInfo | null>;
    isPortAvailable: (address: string, port: number) => Promise<boolean>;
    stopAll: () => Promise<void>;
}

export const TunnelContext = createContext<TunnelApi | null>(null);

export const useTunnels = (): TunnelApi => {
    const api = useContext(TunnelContext);
    if (!api) throw new Error('useTunnels must be used inside the HttpReq application.');
    return api;
};

const UNAVAILABLE: TunnelApi = {
    available: false,
    start: async () => sshErrorOf('SSH_UNAVAILABLE'),
    stop: async () => undefined,
    restart: async () => sshErrorOf('SSH_UNAVAILABLE'),
    isPortAvailable: async () => false,
    stopAll: async () => undefined,
};

export function useTunnelManager(bridge: TunnelBridge | undefined): TunnelApi {
    useEffect(() => {
        if (!bridge) return;
        const off = bridge.onStateChange((state) =>
            useConnectionsStore.getState().setTunnelState(state),
        );
        // Picks up tunnels that were already running, e.g. after the renderer reloaded in development.
        void bridge
            .list()
            .then((states) => useConnectionsStore.getState().replaceTunnels(states))
            .catch(() => undefined);
        return off;
    }, [bridge]);

    const start = useCallback(
        async (tunnel: TunnelProfile): Promise<SshErrorInfo | null> => {
            if (!bridge) return sshErrorOf('SSH_UNAVAILABLE');
            const workspace = useWorkbenchStore.getState().workspace;
            const sshProfile = workspace.sshProfiles.find(
                (item) => item.id === tunnel.sshProfileId,
            );
            if (!sshProfile) {
                return {
                    code: 'SSH_PROFILE_INVALID',
                    message: 'This tunnel has no SSH connection. Edit it and choose one.',
                };
            }
            const result = await bridge.start(tunnel, resolveSshProfile(sshProfile));
            return result.ok ? null : result.error;
        },
        [bridge],
    );

    const stop = useCallback(
        async (tunnelId: string) => {
            await bridge?.stop(tunnelId);
        },
        [bridge],
    );

    const restart = useCallback(
        async (tunnel: TunnelProfile) => {
            await stop(tunnel.id);
            return start(tunnel);
        },
        [start, stop],
    );

    const stopAll = useCallback(async () => {
        if (!bridge) return;
        const states = await bridge.list().catch(() => []);
        await Promise.all(
            states.map((state) => bridge.stop(state.tunnelId).catch(() => undefined)),
        );
    }, [bridge]);

    return useMemo<TunnelApi>(() => {
        if (!bridge) return UNAVAILABLE;
        return {
            available: true,
            start,
            stop,
            restart,
            isPortAvailable: (address, port) => bridge.isPortAvailable(address, port),
            stopAll,
        };
    }, [bridge, start, stop, restart, stopAll]);
}
