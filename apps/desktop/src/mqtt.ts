/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import mqtt, { type IClientOptions, type MqttClient } from 'mqtt';
import {
    AppError,
    isMqttQos,
    MQTT_PAYLOAD_FORMATS,
    MQTT_PROTOCOL_VERSIONS,
    redactText,
    validatePublishTopic,
    validateTopicFilter,
    type MqttEvent,
    type MqttPublishInput,
    type MqttQos,
    type MqttStatus,
    type MqttSubscribeResult,
    type PreparedMqttConnection,
} from '@httpreq/shared';

/**
 * MQTT connections for the desktop app.
 *
 * The broker connection, its credentials and its TLS material live here; the renderer holds an id
 * and receives events. Connections are keyed by the window that opened them, so one window can
 * never publish through, read from or close another's, and every connection is closed with its
 * window. The payload of every IPC call is re-validated by the `parse…` functions below before any
 * socket is touched.
 */

const SCHEMES = new Set(['mqtt', 'mqtts', 'ws', 'wss']);
const MAX_PEM = 1024 * 1024;
const MAX_PAYLOAD_BYTES = 10 * 1024 * 1024;
/** Longest payload copied into an event; the true size is always reported. */
const MAX_EVENT_BYTES = 1024 * 1024;

const isObject = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value);

const text = (value: unknown, max: number): string | null =>
    typeof value === 'string' && value.length <= max && !value.includes('\0') ? value : null;

const PEM = /^\s*-----BEGIN [A-Z0-9 ]+-----[\s\S]*-----END [A-Z0-9 ]+-----\s*$/;

/** Empty is allowed (no certificate); anything else must look like PEM. */
const pem = (value: unknown): string | null => {
    const content = text(value ?? '', MAX_PEM);
    return content !== null && (content === '' || PEM.test(content)) ? content : null;
};

const integer = (value: unknown, max: number, fallback: number) =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0
        ? Math.min(Math.round(value), max)
        : fallback;

/** Rebuilds a connection from an untrusted IPC payload. Returns null when it is not usable. */
export const parsePreparedMqtt = (value: unknown): PreparedMqttConnection | null => {
    if (!isObject(value)) return null;
    let url: URL;
    try {
        url = new URL(String(value.url));
    } catch {
        return null;
    }
    if (!SCHEMES.has(url.protocol.replace(/:$/, '')) || !url.hostname) return null;
    const clientId = text(value.clientId, 256);
    const username = text(value.username ?? '', 4096);
    const password = text(value.password ?? '', 65_535);
    if (clientId === null || username === null || password === null) return null;
    const tls = isObject(value.tls) ? value.tls : {};
    const ca = pem(tls.caCertificate);
    const cert = pem(tls.clientCertificate);
    const key = pem(tls.clientKey);
    if (ca === null || cert === null || key === null) return null;
    const protocolVersion = (MQTT_PROTOCOL_VERSIONS as readonly unknown[]).includes(
        value.protocolVersion,
    )
        ? (value.protocolVersion as PreparedMqttConnection['protocolVersion'])
        : 5;

    let will: PreparedMqttConnection['will'] = null;
    if (isObject(value.will) && value.will.enabled === true) {
        const topic = text(value.will.topic, 65_535);
        const payload = text(value.will.payload, MAX_PAYLOAD_BYTES);
        if (topic === null || payload === null || validatePublishTopic(topic)) return null;
        will = {
            enabled: true,
            topic,
            payload,
            qos: isMqttQos(value.will.qos) ? value.will.qos : 0,
            retain: value.will.retain === true,
        };
    }
    return {
        url: url.toString().replace(/\/$/, ''),
        clientId,
        username,
        password,
        protocolVersion,
        keepAliveSeconds: integer(value.keepAliveSeconds, 65_535, 60),
        cleanSession: value.cleanSession !== false,
        connectTimeoutMs: integer(value.connectTimeoutMs, 10 * 60_000, 30_000),
        reconnectPeriodMs: integer(value.reconnectPeriodMs, 60 * 60_000, 0),
        tls: {
            // Verification is only ever turned off when the renderer asked for it explicitly.
            verifyCertificate: tls.verifyCertificate !== false,
            caCertificate: ca,
            clientCertificate: cert,
            clientKey: key,
        },
        will,
    };
};

export const parseMqttPublish = (value: unknown): MqttPublishInput | null => {
    if (!isObject(value)) return null;
    const topic = text(value.topic, 65_535);
    const payload = text(value.payload, MAX_PAYLOAD_BYTES);
    if (topic === null || payload === null || validatePublishTopic(topic)) return null;
    if (!(MQTT_PAYLOAD_FORMATS as readonly unknown[]).includes(value.format)) return null;
    if (!isMqttQos(value.qos)) return null;
    const format = value.format as MqttPublishInput['format'];
    if (format === 'hex') {
        const digits = payload.replace(/[\s:]/g, '');
        if (digits.length % 2 !== 0 || /[^0-9a-f]/i.test(digits)) return null;
    }
    return { topic, payload, format, qos: value.qos, retain: value.retain === true };
};

export const parseMqttSubscriptions = (
    value: unknown,
): { topic: string; qos: MqttQos }[] | null => {
    if (!Array.isArray(value) || value.length > 200) return null;
    const result: { topic: string; qos: MqttQos }[] = [];
    for (const item of value) {
        if (!isObject(item)) return null;
        const topic = text(item.topic, 65_535);
        if (topic === null || validateTopicFilter(topic) || !isMqttQos(item.qos)) return null;
        result.push({ topic, qos: item.qos });
    }
    return result;
};

export const parseMqttTopics = (value: unknown): string[] | null => {
    if (!Array.isArray(value) || value.length > 200) return null;
    const topics = value.map((item) => text(item, 65_535));
    return topics.every((topic): topic is string => topic !== null && !validateTopicFilter(topic))
        ? topics
        : null;
};

const toPayloadBuffer = (input: MqttPublishInput): Buffer =>
    input.format === 'hex'
        ? Buffer.from(input.payload.replace(/[\s:]/g, ''), 'hex')
        : Buffer.from(input.payload, 'utf8');

const decodePayload = (
    payload: Buffer,
): { payload: string; encoding: 'text' | 'hex'; sizeBytes: number } => {
    const slice =
        payload.byteLength > MAX_EVENT_BYTES ? payload.subarray(0, MAX_EVENT_BYTES) : payload;
    try {
        return {
            payload: new TextDecoder('utf-8', { fatal: true }).decode(slice),
            encoding: 'text',
            sizeBytes: payload.byteLength,
        };
    } catch {
        return { payload: slice.toString('hex'), encoding: 'hex', sizeBytes: payload.byteLength };
    }
};

/** A short, non-sensitive description of a failure. The library puts the useful part in `code`. */
export const describeMqttError = (error: Error): string => {
    const code = (error as { code?: string | number }).code;
    switch (code) {
        case 'ENOTFOUND':
        case 'EAI_AGAIN':
            return 'The broker host could not be resolved.';
        case 'ECONNREFUSED':
            return 'The broker refused the connection.';
        case 'ETIMEDOUT':
            return 'The connection to the broker timed out.';
        case 'CERT_HAS_EXPIRED':
        case 'DEPTH_ZERO_SELF_SIGNED_CERT':
        case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
        case 'SELF_SIGNED_CERT_IN_CHAIN':
        case 'ERR_TLS_CERT_ALTNAME_INVALID':
            return `TLS verification failed (${String(code)}). Check the CA certificate, or turn certificate verification off in Settings.`;
        case 4:
        case 134:
            return 'The broker rejected the user name or password.';
        case 5:
        case 135:
            return 'The broker says this client is not authorized.';
        default:
            return redactText(error.message || 'The MQTT connection failed.');
    }
};

const connectionKey = (senderId: number, connectionId: string) => `${senderId}:${connectionId}`;

export type MqttEmitter = (senderId: number, connectionId: string, event: MqttEvent) => void;

interface Connection {
    client: MqttClient;
    /** Set when the user asked to disconnect, so the resulting close is not a failure. */
    closing: boolean;
}

export class MqttManager {
    private readonly connections = new Map<string, Connection>();

    constructor(private readonly emit: MqttEmitter) {}

    get size(): number {
        return this.connections.size;
    }

    private get(senderId: number, connectionId: string): Connection {
        const connection = this.connections.get(connectionKey(senderId, connectionId));
        if (!connection) throw new AppError('INVALID_REQUEST', 'The MQTT connection is not open.');
        return connection;
    }

    /** Resolves once the broker accepted the connection; rejects with a readable reason otherwise. */
    connect(
        senderId: number,
        connectionId: string,
        prepared: PreparedMqttConnection,
    ): Promise<void> {
        void this.disconnect(senderId, connectionId);
        const key = connectionKey(senderId, connectionId);
        const send = (event: MqttEvent) => this.emit(senderId, connectionId, event);
        const status = (value: MqttStatus) => send({ type: 'status', status: value });

        const secure = prepared.url.startsWith('mqtts') || prepared.url.startsWith('wss');
        const options: IClientOptions = {
            clientId: prepared.clientId,
            protocolVersion: prepared.protocolVersion,
            keepalive: prepared.keepAliveSeconds,
            clean: prepared.cleanSession,
            connectTimeout: prepared.connectTimeoutMs || 30_000,
            reconnectPeriod: prepared.reconnectPeriodMs,
            ...(prepared.username ? { username: prepared.username } : {}),
            ...(prepared.password ? { password: Buffer.from(prepared.password) } : {}),
            ...(secure
                ? {
                      rejectUnauthorized: prepared.tls.verifyCertificate,
                      ...(prepared.tls.caCertificate ? { ca: prepared.tls.caCertificate } : {}),
                      ...(prepared.tls.clientCertificate
                          ? { cert: prepared.tls.clientCertificate }
                          : {}),
                      ...(prepared.tls.clientKey ? { key: prepared.tls.clientKey } : {}),
                  }
                : {}),
            ...(prepared.will
                ? {
                      will: {
                          topic: prepared.will.topic,
                          payload: Buffer.from(prepared.will.payload, 'utf8'),
                          qos: prepared.will.qos,
                          retain: prepared.will.retain,
                      },
                  }
                : {}),
        };

        status('connecting');
        return new Promise<void>((resolve, reject) => {
            let client: MqttClient;
            try {
                client = mqtt.connect(prepared.url, options);
            } catch (cause) {
                status('disconnected');
                reject(new AppError('INVALID_REQUEST', describeMqttError(cause as Error)));
                return;
            }
            const connection: Connection = { client, closing: false };
            this.connections.set(key, connection);
            let opened = false;

            client.on('connect', () => {
                opened = true;
                status('connected');
                resolve();
            });
            client.on('reconnect', () => status('connecting'));
            client.on('message', (topic, payload, packet) => {
                send({
                    type: 'message',
                    topic,
                    ...decodePayload(payload),
                    qos: isMqttQos(packet.qos) ? packet.qos : 0,
                    retain: !!packet.retain,
                    duplicate: !!packet.dup,
                });
            });
            client.on('error', (error: Error) => {
                const message = describeMqttError(error);
                send({ type: 'error', message });
                if (!opened) {
                    // The attempt failed: end the client so it does not keep retrying in the background.
                    this.connections.delete(key);
                    client.end(true);
                    status('disconnected');
                    reject(new AppError('NETWORK_ERROR', message));
                }
            });
            client.on('close', () => {
                // With automatic reconnect on, a close is followed by a reconnect, not an ending.
                if (connection.closing || prepared.reconnectPeriodMs === 0) {
                    if (this.connections.get(key) === connection) this.connections.delete(key);
                    status('disconnected');
                    if (!opened)
                        reject(new AppError('NETWORK_ERROR', 'The connection was closed.'));
                }
            });
        });
    }

    publish(senderId: number, connectionId: string, input: MqttPublishInput): Promise<void> {
        const { client } = this.get(senderId, connectionId);
        return new Promise((resolve, reject) => {
            client.publish(
                input.topic,
                toPayloadBuffer(input),
                { qos: input.qos, retain: input.retain },
                (error) =>
                    error
                        ? reject(new AppError('NETWORK_ERROR', describeMqttError(error)))
                        : resolve(),
            );
        });
    }

    subscribe(
        senderId: number,
        connectionId: string,
        subscriptions: { topic: string; qos: MqttQos }[],
    ): Promise<MqttSubscribeResult[]> {
        const { client } = this.get(senderId, connectionId);
        return new Promise((resolve, reject) => {
            client.subscribe(
                Object.fromEntries(subscriptions.map((item) => [item.topic, { qos: item.qos }])),
                (error, granted) => {
                    if (error) {
                        reject(new AppError('NETWORK_ERROR', describeMqttError(error)));
                        return;
                    }
                    resolve(
                        (granted ?? []).map((item) => ({
                            topic: item.topic,
                            // 0x80 (128) is the broker's refusal.
                            grantedQos: isMqttQos(item.qos) ? item.qos : null,
                        })),
                    );
                },
            );
        });
    }

    unsubscribe(senderId: number, connectionId: string, topics: string[]): Promise<void> {
        const { client } = this.get(senderId, connectionId);
        return new Promise((resolve, reject) => {
            client.unsubscribe(topics, (error) =>
                error ? reject(new AppError('NETWORK_ERROR', describeMqttError(error))) : resolve(),
            );
        });
    }

    async disconnect(senderId: number, connectionId: string): Promise<void> {
        const key = connectionKey(senderId, connectionId);
        const connection = this.connections.get(key);
        if (!connection) return;
        connection.closing = true;
        this.connections.delete(key);
        this.emit(senderId, connectionId, { type: 'status', status: 'disconnecting' });
        await new Promise<void>((resolve) => {
            // A graceful DISCONNECT, then the socket; `force` if the broker does not answer.
            const timer = setTimeout(() => {
                connection.client.end(true, () => resolve());
            }, 3000);
            connection.client.end(false, () => {
                clearTimeout(timer);
                resolve();
            });
        });
        this.emit(senderId, connectionId, { type: 'status', status: 'disconnected' });
    }

    disposeForSender(senderId: number): void {
        const prefix = `${senderId}:`;
        for (const key of [...this.connections.keys()]) {
            if (key.startsWith(prefix)) void this.disconnect(senderId, key.slice(prefix.length));
        }
    }

    disposeAll(): void {
        for (const connection of this.connections.values()) {
            connection.closing = true;
            connection.client.end(true);
        }
        this.connections.clear();
    }
}
