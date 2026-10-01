/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSshProfile, createTunnelProfile, type TunnelRuntimeState } from '@httpreq/shared';
import { isPortAvailable, TunnelManager } from './tunnels';

/**
 * These exercise the parts of tunnelling that do not need a live SSH server: port-conflict
 * detection, the unsupported forwarding modes, and the state a failed start reports.
 */

const listeners: Server[] = [];

/** Occupies a loopback port and resolves the port number. */
const occupy = (): Promise<number> =>
    new Promise((resolve) => {
        const server = createServer();
        listeners.push(server);
        server.listen({ host: '127.0.0.1', port: 0 }, () => {
            const address = server.address();
            resolve(typeof address === 'object' && address ? address.port : 0);
        });
    });

const freePort = async (): Promise<number> => {
    const port = await occupy();
    const server = listeners.pop()!;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return port;
};

afterEach(async () => {
    await Promise.all(
        listeners
            .splice(0)
            .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
});

const deps = () => ({
    credentials: { get: vi.fn().mockResolvedValue('secret') } as never,
    knownHosts: { check: vi.fn().mockResolvedValue({ kind: 'trusted' }) } as never,
});

const approve = () => Promise.resolve(true);

describe('isPortAvailable', () => {
    it('is false for a port that is already listening', async () => {
        const port = await occupy();
        expect(await isPortAvailable('127.0.0.1', port)).toBe(false);
    });

    it('is true for a port nothing is using', async () => {
        expect(await isPortAvailable('127.0.0.1', await freePort())).toBe(true);
    });

    it('is false for an address this machine cannot bind', async () => {
        expect(await isPortAvailable('203.0.113.1', 30_000)).toBe(false);
    });
});

describe('TunnelManager', () => {
    it('refuses a port that is in use, before it opens any SSH connection', async () => {
        const port = await occupy();
        const states: TunnelRuntimeState[] = [];
        const manager = new TunnelManager(deps(), (state) => states.push(state));
        const tunnel = {
            ...createTunnelProfile('ssh-1', 'MySQL'),
            localPort: port,
            remoteHost: 'db',
            remotePort: 3306,
        };

        await expect(manager.start(tunnel, createSshProfile(), approve)).rejects.toMatchObject({
            code: 'TUNNEL_PORT_IN_USE',
            message: expect.stringContaining(String(port)),
        });
        // Nothing was started, so no state was published for it.
        expect(states).toEqual([]);
        expect(manager.list()).toEqual([]);
    });

    it('refuses remote and dynamic forwarding rather than silently doing something else', async () => {
        const manager = new TunnelManager(deps(), () => undefined);
        const base = {
            ...createTunnelProfile('ssh-1', 'T'),
            localPort: await freePort(),
            remoteHost: 'db',
            remotePort: 3306,
        };

        await expect(
            manager.start({ ...base, type: 'remote' }, createSshProfile(), approve),
        ).rejects.toMatchObject({
            code: 'TUNNEL_NOT_SUPPORTED',
        });
        await expect(
            manager.start({ ...base, type: 'dynamic' }, createSshProfile(), approve),
        ).rejects.toMatchObject({
            code: 'TUNNEL_NOT_SUPPORTED',
        });
    });

    it('reports an SSH failure as the tunnel’s error state and starts nothing', async () => {
        const states: TunnelRuntimeState[] = [];
        const manager = new TunnelManager(
            {
                credentials: { get: vi.fn().mockResolvedValue(null) } as never,
                knownHosts: { check: vi.fn() } as never,
            },
            (state) => states.push(state),
        );
        const tunnel = {
            ...createTunnelProfile('ssh-1', 'MySQL'),
            localPort: await freePort(),
            remoteHost: 'db',
            remotePort: 3306,
        };

        // A password profile with nothing in the vault cannot authenticate.
        await expect(manager.start(tunnel, createSshProfile(), approve)).rejects.toMatchObject({
            code: 'SSH_AUTH_FAILED',
        });
        expect(states.map((state) => state.status)).toEqual(['starting', 'error']);
        expect(manager.activeCount).toBe(0);
    });

    it('stopping a tunnel that is not running is a no-op', async () => {
        const manager = new TunnelManager(deps(), () => undefined);
        await expect(manager.stop('nope')).resolves.toBeUndefined();
        await expect(manager.stopAll()).resolves.toBeUndefined();
    });
});
