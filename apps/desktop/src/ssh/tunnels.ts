/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { createServer, type Server, type Socket } from 'node:net';
import type { Client } from 'ssh2';
import {
    sshError,
    sshErrorOf,
    type SshProfile,
    type TunnelProfile,
    type TunnelRuntimeState,
} from '@httpreq/shared';
import {
    openConnection,
    toSshError,
    type ConnectionDeps,
    type HostKeyApprover,
} from './connection';

/**
 * SSH port forwarding.
 *
 * Only local forwarding (`ssh -L`) is implemented: a local listener accepts connections and each
 * one is forwarded over the SSH transport to `remoteHost:remotePort`. Remote (`-R`) and dynamic
 * (`-D`) forwarding are rejected here rather than silently doing something else, and the state
 * shape already carries everything they will need.
 *
 * Each tunnel owns its own SSH connection, so stopping one never disturbs another, and every stop
 * path closes the listener, the live sockets and the SSH client together.
 */

export const isPortAvailable = (address: string, port: number): Promise<boolean> =>
    new Promise((resolve) => {
        const probe = createServer();
        probe.once('error', () => resolve(false));
        probe.once('listening', () => probe.close(() => resolve(true)));
        try {
            probe.listen({ host: address, port, exclusive: true });
        } catch {
            resolve(false);
        }
    });

interface RunningTunnel {
    state: TunnelRuntimeState;
    server: Server | null;
    client: Client | null;
    sockets: Set<Socket>;
}

export type TunnelStateListener = (state: TunnelRuntimeState) => void;

const initialState = (tunnelId: string): TunnelRuntimeState => ({
    tunnelId,
    status: 'stopped',
    startedAt: null,
    bytesSent: 0,
    bytesReceived: 0,
    activeConnections: 0,
    error: null,
});

export class TunnelManager {
    private readonly tunnels = new Map<string, RunningTunnel>();
    /** Coalesces the byte counters into at most one update per interval per tunnel. */
    private readonly pendingUpdates = new Set<string>();
    private updateTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(
        private readonly deps: ConnectionDeps,
        private readonly notify: TunnelStateListener,
        private readonly updateIntervalMs = 500,
    ) {}

    list(): TunnelRuntimeState[] {
        return [...this.tunnels.values()].map((tunnel) => ({ ...tunnel.state }));
    }

    get activeCount(): number {
        return [...this.tunnels.values()].filter((tunnel) => tunnel.state.status === 'active')
            .length;
    }

    private publish(tunnel: RunningTunnel): void {
        this.notify({ ...tunnel.state });
    }

    /** Byte counters change constantly; they are flushed on a timer instead of per chunk. */
    private publishThrottled(tunnelId: string): void {
        this.pendingUpdates.add(tunnelId);
        this.updateTimer ??= setTimeout(() => {
            this.updateTimer = null;
            for (const id of this.pendingUpdates) {
                const tunnel = this.tunnels.get(id);
                if (tunnel) this.publish(tunnel);
            }
            this.pendingUpdates.clear();
        }, this.updateIntervalMs);
    }

    async start(
        profile: TunnelProfile,
        sshProfile: SshProfile,
        approveHostKey: HostKeyApprover,
    ): Promise<TunnelRuntimeState> {
        if (profile.type !== 'local') {
            throw sshError(
                'TUNNEL_NOT_SUPPORTED',
                profile.type === 'remote'
                    ? 'Remote port forwarding is not supported yet. Use local forwarding for now.'
                    : 'Dynamic SOCKS forwarding is not supported yet. Use local forwarding for now.',
            );
        }
        await this.stop(profile.id);

        // Checked before anything is opened, so a conflict costs no SSH connection and the message
        // names the port the user has to change.
        if (!(await isPortAvailable(profile.localBindAddress, profile.localPort))) {
            throw sshError(
                'TUNNEL_PORT_IN_USE',
                `Local port ${profile.localPort} is already in use. Choose another local port.`,
            );
        }

        const tunnel: RunningTunnel = {
            state: { ...initialState(profile.id), status: 'starting' },
            server: null,
            client: null,
            sockets: new Set(),
        };
        this.tunnels.set(profile.id, tunnel);
        this.publish(tunnel);

        let client: Client;
        try {
            ({ client } = await openConnection(sshProfile, this.deps, approveHostKey));
        } catch (error) {
            const info = toSshError(error);
            tunnel.state = { ...tunnel.state, status: 'error', error: info };
            this.publish(tunnel);
            throw info;
        }
        tunnel.client = client;

        client.on('error', (error: Error) => this.fail(profile.id, toSshError(error)));
        client.on('close', () => {
            const current = this.tunnels.get(profile.id);
            if (current === tunnel && current.state.status === 'active') {
                this.fail(profile.id, sshErrorOf('SSH_CONNECTION_LOST'));
            }
        });

        const server = createServer((socket) => this.forward(profile, tunnel, socket));
        tunnel.server = server;

        try {
            await new Promise<void>((resolve, reject) => {
                server.once('error', reject);
                server.listen(
                    { host: profile.localBindAddress, port: profile.localPort, exclusive: true },
                    () => resolve(),
                );
            });
        } catch (error) {
            const code = (error as { code?: string }).code;
            const info =
                code === 'EADDRINUSE'
                    ? sshError(
                          'TUNNEL_PORT_IN_USE',
                          `Local port ${profile.localPort} is already in use. Choose another local port.`,
                      )
                    : sshError(
                          'TUNNEL_BIND_FAILED',
                          `The tunnel could not bind to ${profile.localBindAddress}:${profile.localPort}.`,
                          code,
                      );
            await this.stop(profile.id);
            throw info;
        }
        // A late listener error (the interface going away) must not crash the main process.
        server.on('error', (error: Error) => this.fail(profile.id, toSshError(error)));

        tunnel.state = {
            ...tunnel.state,
            status: 'active',
            startedAt: new Date().toISOString(),
            error: null,
        };
        this.publish(tunnel);
        return { ...tunnel.state };
    }

    /** Pipes one accepted local connection through the SSH transport. */
    private forward(profile: TunnelProfile, tunnel: RunningTunnel, socket: Socket): void {
        const client = tunnel.client;
        if (!client) {
            socket.destroy();
            return;
        }
        tunnel.sockets.add(socket);
        tunnel.state = { ...tunnel.state, activeConnections: tunnel.sockets.size };
        this.publish(tunnel);

        const release = () => {
            if (!tunnel.sockets.delete(socket)) return;
            tunnel.state = { ...tunnel.state, activeConnections: tunnel.sockets.size };
            this.publish(tunnel);
        };
        socket.on('close', release);
        socket.on('error', () => socket.destroy());

        const source = socket.remoteAddress ?? '127.0.0.1';
        const sourcePort = socket.remotePort ?? 0;
        client.forwardOut(
            source,
            sourcePort,
            profile.remoteHost,
            profile.remotePort,
            (error, stream) => {
                if (error) {
                    this.fail(
                        profile.id,
                        sshError(
                            'TUNNEL_FORWARD_REFUSED',
                            `The SSH server refused to connect to ${profile.remoteHost}:${profile.remotePort}.`,
                            error.message,
                        ),
                        // A refused forward is a per-connection problem; the listener keeps running.
                        false,
                    );
                    socket.destroy();
                    return;
                }
                socket.on('data', (chunk: Buffer) => {
                    tunnel.state = {
                        ...tunnel.state,
                        bytesSent: tunnel.state.bytesSent + chunk.byteLength,
                    };
                    this.publishThrottled(profile.id);
                });
                stream.on('data', (chunk: Buffer) => {
                    tunnel.state = {
                        ...tunnel.state,
                        bytesReceived: tunnel.state.bytesReceived + chunk.byteLength,
                    };
                    this.publishThrottled(profile.id);
                });
                stream.on('error', () => socket.destroy());
                stream.on('close', () => socket.end());
                socket.pipe(stream).pipe(socket);
            },
        );
    }

    private fail(tunnelId: string, error: ReturnType<typeof toSshError>, stop = true): void {
        const tunnel = this.tunnels.get(tunnelId);
        if (!tunnel) return;
        tunnel.state = { ...tunnel.state, status: stop ? 'error' : tunnel.state.status, error };
        this.publish(tunnel);
        if (stop) void this.stop(tunnelId, true);
    }

    /** Closes the listener, every live socket and the SSH connection. */
    async stop(tunnelId: string, keepError = false): Promise<void> {
        const tunnel = this.tunnels.get(tunnelId);
        if (!tunnel) return;
        const error = keepError ? tunnel.state.error : null;
        tunnel.state = { ...tunnel.state, status: 'stopping' };
        this.publish(tunnel);

        for (const socket of tunnel.sockets) socket.destroy();
        tunnel.sockets.clear();
        if (tunnel.server) {
            tunnel.server.removeAllListeners('error');
            await new Promise<void>((resolve) => tunnel.server!.close(() => resolve()));
        }
        tunnel.client?.removeAllListeners();
        tunnel.client?.end();
        tunnel.client?.destroy();

        this.tunnels.delete(tunnelId);
        // The final state is reported even though the tunnel is gone, so the UI can settle its row.
        this.notify({
            ...initialState(tunnelId),
            status: keepError ? 'error' : 'stopped',
            error,
        });
    }

    async stopAll(): Promise<void> {
        await Promise.all([...this.tunnels.keys()].map((id) => this.stop(id)));
        if (this.updateTimer) {
            clearTimeout(this.updateTimer);
            this.updateTimer = null;
        }
        this.pendingUpdates.clear();
    }
}
