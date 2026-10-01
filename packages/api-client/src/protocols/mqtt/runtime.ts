/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import {
    AppError,
    type IpcResult,
    type MqttBridge,
    type MqttConnection,
    type MqttEvent,
    type MqttPublishInput,
    type MqttQos,
    type MqttRuntime,
    type PreparedMqttConnection,
} from '@httpreq/shared';

/** The browser cannot open raw TCP/TLS connections to a broker. */
export class UnavailableMqttRuntime implements MqttRuntime {
    readonly kind = 'browser' as const;
    readonly available = false;

    connect(): Promise<MqttConnection> {
        return Promise.reject(
            new AppError('INVALID_REQUEST', 'MQTT connections need the HttpReq desktop app.'),
        );
    }
}

const unwrap = <T>(result: IpcResult<T>): T => {
    if (!result.ok) throw new AppError(result.error.code, result.error.message);
    return result.value;
};

/**
 * Desktop runtime. The MQTT client lives in the Electron main process, which owns the sockets and
 * the TLS material; the renderer holds an id and receives events.
 */
export class ElectronMqttRuntime implements MqttRuntime {
    readonly kind = 'electron' as const;
    readonly available = true;

    private nextId = 0;
    private readonly listeners = new Map<string, (event: MqttEvent) => void>();
    private unsubscribe: (() => void) | null = null;

    private bridge(): MqttBridge {
        const bridge = window.httpreq?.mqtt;
        if (!bridge) throw new AppError('NETWORK_ERROR', 'The desktop MQTT bridge is unavailable.');
        return bridge;
    }

    async connect(
        prepared: PreparedMqttConnection,
        onEvent: (event: MqttEvent) => void,
    ): Promise<MqttConnection> {
        const bridge = this.bridge();
        // One IPC subscription serves every connection; each event carries the id it belongs to.
        this.unsubscribe ??= bridge.onEvent((id, event) => this.listeners.get(id)?.(event));

        this.nextId += 1;
        const id = `mqtt-${this.nextId}`;
        const release = () => {
            this.listeners.delete(id);
            if (this.listeners.size === 0) {
                this.unsubscribe?.();
                this.unsubscribe = null;
            }
        };
        this.listeners.set(id, (event) => {
            onEvent(event);
            if (event.type === 'status' && event.status === 'disconnected') release();
        });

        try {
            unwrap(await bridge.connect(id, prepared));
        } catch (error) {
            release();
            throw error;
        }

        return {
            id,
            publish: async (input: MqttPublishInput) => unwrap(await bridge.publish(id, input)),
            subscribe: async (subscriptions: { topic: string; qos: MqttQos }[]) =>
                unwrap(await bridge.subscribe(id, subscriptions)),
            unsubscribe: async (topics: string[]) => unwrap(await bridge.unsubscribe(id, topics)),
            disconnect: async () => {
                await bridge.disconnect(id);
            },
        };
    }
}
