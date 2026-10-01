/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { TunnelRuntimeState } from '@httpreq/shared';
import {
    activeConnectionCounts,
    frameMessage,
    resetConnections,
    systemMessage,
    useConnectionsStore,
} from './connections';

const store = () => useConnectionsStore.getState();

const tunnelState = (
    tunnelId: string,
    status: TunnelRuntimeState['status'],
): TunnelRuntimeState => ({
    tunnelId,
    status,
    startedAt: null,
    bytesSent: 0,
    bytesReceived: 0,
    activeConnections: 0,
    error: null,
});

beforeEach(() => resetConnections());

describe('socket state', () => {
    it('records the connection and clears a previous error once it is open', () => {
        store().setSocketStatus('s1', 'error', { error: 'refused' });
        store().setSocketStatus('s1', 'connected', { protocol: 'json' });

        const socket = store().sockets.s1!;
        expect(socket).toMatchObject({ status: 'connected', protocol: 'json', error: null });
        expect(socket.connectedAt).not.toBeNull();
    });

    it('resets the reconnect counter on a successful connection', () => {
        store().setSocketStatus('s1', 'connecting', { reconnectAttempts: 3 });
        store().setSocketStatus('s1', 'connected');
        expect(store().sockets.s1!.reconnectAttempts).toBe(0);
    });

    it('keeps messages in arrival order and drops the oldest at the limit', () => {
        for (const text of ['one', 'two', 'three']) {
            store().addSocketMessage('s1', frameMessage('sent', 'text', text, text.length), 2);
        }
        expect(store().sockets.s1!.messages.map((message) => message.data)).toEqual([
            'two',
            'three',
        ]);
    });

    it('separates sent from received, with size and type on each', () => {
        store().addSocketMessage('s1', frameMessage('sent', 'json', '{"a":1}', 7), 100);
        store().addSocketMessage('s1', frameMessage('received', 'binary', 'ff00', 2), 100);

        expect(store().sockets.s1!.messages).toMatchObject([
            { direction: 'sent', payloadType: 'json', sizeBytes: 7 },
            { direction: 'received', payloadType: 'binary', sizeBytes: 2 },
        ]);
    });

    it('marks a system note as an error when it is one', () => {
        expect(systemMessage('Disconnected.', true)).toMatchObject({
            direction: 'system',
            error: true,
        });
        expect(systemMessage('Connected.')).not.toHaveProperty('error');
    });

    it('clearing messages leaves the connection itself alone', () => {
        store().setSocketStatus('s1', 'connected');
        store().addSocketMessage('s1', frameMessage('sent', 'text', 'hi', 2), 100);
        store().clearSocketMessages('s1');

        expect(store().sockets.s1!.messages).toEqual([]);
        expect(store().sockets.s1!.status).toBe('connected');
    });
});

describe('activeConnectionCounts', () => {
    it('counts what is live and ignores what is not', () => {
        store().setSocketStatus('s1', 'connected');
        store().setSocketStatus('s2', 'connecting');
        store().setSocketStatus('s3', 'disconnected');
        store().setSession({
            sessionId: 'x1',
            profileId: 'p1',
            name: 'Prod',
            status: 'connected',
            error: null,
            startedAt: null,
            generation: 1,
        });
        store().setSession({
            sessionId: 'x2',
            profileId: 'p1',
            name: 'Prod',
            status: 'disconnected',
            error: null,
            startedAt: null,
            generation: 1,
        });
        store().setTunnelState(tunnelState('t1', 'active'));
        store().setTunnelState(tunnelState('t2', 'error'));

        expect(activeConnectionCounts(useConnectionsStore.getState())).toEqual({
            mqtt: 0,
            webSockets: 2,
            sshSessions: 1,
            tunnels: 1,
        });
    });

    it('is all zeroes once everything has been released', () => {
        store().setSocketStatus('s1', 'connected');
        store().setTunnelState(tunnelState('t1', 'active'));
        resetConnections();

        expect(activeConnectionCounts(useConnectionsStore.getState())).toEqual({
            mqtt: 0,
            webSockets: 0,
            sshSessions: 0,
            tunnels: 0,
        });
    });
});

describe('session and tunnel bookkeeping', () => {
    it('patches a session in place and forgets it on request', () => {
        store().setSession({
            sessionId: 'x1',
            profileId: 'p1',
            name: 'Prod',
            status: 'connecting',
            error: null,
            startedAt: null,
            generation: 1,
        });
        store().patchSession('x1', { status: 'connected' });
        expect(store().sessions.x1).toMatchObject({ status: 'connected', name: 'Prod' });

        store().forgetSession('x1');
        expect(store().sessions.x1).toBeUndefined();
    });

    it('ignores a patch for a session that is already gone', () => {
        store().patchSession('missing', { status: 'connected' });
        expect(store().sessions.missing).toBeUndefined();
    });

    it('replaces the whole tunnel set when the main process reports its list', () => {
        store().setTunnelState(tunnelState('old', 'active'));
        store().replaceTunnels([tunnelState('new', 'active')]);

        expect(Object.keys(store().tunnels)).toEqual(['new']);
    });
});
