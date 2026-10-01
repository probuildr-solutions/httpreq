/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { createContext, useContext } from 'react';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
    AppError,
    DEFAULT_WEBSOCKET_SETTINGS,
    type WebSocketConnection,
    type WebSocketPayloadType,
    type WebSocketRequest,
    type WebSocketRuntime,
} from '@httpreq/shared';
import { buildWebSocket, hexToBytes, type PipelineContext } from '@httpreq/api-client';
import { byteLength, frameMessage, systemMessage, useConnectionsStore } from '../connections';
import { notifications } from '../kit';

/**
 * Owns the app's WebSocket connections.
 *
 * Connections are keyed by the saved request's id, so a tab always shows its own socket and
 * closing a tab closes exactly one connection. Everything the UI needs — status, protocol and
 * message log — lives in the connections store; this hook only performs the side effects.
 *
 * Every attempt carries a generation number. Closing a socket is asynchronous — a browser socket
 * delivers its `close` long after `close()` returns — so without one the dying socket's events
 * would land on the connection that replaced it: a reconnect would report itself as disconnected,
 * and an automatic reconnect could be scheduled for a socket the user had already closed.
 */

export interface WebSocketApi {
    connect: (request: WebSocketRequest) => Promise<void>;
    disconnect: (requestId: string) => void;
    reconnect: (request: WebSocketRequest) => Promise<void>;
    send: (request: WebSocketRequest, payloadType: WebSocketPayloadType, data: string) => void;
    clear: (requestId: string) => void;
    /** Closes the socket and drops its log; used when a WebSocket tab is closed. */
    forget: (requestId: string) => void;
    /** Closes every socket and forgets it. Used when the workspace changes or the app unmounts. */
    closeAll: () => void;
    isConnected: (requestId: string) => boolean;
}

export const WebSocketContext = createContext<WebSocketApi | null>(null);

export const useWebSocketApi = (): WebSocketApi => {
    const api = useContext(WebSocketContext);
    if (!api) throw new Error('useWebSocketApi must be used inside the HttpReq application.');
    return api;
};

/** JSON and XML are sent as text; only `binary` is decoded from hex into bytes. */
const encodePayload = (payloadType: WebSocketPayloadType, data: string) =>
    payloadType === 'binary'
        ? ({ kind: 'binary', data: hexToBytes(data) } as const)
        : ({ kind: 'text', data } as const);

/** Closes a connection without letting one failure stop the rest of a teardown. */
const closeQuietly = (connection: WebSocketConnection, code: number, reason: string) => {
    try {
        connection.close(code, reason);
    } catch {
        // Already gone; there is nothing left to release.
    }
};

export function useWebSocketManager(
    runtime: WebSocketRuntime,
    context: () => PipelineContext,
): WebSocketApi {
    const connections = useRef(new Map<string, WebSocketConnection>());
    /** Pending automatic reconnects, so a manual disconnect can cancel one. */
    const reconnectTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
    /** Current attempt per request; anything older is a socket on its way out. */
    const generations = useRef(new Map<string, number>());
    /** Message limit each socket was opened with, for logging without the request to hand. */
    const messageLimits = useRef(new Map<string, number>());

    const store = useConnectionsStore;

    const cancelReconnect = useCallback((requestId: string) => {
        const timer = reconnectTimers.current.get(requestId);
        if (timer) {
            clearTimeout(timer);
            reconnectTimers.current.delete(requestId);
        }
    }, []);

    /** Starts a new attempt and invalidates every event still in flight for the previous one. */
    const nextGeneration = useCallback((requestId: string) => {
        const generation = (generations.current.get(requestId) ?? 0) + 1;
        generations.current.set(requestId, generation);
        return generation;
    }, []);

    const log = useCallback(
        (request: WebSocketRequest, message: ReturnType<typeof systemMessage>) =>
            store.getState().addSocketMessage(request.id, message, request.settings.messageLimit),
        [store],
    );

    const logById = useCallback(
        (requestId: string, message: ReturnType<typeof systemMessage>) =>
            store
                .getState()
                .addSocketMessage(
                    requestId,
                    message,
                    messageLimits.current.get(requestId) ?? DEFAULT_WEBSOCKET_SETTINGS.messageLimit,
                ),
        [store],
    );

    const connect = useCallback(
        async (request: WebSocketRequest) => {
            const state = store.getState();
            cancelReconnect(request.id);
            if (connections.current.has(request.id)) return;

            const generation = nextGeneration(request.id);
            const isCurrent = () => generations.current.get(request.id) === generation;
            messageLimits.current.set(request.id, request.settings.messageLimit);

            state.setSocketStatus(request.id, 'connecting', { error: null });
            let built;
            try {
                built = await buildWebSocket(request, context(), runtime.supportsHeaders);
            } catch (error) {
                if (!isCurrent()) return;
                const message =
                    error instanceof AppError
                        ? error.message
                        : 'The request could not be prepared.';
                store.getState().setSocketStatus(request.id, 'error', { error: message });
                log(request, systemMessage(message, true));
                return;
            }
            if (!isCurrent()) return;
            for (const warning of built.warnings) log(request, systemMessage(warning));

            try {
                const connection = await runtime.connect(built.prepared, (event) => {
                    // An event from a socket the user has already replaced or closed.
                    if (!isCurrent()) return;
                    const current = store.getState();
                    switch (event.type) {
                        case 'open':
                            current.setSocketStatus(request.id, 'connected', {
                                protocol: event.protocol,
                            });
                            log(
                                request,
                                systemMessage(
                                    event.protocol
                                        ? `Connected to ${built.prepared.url} (${event.protocol}).`
                                        : `Connected to ${built.prepared.url}.`,
                                ),
                            );
                            break;
                        case 'message':
                            current.addSocketMessage(
                                request.id,
                                frameMessage(
                                    'received',
                                    event.payloadType === 'binary' ? 'binary' : 'text',
                                    event.data,
                                    event.sizeBytes,
                                ),
                                request.settings.messageLimit,
                            );
                            break;
                        case 'error':
                            current.setSocketStatus(request.id, 'error', { error: event.message });
                            log(request, systemMessage(event.message, true));
                            break;
                        case 'close': {
                            connections.current.delete(request.id);
                            log(
                                request,
                                systemMessage(
                                    `Disconnected (code ${event.code}${event.reason ? `: ${event.reason}` : ''}).`,
                                    !event.clean,
                                ),
                            );
                            current.setSocketStatus(request.id, 'disconnected');
                            // Only an unclean close is retried, and only when the request asked for it.
                            if (request.settings.autoReconnect && !event.clean) {
                                const attempts =
                                    (current.sockets[request.id]?.reconnectAttempts ?? 0) + 1;
                                current.setSocketStatus(request.id, 'connecting', {
                                    reconnectAttempts: attempts,
                                });
                                log(request, systemMessage(`Reconnecting (attempt ${attempts})…`));
                                reconnectTimers.current.set(
                                    request.id,
                                    setTimeout(() => {
                                        reconnectTimers.current.delete(request.id);
                                        // The timer outlives this generation, so the check is repeated on waking.
                                        if (isCurrent()) void connect(request);
                                    }, request.settings.reconnectDelayMs),
                                );
                            }
                            break;
                        }
                    }
                });
                // The user disconnected, or switched workspace, while the handshake was in flight: the
                // socket is live but nothing owns it any more, so it is closed rather than registered.
                if (!isCurrent()) {
                    closeQuietly(connection, 1000, 'Closed by the user');
                    return;
                }
                connections.current.set(request.id, connection);
            } catch (error) {
                if (!isCurrent()) return;
                const message =
                    error instanceof AppError ? error.message : 'The WebSocket connection failed.';
                store.getState().setSocketStatus(request.id, 'error', { error: message });
                log(request, systemMessage(message, true));
            }
        },
        [cancelReconnect, context, log, nextGeneration, runtime, store],
    );

    const disconnect = useCallback(
        (requestId: string) => {
            cancelReconnect(requestId);
            const connection = connections.current.get(requestId);
            const pending = !connection && generations.current.has(requestId);
            // The socket is retired first: its `close` is asynchronous and must not reach the next one.
            nextGeneration(requestId);
            connections.current.delete(requestId);
            if (connection) {
                store.getState().setSocketStatus(requestId, 'disconnecting');
                closeQuietly(connection, 1000, 'Closed by the user');
                logById(requestId, systemMessage('Disconnected by the user.'));
            } else if (pending) {
                // A handshake still in flight; `connect` discards the socket when it finally resolves.
                logById(requestId, systemMessage('Connection cancelled.'));
            }
            store.getState().setSocketStatus(requestId, 'disconnected');
        },
        [cancelReconnect, logById, nextGeneration, store],
    );

    const reconnect = useCallback(
        async (request: WebSocketRequest) => {
            disconnect(request.id);
            await connect(request);
        },
        [connect, disconnect],
    );

    const send = useCallback(
        (request: WebSocketRequest, payloadType: WebSocketPayloadType, data: string) => {
            const connection = connections.current.get(request.id);
            if (!connection) {
                notifications.show({
                    color: 'yellow',
                    message: 'Connect before sending a message.',
                });
                return;
            }
            let payload;
            try {
                payload = encodePayload(payloadType, data);
            } catch (error) {
                const message =
                    error instanceof AppError ? error.message : 'The message could not be encoded.';
                notifications.show({ color: 'red', title: 'Message not sent', message });
                return;
            }
            try {
                connection.send(payload);
            } catch (error) {
                const message =
                    error instanceof AppError ? error.message : 'The message could not be sent.';
                log(request, systemMessage(message, true));
                notifications.show({ color: 'red', title: 'Message not sent', message });
                return;
            }
            store
                .getState()
                .addSocketMessage(
                    request.id,
                    frameMessage(
                        'sent',
                        payloadType,
                        data,
                        payload.kind === 'binary' ? payload.data.byteLength : byteLength(data),
                    ),
                    request.settings.messageLimit,
                );
        },
        [log, store],
    );

    const clear = useCallback(
        (requestId: string) => store.getState().clearSocketMessages(requestId),
        [store],
    );

    const forget = useCallback(
        (requestId: string) => {
            disconnect(requestId);
            generations.current.delete(requestId);
            messageLimits.current.delete(requestId);
            store.getState().forgetSocket(requestId);
        },
        [disconnect, store],
    );

    const closeAll = useCallback(() => {
        for (const timer of reconnectTimers.current.values()) clearTimeout(timer);
        reconnectTimers.current.clear();
        // Every attempt is retired, including handshakes that have not resolved yet, so no late
        // event can write to the store after the workspace it belonged to has been torn down.
        for (const requestId of [...generations.current.keys()]) nextGeneration(requestId);
        for (const connection of connections.current.values()) {
            closeQuietly(connection, 1001, 'HttpReq is closing the connection');
        }
        connections.current.clear();
        messageLimits.current.clear();
    }, [nextGeneration]);

    const isConnected = useCallback((requestId: string) => connections.current.has(requestId), []);

    // Sockets are owned by this hook, so unmounting the app must not leave one open.
    useEffect(() => closeAll, [closeAll]);

    return useMemo(
        () => ({ connect, disconnect, reconnect, send, clear, forget, closeAll, isConnected }),
        [connect, disconnect, reconnect, send, clear, forget, closeAll, isConnected],
    );
}
