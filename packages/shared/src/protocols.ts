/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

/**
 * Protocol identity. A request carries a `protocol`; absent means plain HTTP, so every request
 * saved before protocols existed keeps working unchanged. Each non-HTTP protocol stores its own
 * configuration under a dedicated key (`soap`, `grpc`, `mqtt`) next to the fields every request
 * shares (URL, headers, authorization, body, scripts).
 */

export const PROTOCOL_IDS = ['http', 'soap', 'grpc', 'mqtt'] as const;
export type ProtocolId = (typeof PROTOCOL_IDS)[number];

export const isProtocolId = (value: unknown): value is ProtocolId =>
    typeof value === 'string' && (PROTOCOL_IDS as readonly string[]).includes(value);

export interface ProtocolInfo {
    id: ProtocolId;
    label: string;
    /** Badge text in the explorer and tab strip, where an HTTP verb would be. */
    badge: string;
    description: string;
    /** Needs the desktop app: the transport cannot run in a browser. */
    desktopOnly: boolean;
    /** One-shot request/response (Send) rather than a long-lived connection. */
    exchange: 'request-response' | 'session';
    placeholderUrl: string;
}

export const PROTOCOLS: Readonly<Record<ProtocolId, ProtocolInfo>> = {
    http: {
        id: 'http',
        label: 'HTTP',
        badge: 'HTTP',
        description: 'REST and any other HTTP request.',
        desktopOnly: false,
        exchange: 'request-response',
        placeholderUrl: '{{base_url}}/users or https://api.example.com/users',
    },
    soap: {
        id: 'soap',
        label: 'SOAP',
        badge: 'SOAP',
        description: 'SOAP 1.1 / 1.2 web services, with optional WSDL discovery.',
        desktopOnly: false,
        exchange: 'request-response',
        placeholderUrl: 'https://example.com/service.asmx',
    },
    grpc: {
        id: 'grpc',
        label: 'gRPC',
        badge: 'gRPC',
        description: 'Unary and server-streaming gRPC calls described by .proto files.',
        desktopOnly: true,
        exchange: 'request-response',
        placeholderUrl: 'grpc://localhost:50051 or grpcs://api.example.com:443',
    },
    mqtt: {
        id: 'mqtt',
        label: 'MQTT',
        badge: 'MQTT',
        description: 'Publish and subscribe on an MQTT 3.1.1 / 5 broker.',
        desktopOnly: true,
        exchange: 'session',
        placeholderUrl: 'mqtt://broker.example.com:1883 or mqtts://broker.example.com:8883',
    },
};

/** The protocol of any request-shaped object; objects saved before protocols existed are HTTP. */
export const protocolOf = (request: { protocol?: ProtocolId }): ProtocolId =>
    request.protocol ?? 'http';
