/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { createContext, useCallback, useContext, useMemo, useRef } from 'react';
import {
    AppError,
    createId,
    createMqttConfig,
    type HttpRequest,
    type MqttConnection,
    type MqttEvent,
    type MqttMessage,
    type MqttQos,
    type MqttRuntime,
} from '@httpreq/shared';
import { buildMqttConnection, buildMqttPublish, type PipelineContext } from '@httpreq/api-client';
import { mqttSystemMessage, useConnectionsStore } from '../connections';
import { notifications } from '../kit';

/**
 * Owns the app's MQTT connections.
 *
 * The UI shows the connection state the broker session actually reports (`connecting`,
 * `connected`, `disconnecting`, `disconnected`, `error`), never a state a click merely asked for,
 * and Connect/Disconnect ignore a second click while an operation is in flight. Connections are
 * keyed by the request's id; each attempt carries a generation so the late events of a connection
 * that was replaced or closed cannot overwrite the state of the one that replaced it.
 */

export interface MqttApi {
    /** False in the browser: the transport needs the desktop app. */
    readonly available: boolean;
    connect: (request: HttpRequest) => Promise<void>;
    disconnect: (requestId: string) => Promise<void>;
    publish: (request: HttpRequest) => Promise<void>;
    subscribe: (
        requestId: string,
        subscriptions: { topic: string; qos: MqttQos }[],
    ) => Promise<void>;
    unsubscribe: (requestId: string, topics: string[]) => Promise<void>;
    clear: (requestId: string) => void;
    /** Disconnects and drops the log; used when the request's tab closes. */
    forget: (requestId: string) => void;
    closeAll: () => void;
}

export const MqttContext = createContext<MqttApi | null>(null);

export const useMqttApi = (): MqttApi => {
    const api = useContext(MqttContext);
    if (!api) throw new Error('useMqttApi must be used inside the HttpReq application.');
    return api;
};

const messageOf = (error: unknown, fallback: string) =>
    error instanceof AppError ? error.message : fallback;

const received = (event: Extract<MqttEvent, { type: 'message' }>): MqttMessage => ({
    id: createId(),
    direction: 'received',
    topic: event.topic,
    payload: event.payload,
    encoding: event.encoding,
    sizeBytes: event.sizeBytes,
    qos: event.qos,
    retain: event.retain,
    timestamp: new Date().toISOString(),
});

export function useMqttManager(runtime: MqttRuntime, context: () => PipelineContext): MqttApi {
    const connections = useRef(new Map<string, MqttConnection>());
    const generations = useRef(new Map<string, number>());
    const limits = useRef(new Map<string, number>());
    const store = useConnectionsStore;

    const log = useCallback(
        (requestId: string, message: MqttMessage) =>
            store
                .getState()
                .addMqttMessage(requestId, message, limits.current.get(requestId) ?? 500),
        [store],
    );

    const subscribe = useCallback(
        async (requestId: string, subscriptions: { topic: string; qos: MqttQos }[]) => {
            const connection = connections.current.get(requestId);
            if (!connection || subscriptions.length === 0) return;
            try {
                const results = await connection.subscribe(subscriptions);
                const granted: Record<string, MqttQos> = {};
                for (const result of results) {
                    if (result.grantedQos === null) {
                        log(
                            requestId,
                            mqttSystemMessage(`The broker refused “${result.topic}”.`, true),
                        );
                    } else {
                        granted[result.topic] = result.grantedQos;
                        log(
                            requestId,
                            mqttSystemMessage(
                                `Subscribed to ${result.topic} (QoS ${result.grantedQos}).`,
                            ),
                        );
                    }
                }
                const current = store.getState().mqtt[requestId]?.subscriptions ?? {};
                store
                    .getState()
                    .patchMqtt(requestId, { subscriptions: { ...current, ...granted } });
            } catch (error) {
                log(requestId, mqttSystemMessage(messageOf(error, 'Subscribing failed.'), true));
            }
        },
        [log, store],
    );

    const connect = useCallback(
        async (request: HttpRequest) => {
            const state = store.getState();
            const current = state.mqtt[request.id]?.status;
            // One operation at a time: a second click while connecting, connected or closing is ignored.
            if (
                current === 'connecting' ||
                current === 'connected' ||
                current === 'disconnecting'
            ) {
                return;
            }
            const generation = (generations.current.get(request.id) ?? 0) + 1;
            generations.current.set(request.id, generation);
            const isCurrent = () => generations.current.get(request.id) === generation;
            limits.current.set(request.id, (request.mqtt ?? createMqttConfig()).messageLimit);

            state.setMqttStatus(request.id, 'connecting', { error: null });
            let built;
            try {
                built = await buildMqttConnection(request, context());
            } catch (error) {
                if (!isCurrent()) return;
                const message = messageOf(error, 'The connection could not be prepared.');
                store.getState().setMqttStatus(request.id, 'error', { error: message });
                log(request.id, mqttSystemMessage(message, true));
                return;
            }
            for (const warning of built.warnings) log(request.id, mqttSystemMessage(warning));

            try {
                const connection = await runtime.connect(built.prepared, (event) => {
                    if (!isCurrent()) return;
                    const live = store.getState();
                    switch (event.type) {
                        case 'status':
                            if (event.status === 'connected') {
                                live.setMqttStatus(request.id, 'connected');
                                log(
                                    request.id,
                                    mqttSystemMessage(`Connected to ${built.prepared.url}.`),
                                );
                                void subscribe(request.id, built.subscriptions);
                            } else if (event.status === 'disconnected') {
                                connections.current.delete(request.id);
                                // A failure keeps its message; a plain close is simply disconnected.
                                if (live.mqtt[request.id]?.status !== 'error') {
                                    live.setMqttStatus(request.id, 'disconnected');
                                    log(request.id, mqttSystemMessage('Disconnected.'));
                                }
                            } else {
                                live.setMqttStatus(request.id, event.status);
                            }
                            break;
                        case 'message':
                            log(request.id, received(event));
                            break;
                        case 'error':
                            live.patchMqtt(request.id, { error: event.message });
                            log(request.id, mqttSystemMessage(event.message, true));
                            break;
                    }
                });
                if (!isCurrent()) {
                    // Closed while the handshake was running: do not leave the session open.
                    void connection.disconnect();
                    return;
                }
                connections.current.set(request.id, connection);
            } catch (error) {
                if (!isCurrent()) return;
                const message = messageOf(error, 'The connection failed.');
                store.getState().setMqttStatus(request.id, 'error', { error: message });
                log(request.id, mqttSystemMessage(message, true));
            }
        },
        [context, log, runtime, store, subscribe],
    );

    const disconnect = useCallback(
        async (requestId: string) => {
            const state = store.getState().mqtt[requestId]?.status;
            if (state === 'disconnecting' || state === 'disconnected' || state === undefined)
                return;
            const connection = connections.current.get(requestId);
            if (!connection) {
                store.getState().setMqttStatus(requestId, 'disconnected');
                return;
            }
            store.getState().setMqttStatus(requestId, 'disconnecting');
            try {
                await connection.disconnect();
            } finally {
                connections.current.delete(requestId);
                store.getState().setMqttStatus(requestId, 'disconnected');
            }
        },
        [store],
    );

    const publish = useCallback(
        async (request: HttpRequest) => {
            const connection = connections.current.get(request.id);
            if (!connection || store.getState().mqtt[request.id]?.status !== 'connected') {
                notifications.show({ color: 'yellow', message: 'Connect to the broker first.' });
                return;
            }
            try {
                const input = buildMqttPublish(request, context());
                await connection.publish(input);
                log(request.id, {
                    id: createId(),
                    direction: 'sent',
                    topic: input.topic,
                    payload: input.payload,
                    encoding: input.format === 'hex' ? 'hex' : 'text',
                    sizeBytes: new TextEncoder().encode(input.payload).byteLength,
                    qos: input.qos,
                    retain: input.retain,
                    timestamp: new Date().toISOString(),
                });
            } catch (error) {
                const message = messageOf(error, 'The message could not be published.');
                log(request.id, mqttSystemMessage(message, true));
                notifications.show({ color: 'red', title: 'Publish failed', message });
            }
        },
        [context, log, store],
    );

    const unsubscribe = useCallback(
        async (requestId: string, topics: string[]) => {
            const connection = connections.current.get(requestId);
            if (!connection) return;
            try {
                await connection.unsubscribe(topics);
                const remaining = { ...(store.getState().mqtt[requestId]?.subscriptions ?? {}) };
                for (const topic of topics) {
                    delete remaining[topic];
                    log(requestId, mqttSystemMessage(`Unsubscribed from ${topic}.`));
                }
                store.getState().patchMqtt(requestId, { subscriptions: remaining });
            } catch (error) {
                log(requestId, mqttSystemMessage(messageOf(error, 'Unsubscribing failed.'), true));
            }
        },
        [log, store],
    );

    const forget = useCallback(
        (requestId: string) => {
            generations.current.set(requestId, (generations.current.get(requestId) ?? 0) + 1);
            const connection = connections.current.get(requestId);
            connections.current.delete(requestId);
            void connection?.disconnect().catch(() => undefined);
            store.getState().forgetMqtt(requestId);
        },
        [store],
    );

    const closeAll = useCallback(() => {
        for (const id of [...connections.current.keys()]) forget(id);
    }, [forget]);

    return useMemo<MqttApi>(
        () => ({
            available: runtime.available,
            connect,
            disconnect,
            publish,
            subscribe,
            unsubscribe,
            clear: (requestId) => store.getState().clearMqttMessages(requestId),
            forget,
            closeAll,
        }),
        [runtime, connect, disconnect, publish, subscribe, unsubscribe, forget, closeAll, store],
    );
}
