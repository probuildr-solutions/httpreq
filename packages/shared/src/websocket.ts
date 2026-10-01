/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

/**
 * WebSocket domain model. A WebSocket request is a sibling of `HttpRequest`: it lives in the same
 * collection tree, opens in the same tab strip, and resolves the same `{{variables}}`.
 */

import { createId, type AuthConfig, type KeyValueItem } from './model';

export const WEBSOCKET_STATUSES = [
    'disconnected',
    'connecting',
    'connected',
    'disconnecting',
    'error',
] as const;
export type WebSocketStatus = (typeof WEBSOCKET_STATUSES)[number];

export const isWebSocketStatus = (value: unknown): value is WebSocketStatus =>
    typeof value === 'string' && (WEBSOCKET_STATUSES as readonly string[]).includes(value);

/** How a composed message is encoded on the wire. */
export const WEBSOCKET_PAYLOAD_TYPES = ['text', 'json', 'xml', 'binary'] as const;
export type WebSocketPayloadType = (typeof WEBSOCKET_PAYLOAD_TYPES)[number];

export interface WebSocketSettings {
    /** Milliseconds to wait for the handshake; 0 waits indefinitely. */
    handshakeTimeoutMs: number;
    /** Desktop only: verify the server's TLS certificate chain. */
    verifyTls: boolean;
    /** Reconnect automatically after an unclean close. */
    autoReconnect: boolean;
    /** Milliseconds between reconnect attempts. */
    reconnectDelayMs: number;
    /** Most recent messages kept per connection; older ones are dropped. */
    messageLimit: number;
}

export const DEFAULT_WEBSOCKET_SETTINGS: WebSocketSettings = {
    handshakeTimeoutMs: 15_000,
    verifyTls: true,
    autoReconnect: false,
    reconnectDelayMs: 2_000,
    messageLimit: 500,
};

/**
 * A saved WebSocket request. `parentId` places it in the collection tree exactly like an
 * `HttpRequest`; `null` is an unfiled draft.
 */
export interface WebSocketRequest {
    id: string;
    name: string;
    parentId: string | null;
    /** `ws://` or `wss://`, possibly containing `{{variables}}`. */
    url: string;
    /** Mirrors the URL's query string plus disabled parameters that are not in the URL. */
    params: KeyValueItem[];
    /** Sent on the handshake. Only honoured by the desktop runtime; browsers forbid them. */
    headers: KeyValueItem[];
    /** `Sec-WebSocket-Protocol` values offered during the handshake. */
    subprotocols: string[];
    auth: AuthConfig;
    settings: WebSocketSettings;
    /** Message the composer starts with, remembered between sessions. */
    draftPayloadType: WebSocketPayloadType;
    draftMessage: string;
    description: string;
}

export type WebSocketDirection = 'sent' | 'received';

/** A single frame, or a connection-level note (open, close, error) shown in the same list. */
export interface WebSocketMessage {
    id: string;
    direction: WebSocketDirection | 'system';
    payloadType: WebSocketPayloadType | 'system';
    /** Text payloads verbatim; binary payloads as lowercase hex. */
    data: string;
    sizeBytes: number;
    timestamp: string;
    /** Set on system entries that report a failure. */
    error?: boolean;
}

/** Everything a runtime needs to open a socket: variables resolved, authorization applied. */
export interface PreparedWebSocket {
    url: string;
    /** Desktop only; the browser runtime ignores these and warns. */
    headers: Record<string, string>;
    subprotocols: string[];
    handshakeTimeoutMs: number;
    verifyTls: boolean;
}

export type WebSocketEvent =
    | { type: 'open'; protocol: string }
    | { type: 'message'; payloadType: 'text' | 'binary'; data: string; sizeBytes: number }
    | { type: 'close'; code: number; reason: string; clean: boolean }
    | { type: 'error'; message: string };

/** A live socket owned by a runtime. Closing it must release every underlying resource. */
export interface WebSocketConnection {
    readonly id: string;
    send(payload: { kind: 'text'; data: string } | { kind: 'binary'; data: Uint8Array }): void;
    close(code?: number, reason?: string): void;
}

/**
 * Opens WebSocket connections. The browser implementation uses the native `WebSocket`; the
 * desktop implementation forwards to the Electron main process, which can set request headers.
 */
export interface WebSocketRuntime {
    readonly kind: 'browser' | 'electron';
    /** True when `PreparedWebSocket.headers` are actually sent. */
    readonly supportsHeaders: boolean;
    connect(
        prepared: PreparedWebSocket,
        onEvent: (event: WebSocketEvent) => void,
    ): Promise<WebSocketConnection>;
}

export const createWebSocketRequest = (parentId: string | null = null): WebSocketRequest => ({
    id: createId(),
    name: 'Untitled Socket',
    parentId,
    url: '',
    params: [],
    headers: [],
    subprotocols: [],
    auth: parentId ? { type: 'inherit' } : { type: 'none' },
    settings: { ...DEFAULT_WEBSOCKET_SETTINGS },
    draftPayloadType: 'text',
    draftMessage: '',
    description: '',
});

const CONTENT_TYPE: Record<WebSocketPayloadType, string> = {
    text: 'text/plain',
    json: 'application/json',
    xml: 'application/xml',
    binary: 'application/octet-stream',
};

export const payloadContentType = (type: WebSocketPayloadType) => CONTENT_TYPE[type];
