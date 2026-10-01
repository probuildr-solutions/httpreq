/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { create } from 'zustand';
import {
    createId,
    type MqttMessage,
    type MqttQos,
    type MqttStatus,
    type SshErrorInfo,
    type SshStatus,
    type TunnelRuntimeState,
    type WebSocketMessage,
    type WebSocketPayloadType,
    type WebSocketStatus,
} from '@httpreq/shared';

/**
 * Live connection state: open sockets, SSH terminals and running tunnels.
 *
 * It is deliberately separate from the workbench store, which holds what gets persisted. Nothing
 * here survives a reload or a workspace switch, and {@link resetConnections} is what a switch
 * calls once every underlying resource has actually been released.
 */

export interface SocketState {
    status: WebSocketStatus;
    /** Subprotocol the server selected, when it chose one. */
    protocol: string;
    connectedAt: string | null;
    messages: WebSocketMessage[];
    /** Last failure, shown above the message list until the next successful connect. */
    error: string | null;
    /** Automatic reconnect attempts since the last successful open. */
    reconnectAttempts: number;
}

export interface MqttState {
    status: MqttStatus;
    connectedAt: string | null;
    messages: MqttMessage[];
    /** Last failure, shown until the next successful connect. */
    error: string | null;
    /** Topic filters the broker has accepted on this connection, with their granted QoS. */
    subscriptions: Record<string, MqttQos>;
}

export interface SshSessionState {
    sessionId: string;
    profileId: string;
    /** Profile name at connect time, so a rename does not relabel a running terminal. */
    name: string;
    status: SshStatus;
    error: SshErrorInfo | null;
    startedAt: string | null;
    /**
     * Incremented on every (re)connect. The terminal is keyed on it, so a reconnect always builds a
     * new xterm instance instead of writing a second shell into the previous one's scrollback.
     */
    generation: number;
}

interface ConnectionsState {
    sockets: Record<string, SocketState | undefined>;
    sessions: Record<string, SshSessionState | undefined>;
    tunnels: Record<string, TunnelRuntimeState | undefined>;
    mqtt: Record<string, MqttState | undefined>;

    setMqttStatus: (id: string, status: MqttStatus, patch?: Partial<MqttState>) => void;
    patchMqtt: (id: string, patch: Partial<MqttState>) => void;
    addMqttMessage: (id: string, message: MqttMessage, limit: number) => void;
    clearMqttMessages: (id: string) => void;
    forgetMqtt: (id: string) => void;

    setSocketStatus: (id: string, status: WebSocketStatus, patch?: Partial<SocketState>) => void;
    addSocketMessage: (id: string, message: WebSocketMessage, limit: number) => void;
    clearSocketMessages: (id: string) => void;
    forgetSocket: (id: string) => void;

    setSession: (session: SshSessionState) => void;
    patchSession: (sessionId: string, patch: Partial<SshSessionState>) => void;
    forgetSession: (sessionId: string) => void;

    setTunnelState: (state: TunnelRuntimeState) => void;
    forgetTunnel: (tunnelId: string) => void;
    replaceTunnels: (states: TunnelRuntimeState[]) => void;
}

/** The state of a WebSocket that has never connected. */
export const emptySocket = (): SocketState => ({
    status: 'disconnected',
    protocol: '',
    connectedAt: null,
    messages: [],
    error: null,
    reconnectAttempts: 0,
});

/** The state of an MQTT connection that has never been opened. */
export const emptyMqtt = (): MqttState => ({
    status: 'disconnected',
    connectedAt: null,
    messages: [],
    error: null,
    subscriptions: {},
});

const without = <T>(record: Record<string, T>, id: string) => {
    const next = { ...record };
    delete next[id];
    return next;
};

/** Live connection state (WebSockets, SSH sessions, tunnels). It is runtime-only and is never
 * persisted.
 */
export const useConnectionsStore = create<ConnectionsState>((set) => ({
    sockets: {},
    sessions: {},
    tunnels: {},
    mqtt: {},

    setMqttStatus: (id, status, patch) =>
        set((state) => {
            const current = state.mqtt[id] ?? emptyMqtt();
            return {
                mqtt: {
                    ...state.mqtt,
                    [id]: {
                        ...current,
                        ...patch,
                        status,
                        ...(status === 'connected'
                            ? { connectedAt: new Date().toISOString(), error: null }
                            : {}),
                        // Subscriptions belong to the connection that made them.
                        ...(status === 'disconnected' || status === 'error'
                            ? { subscriptions: {}, connectedAt: null }
                            : {}),
                    },
                },
            };
        }),

    patchMqtt: (id, patch) =>
        set((state) => ({
            mqtt: { ...state.mqtt, [id]: { ...(state.mqtt[id] ?? emptyMqtt()), ...patch } },
        })),

    addMqttMessage: (id, message, limit) =>
        set((state) => {
            const current = state.mqtt[id] ?? emptyMqtt();
            const messages = [...current.messages, message];
            return {
                mqtt: {
                    ...state.mqtt,
                    [id]: {
                        ...current,
                        messages:
                            messages.length > limit
                                ? messages.slice(messages.length - limit)
                                : messages,
                    },
                },
            };
        }),

    clearMqttMessages: (id) =>
        set((state) => {
            const current = state.mqtt[id];
            return current
                ? { mqtt: { ...state.mqtt, [id]: { ...current, messages: [] } } }
                : state;
        }),

    forgetMqtt: (id) => set((state) => ({ mqtt: without(state.mqtt, id) })),

    setSocketStatus: (id, status, patch) =>
        set((state) => {
            const current = state.sockets[id] ?? emptySocket();
            return {
                sockets: {
                    ...state.sockets,
                    [id]: {
                        ...current,
                        ...patch,
                        status,
                        ...(status === 'connected'
                            ? {
                                  connectedAt: new Date().toISOString(),
                                  error: null,
                                  reconnectAttempts: 0,
                              }
                            : {}),
                    },
                },
            };
        }),

    addSocketMessage: (id, message, limit) =>
        set((state) => {
            const current = state.sockets[id] ?? emptySocket();
            // The newest message is last; the oldest are dropped once the log reaches its limit.
            const messages = [...current.messages, message];
            return {
                sockets: {
                    ...state.sockets,
                    [id]: {
                        ...current,
                        messages:
                            messages.length > limit
                                ? messages.slice(messages.length - limit)
                                : messages,
                    },
                },
            };
        }),

    clearSocketMessages: (id) =>
        set((state) => {
            const current = state.sockets[id];
            return current
                ? { sockets: { ...state.sockets, [id]: { ...current, messages: [] } } }
                : state;
        }),

    forgetSocket: (id) => set((state) => ({ sockets: without(state.sockets, id) })),

    setSession: (session) =>
        set((state) => ({ sessions: { ...state.sessions, [session.sessionId]: session } })),

    patchSession: (sessionId, patch) =>
        set((state) => {
            const current = state.sessions[sessionId];
            return current
                ? { sessions: { ...state.sessions, [sessionId]: { ...current, ...patch } } }
                : state;
        }),

    forgetSession: (sessionId) =>
        set((state) => ({ sessions: without(state.sessions, sessionId) })),

    setTunnelState: (tunnelState) =>
        set((state) => ({ tunnels: { ...state.tunnels, [tunnelState.tunnelId]: tunnelState } })),

    forgetTunnel: (tunnelId) => set((state) => ({ tunnels: without(state.tunnels, tunnelId) })),

    replaceTunnels: (states) =>
        set({ tunnels: Object.fromEntries(states.map((item) => [item.tunnelId, item])) }),
}));

/** Clears every live-connection record. Call only after the resources themselves are released. */
export const resetConnections = () =>
    useConnectionsStore.setState({ sockets: {}, sessions: {}, tunnels: {}, mqtt: {} });

/** What the status bar shows and what a workspace switch has to warn about. */
export const activeConnectionCounts = (state: ConnectionsState) => ({
    mqtt: Object.values(state.mqtt).filter(
        (item) => item?.status === 'connected' || item?.status === 'connecting',
    ).length,
    webSockets: Object.values(state.sockets).filter(
        (socket) => socket?.status === 'connected' || socket?.status === 'connecting',
    ).length,
    sshSessions: Object.values(state.sessions).filter(
        (session) => session?.status === 'connected' || session?.status === 'connecting',
    ).length,
    tunnels: Object.values(state.tunnels).filter((tunnel) => tunnel?.status === 'active').length,
});

const textEncoder = typeof TextEncoder === 'undefined' ? null : new TextEncoder();

export const byteLength = (text: string) => textEncoder?.encode(text).byteLength ?? text.length;

/** A log line written by the app itself for an MQTT connection (connected, subscribed, error). */
export const mqttSystemMessage = (text: string, error = false): MqttMessage => ({
    id: createId(),
    direction: 'system',
    topic: '',
    payload: text,
    encoding: 'text',
    sizeBytes: 0,
    qos: 0,
    retain: false,
    timestamp: new Date().toISOString(),
    ...(error ? { error: true } : {}),
});

/** A log line written by the app itself (connected, closed, error), as opposed to a frame from the
 * server.
 */
export const systemMessage = (text: string, error = false): WebSocketMessage => ({
    id: createId(),
    direction: 'system',
    payloadType: 'system',
    data: text,
    sizeBytes: 0,
    timestamp: new Date().toISOString(),
    ...(error ? { error: true } : {}),
});

/** A log entry for one frame that was sent or received. */
export const frameMessage = (
    direction: 'sent' | 'received',
    payloadType: WebSocketPayloadType,
    data: string,
    sizeBytes: number,
): WebSocketMessage => ({
    id: createId(),
    direction,
    payloadType,
    data,
    sizeBytes,
    timestamp: new Date().toISOString(),
});
