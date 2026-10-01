/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    createWebSocketRequest,
    type PreparedWebSocket,
    type WebSocketConnection,
    type WebSocketEvent,
    type WebSocketRequest,
    type WebSocketRuntime,
} from '@httpreq/shared';
import { createWorkspace } from '@httpreq/workspace';
import type { PipelineContext } from '@httpreq/api-client';
import { resetConnections, useConnectionsStore } from '../connections';
import { useWebSocketManager } from './useWebSockets';

vi.mock('../kit/notificationStore', () => ({ notifications: { show: vi.fn() } }));

/**
 * A runtime whose sockets are driven by the test: each `connect` hands back a handle that can be
 * opened, fed a message or closed at will, and records whether it was closed. That is what makes
 * the ordering this hook has to survive reproducible — a socket's `close` arriving after its
 * replacement has already connected.
 */
interface FakeSocket {
    readonly prepared: PreparedWebSocket;
    readonly emit: (event: WebSocketEvent) => void;
    readonly sent: unknown[];
    closed: { code?: number; reason?: string } | null;
}

const createRuntime = (kind: 'browser' | 'electron' = 'browser') => {
    const sockets: FakeSocket[] = [];
    /** Handshakes left pending until the test resolves them, for the in-flight cases. */
    let gate: (() => void) | null = null;

    const runtime: WebSocketRuntime = {
        kind,
        supportsHeaders: kind === 'electron',
        connect: async (prepared, onEvent) => {
            const socket: FakeSocket = {
                prepared,
                emit: onEvent,
                sent: [],
                closed: null,
            };
            sockets.push(socket);
            if (gate) await new Promise<void>((resolve) => (gate = resolve));
            const connection: WebSocketConnection = {
                id: prepared.url,
                send: (payload) => socket.sent.push(payload),
                close: (code, reason) => {
                    socket.closed = { code, reason };
                },
            };
            return connection;
        },
    };

    return {
        runtime,
        sockets,
        /** Makes the next handshake hang until `release` is called. */
        hold: () => {
            gate = () => undefined;
        },
        release: () => {
            const resolve = gate;
            gate = null;
            resolve?.();
        },
    };
};

const request = (changes: Partial<WebSocketRequest> = {}): WebSocketRequest => ({
    ...createWebSocketRequest(),
    id: 'ws-request',
    url: 'wss://example.test/socket',
    ...changes,
});

const context = (): PipelineContext => ({ workspace: createWorkspace(), environment: null });

const socketState = (id = 'ws-request') => useConnectionsStore.getState().sockets[id];
const messages = (id = 'ws-request') => socketState(id)?.messages.map((item) => item.data) ?? [];

beforeEach(() => resetConnections());

describe('useWebSocketManager', () => {
    it('connects, receives, sends and disconnects', async () => {
        const { runtime, sockets } = createRuntime();
        const { result } = renderHook(() => useWebSocketManager(runtime, context));
        const target = request();

        await act(async () => {
            await result.current.connect(target);
        });
        expect(sockets).toHaveLength(1);
        expect(socketState()?.status).toBe('connecting');

        act(() => sockets[0]!.emit({ type: 'open', protocol: 'chat' }));
        expect(socketState()).toMatchObject({ status: 'connected', protocol: 'chat' });
        expect(result.current.isConnected(target.id)).toBe(true);

        act(() =>
            sockets[0]!.emit({ type: 'message', payloadType: 'text', data: 'pong', sizeBytes: 4 }),
        );
        expect(messages()).toContain('pong');

        act(() => result.current.send(target, 'text', 'ping'));
        expect(sockets[0]!.sent).toEqual([{ kind: 'text', data: 'ping' }]);
        expect(messages()).toContain('ping');

        act(() => result.current.disconnect(target.id));
        expect(sockets[0]!.closed).toEqual({ code: 1000, reason: 'Closed by the user' });
        expect(socketState()?.status).toBe('disconnected');
        expect(result.current.isConnected(target.id)).toBe(false);
    });

    it('ignores a closed socket that reports itself after the user disconnected', () => {
        const { runtime, sockets } = createRuntime();
        const { result } = renderHook(() => useWebSocketManager(runtime, context));
        // Auto-reconnect is on, so a stale unclean close would also schedule a reconnect.
        const target = request({
            settings: { ...request().settings, autoReconnect: true, reconnectDelayMs: 10 },
        });

        return act(async () => {
            await result.current.connect(target);
            sockets[0]!.emit({ type: 'open', protocol: '' });
            result.current.disconnect(target.id);
            // The browser delivers `close` long after `close()` returned.
            sockets[0]!.emit({ type: 'close', code: 1006, reason: '', clean: false });

            expect(socketState()?.status).toBe('disconnected');
            expect(socketState()?.reconnectAttempts).toBe(0);
            expect(sockets).toHaveLength(1);
        });
    });

    it('does not let the previous socket mark a reconnected one as disconnected', async () => {
        const { runtime, sockets } = createRuntime();
        const { result } = renderHook(() => useWebSocketManager(runtime, context));
        const target = request();

        await act(async () => {
            await result.current.connect(target);
        });
        act(() => sockets[0]!.emit({ type: 'open', protocol: '' }));

        await act(async () => {
            await result.current.reconnect(target);
        });
        expect(sockets).toHaveLength(2);
        act(() => sockets[1]!.emit({ type: 'open', protocol: '' }));
        expect(socketState()?.status).toBe('connected');

        // The first socket finally reports its close, after the second one is already open.
        act(() => sockets[0]!.emit({ type: 'close', code: 1000, reason: '', clean: true }));
        expect(socketState()?.status).toBe('connected');
        expect(result.current.isConnected(target.id)).toBe(true);
    });

    it('closes a handshake that completes after the user gave up on it', async () => {
        const harness = createRuntime();
        const { result } = renderHook(() => useWebSocketManager(harness.runtime, context));
        const target = request();

        harness.hold();
        let pending!: Promise<void>;
        await act(async () => {
            pending = result.current.connect(target);
            // The handshake is under way — held open — when the user gives up on it.
            await vi.waitFor(() => expect(harness.sockets).toHaveLength(1));
        });
        act(() => result.current.disconnect(target.id));

        await act(async () => {
            harness.release();
            await pending;
        });

        // The socket did open, so it is closed rather than left running unattached.
        expect(harness.sockets[0]!.closed).toEqual({ code: 1000, reason: 'Closed by the user' });
        expect(socketState()?.status).toBe('disconnected');
        expect(result.current.isConnected(target.id)).toBe(false);
    });

    it('forgets a socket and its log when its tab is closed', async () => {
        const { runtime, sockets } = createRuntime();
        const { result } = renderHook(() => useWebSocketManager(runtime, context));
        const target = request();

        await act(async () => {
            await result.current.connect(target);
        });
        act(() => sockets[0]!.emit({ type: 'open', protocol: '' }));
        expect(messages().length).toBeGreaterThan(0);

        act(() => result.current.forget(target.id));
        expect(sockets[0]!.closed).not.toBeNull();
        expect(socketState()).toBeUndefined();

        // A late event from the forgotten socket must not resurrect its state.
        act(() => sockets[0]!.emit({ type: 'close', code: 1006, reason: '', clean: false }));
        expect(socketState()).toBeUndefined();
    });

    it('closes every socket on teardown and ignores what they report afterwards', async () => {
        const { runtime, sockets } = createRuntime('electron');
        const { result } = renderHook(() => useWebSocketManager(runtime, context));
        const first = request({ id: 'a' });
        const second = request({ id: 'b' });

        await act(async () => {
            await result.current.connect(first);
            await result.current.connect(second);
        });
        act(() => sockets.forEach((socket) => socket.emit({ type: 'open', protocol: '' })));

        act(() => result.current.closeAll());
        expect(sockets.every((socket) => socket.closed?.code === 1001)).toBe(true);

        resetConnections();
        act(() =>
            sockets.forEach((socket) =>
                socket.emit({ type: 'close', code: 1006, reason: '', clean: false }),
            ),
        );
        expect(useConnectionsStore.getState().sockets).toEqual({});
    });

    it('retries an unclean close only when the request asked for it', async () => {
        vi.useFakeTimers();
        try {
            const { runtime, sockets } = createRuntime();
            const { result } = renderHook(() => useWebSocketManager(runtime, context));
            const target = request({
                settings: { ...request().settings, autoReconnect: true, reconnectDelayMs: 50 },
            });

            await act(async () => {
                await result.current.connect(target);
            });
            act(() => sockets[0]!.emit({ type: 'open', protocol: '' }));
            act(() => sockets[0]!.emit({ type: 'close', code: 1006, reason: '', clean: false }));

            expect(socketState()?.status).toBe('connecting');
            expect(socketState()?.reconnectAttempts).toBe(1);

            await act(async () => {
                await vi.advanceTimersByTimeAsync(60);
            });
            expect(sockets).toHaveLength(2);
        } finally {
            vi.useRealTimers();
        }
    });
});
