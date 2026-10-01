/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { createId } from './model';
import type { IpcResult } from './index';

/**
 * MQTT domain model. An MQTT request is an `HttpRequest` whose `protocol` is `mqtt`: the URL is
 * the broker (`mqtt://`, `mqtts://`, `ws://`, `wss://`), and the broker credentials come from the
 * request's authorization (Basic: user and password; Bearer: the token as the password), so the
 * existing providers, `{{variables}}` and secret handling apply unchanged. This configuration adds
 * what only MQTT needs. The only literal secret in it is the TLS client key, which is never
 * persisted (see `sanitizeRequest`).
 */

export const MQTT_QOS_LEVELS = [0, 1, 2] as const;
export type MqttQos = (typeof MQTT_QOS_LEVELS)[number];

export const isMqttQos = (value: unknown): value is MqttQos =>
    value === 0 || value === 1 || value === 2;

/** Wire protocol levels: 4 is MQTT 3.1.1, 5 is MQTT 5.0. */
export const MQTT_PROTOCOL_VERSIONS = [3, 4, 5] as const;
export type MqttProtocolVersion = (typeof MQTT_PROTOCOL_VERSIONS)[number];

export const MQTT_VERSION_LABELS: Record<MqttProtocolVersion, string> = {
    3: 'MQTT 3.1',
    4: 'MQTT 3.1.1',
    5: 'MQTT 5.0',
};

export const MQTT_STATUSES = [
    'disconnected',
    'connecting',
    'connected',
    'disconnecting',
    'error',
] as const;
export type MqttStatus = (typeof MQTT_STATUSES)[number];

export const isMqttStatus = (value: unknown): value is MqttStatus =>
    typeof value === 'string' && (MQTT_STATUSES as readonly string[]).includes(value);

export const MQTT_PAYLOAD_FORMATS = ['text', 'json', 'hex'] as const;
export type MqttPayloadFormat = (typeof MQTT_PAYLOAD_FORMATS)[number];

export interface MqttTlsConfig {
    /** Verify the broker's certificate chain and host name. Turning this off is explicit. */
    verifyCertificate: boolean;
    /** PEM of a private CA to trust in addition to the system roots. */
    caCertificate: string;
    /** PEM client certificate for mutual TLS. */
    clientCertificate: string;
    /** PEM client private key. Session-only: dropped before the request is persisted or exported. */
    clientKey: string;
}

export interface MqttWill {
    enabled: boolean;
    topic: string;
    payload: string;
    qos: MqttQos;
    retain: boolean;
}

export interface MqttSubscription {
    id: string;
    /** A topic filter; `+` and `#` wildcards allowed. */
    topic: string;
    qos: MqttQos;
    enabled: boolean;
}

export interface MqttConfig {
    /** Empty lets the app generate a unique id per connection. */
    clientId: string;
    protocolVersion: MqttProtocolVersion;
    keepAliveSeconds: number;
    cleanSession: boolean;
    connectTimeoutMs: number;
    /** Milliseconds between automatic reconnect attempts; 0 disables reconnecting. */
    reconnectPeriodMs: number;
    tls: MqttTlsConfig;
    will: MqttWill;
    subscriptions: MqttSubscription[];
    /** What the Publish action sends; the payload is the request body's text. */
    publishTopic: string;
    publishQos: MqttQos;
    publishRetain: boolean;
    payloadFormat: MqttPayloadFormat;
    /** Most recent messages kept in the log. */
    messageLimit: number;
}

export const DEFAULT_MQTT_PORTS = { mqtt: 1883, mqtts: 8883, ws: 80, wss: 443 } as const;

export const createMqttConfig = (): MqttConfig => ({
    clientId: '',
    protocolVersion: 5,
    keepAliveSeconds: 60,
    cleanSession: true,
    connectTimeoutMs: 30_000,
    reconnectPeriodMs: 0,
    tls: { verifyCertificate: true, caCertificate: '', clientCertificate: '', clientKey: '' },
    will: { enabled: false, topic: '', payload: '', qos: 0, retain: false },
    subscriptions: [],
    publishTopic: '',
    publishQos: 0,
    publishRetain: false,
    payloadFormat: 'text',
    messageLimit: 500,
});

export const createMqttSubscription = (topic = ''): MqttSubscription => ({
    id: createId(),
    topic,
    qos: 0,
    enabled: true,
});

const MAX_TOPIC_BYTES = 65_535;

const topicBytes = (topic: string) =>
    typeof TextEncoder === 'undefined' ? topic.length : new TextEncoder().encode(topic).length;

/** Why a topic cannot be published to, or null when it can. Publishing forbids wildcards. */
export const validatePublishTopic = (topic: string): string | null => {
    if (!topic) return 'Enter a topic to publish to.';
    if (topic.includes('\0')) return 'A topic cannot contain a null character.';
    if (/[+#]/.test(topic)) return 'A publish topic cannot contain the wildcards + or #.';
    if (topicBytes(topic) > MAX_TOPIC_BYTES) return 'The topic is longer than 65,535 bytes.';
    return null;
};

/** Why a subscription filter is invalid, or null when it is valid (`+` and `#` rules of the spec). */
export const validateTopicFilter = (filter: string): string | null => {
    if (!filter) return 'Enter a topic filter.';
    if (filter.includes('\0')) return 'A topic cannot contain a null character.';
    if (topicBytes(filter) > MAX_TOPIC_BYTES) return 'The topic is longer than 65,535 bytes.';
    const levels = filter.split('/');
    for (const [index, level] of levels.entries()) {
        if (level.includes('#') && (level !== '#' || index !== levels.length - 1)) {
            return '# must be the last level and stand alone, e.g. sensors/#.';
        }
        if (level.includes('+') && level !== '+') {
            return '+ must stand alone in a level, e.g. sensors/+/temperature.';
        }
    }
    return null;
};

/** Everything the desktop transport needs to open a connection; secrets are resolved values. */
export interface PreparedMqttConnection {
    url: string;
    clientId: string;
    username: string;
    password: string;
    protocolVersion: MqttProtocolVersion;
    keepAliveSeconds: number;
    cleanSession: boolean;
    connectTimeoutMs: number;
    reconnectPeriodMs: number;
    tls: MqttTlsConfig;
    will: MqttWill | null;
}

export interface MqttPublishInput {
    topic: string;
    /** Text, JSON text or hexadecimal digits, as `format` says. */
    payload: string;
    format: MqttPayloadFormat;
    qos: MqttQos;
    retain: boolean;
}

export interface MqttSubscribeResult {
    topic: string;
    /** Granted QoS, or null when the broker refused the subscription. */
    grantedQos: MqttQos | null;
}

export type MqttEvent =
    | { type: 'status'; status: MqttStatus }
    | {
          type: 'message';
          topic: string;
          /** UTF-8 text when the payload is valid text, otherwise lowercase hex. */
          payload: string;
          encoding: 'text' | 'hex';
          sizeBytes: number;
          qos: MqttQos;
          retain: boolean;
          duplicate: boolean;
      }
    | { type: 'error'; message: string };

export interface MqttMessage {
    id: string;
    direction: 'sent' | 'received' | 'system';
    topic: string;
    payload: string;
    encoding: 'text' | 'hex';
    sizeBytes: number;
    qos: MqttQos;
    retain: boolean;
    timestamp: string;
    error?: boolean;
}

/** MQTT operations the preload exposes. The main process owns the broker connection. */
export interface MqttBridge {
    connect(connectionId: string, prepared: PreparedMqttConnection): Promise<IpcResult<void>>;
    publish(connectionId: string, input: MqttPublishInput): Promise<IpcResult<void>>;
    subscribe(
        connectionId: string,
        subscriptions: { topic: string; qos: MqttQos }[],
    ): Promise<IpcResult<MqttSubscribeResult[]>>;
    unsubscribe(connectionId: string, topics: string[]): Promise<IpcResult<void>>;
    disconnect(connectionId: string): Promise<void>;
    onEvent(listener: (connectionId: string, event: MqttEvent) => void): () => void;
}

/** A live broker connection owned by a runtime. */
export interface MqttConnection {
    readonly id: string;
    publish(input: MqttPublishInput): Promise<void>;
    subscribe(subscriptions: { topic: string; qos: MqttQos }[]): Promise<MqttSubscribeResult[]>;
    unsubscribe(topics: string[]): Promise<void>;
    disconnect(): Promise<void>;
}

export interface MqttRuntime {
    readonly kind: 'browser' | 'electron';
    readonly available: boolean;
    connect(
        prepared: PreparedMqttConnection,
        onEvent: (event: MqttEvent) => void,
    ): Promise<MqttConnection>;
}
