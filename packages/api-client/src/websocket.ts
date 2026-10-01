/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import {
    AppError,
    type PreparedWebSocket,
    type WebSocketConnection,
    type WebSocketEvent,
    type WebSocketRequest,
    type WebSocketRuntime,
} from '@httpreq/shared';
import { getAuthProvider, resolveEffectiveAuth, type EffectiveAuth } from './auth/registry';
import { HeaderMap, type AuthContext, type RequestDraft } from './auth/types';
import type { PipelineContext } from './pipeline';
import { createVariableResolver } from './variables';

/**
 * The WebSocket half of the execution pipeline. It mirrors {@link buildRequest}: the saved request
 * is never mutated, `{{variables}}` are resolved once, and authorization is applied through the
 * same providers as HTTP, so a collection's auth covers its sockets too.
 */

export interface BuiltWebSocket {
    prepared: PreparedWebSocket;
    effectiveAuth: EffectiveAuth;
    warnings: string[];
}

const WS_SCHEME = /^wss?:\/\//i;
const HTTP_SCHEME = /^https?:\/\//i;

/** Any other explicit scheme is left as written, so validation can reject it by name. */
const ANY_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * `https://host` is accepted and upgraded to `wss://host`, as browsers do for the handshake, and a
 * bare `host:port/path` is assumed to be `ws://`.
 */
export const toWebSocketUrl = (text: string): string => {
    if (!text) return text;
    if (WS_SCHEME.test(text)) return text;
    if (HTTP_SCHEME.test(text)) return text.replace(/^http/i, 'ws');
    // `localhost:8080` looks like a scheme to the regex, so a bare host:port is detected first.
    if (ANY_SCHEME.test(text) && !/^[^:/?#]+:\d/.test(text)) return text;
    return `ws://${text}`;
};

const enabledRows = <T extends { enabled: boolean; key: string }>(items: T[]) =>
    items.filter((item) => item.enabled && item.key.trim() !== '');

export const buildWebSocket = async (
    request: WebSocketRequest,
    context: PipelineContext,
    /** False for the browser runtime, whose handshake cannot carry custom headers. */
    supportsHeaders = true,
): Promise<BuiltWebSocket> => {
    const warnings: string[] = [];
    const resolver = createVariableResolver(context.environment, context.resolverOptions);
    const authContext: AuthContext = { resolve: resolver.resolve, now: context.now ?? Date.now };

    const urlText = toWebSocketUrl(resolver.resolve(request.url.trim()));
    const undefinedInUrl = [...resolver.unresolved];
    if (!urlText) throw new AppError('INVALID_REQUEST', 'Enter a WebSocket URL before connecting.');
    let url: URL | undefined;
    try {
        url = new URL(urlText);
    } catch {
        url = undefined;
    }
    const validScheme = url?.protocol === 'ws:' || url?.protocol === 'wss:';
    const unresolvedHost = !!url && (url.host.includes('%7B%7B') || url.host.includes('{{'));
    if (!url || !validScheme || unresolvedHost) {
        if (undefinedInUrl.length) {
            const names = undefinedInUrl.map((name) => `{{${name}}}`).join(', ');
            const scope = context.environment
                ? `the “${context.environment.name}” environment`
                : 'any environment (none is selected)';
            throw new AppError(
                'INVALID_REQUEST',
                `${names} in the URL is not defined in ${scope}.`,
            );
        }
        throw new AppError(
            'INVALID_REQUEST',
            `“${urlText}” is not a valid WebSocket URL. Use ws:// or wss://.`,
        );
    }

    const headers = new HeaderMap();
    enabledRows(request.headers).forEach((item) =>
        headers.set(resolver.resolve(item.key.trim()), resolver.resolve(item.value)),
    );
    // The auth providers work on an HTTP draft; the handshake is an HTTP GET, so this is exact.
    const draft: RequestDraft = { method: 'GET', url, headers };

    const effectiveAuth = resolveEffectiveAuth(context.workspace, request);
    const provider = getAuthProvider(effectiveAuth.auth);
    const blocking = provider
        .validate(effectiveAuth.auth)
        .filter((issue) => issue.severity === 'error');
    if (blocking.length) {
        throw new AppError('AUTHENTICATION_ERROR', `${provider.label}: ${blocking[0]!.message}`);
    }
    const resolvedAuth = provider.resolve(effectiveAuth.auth, authContext);
    await provider.applyToRequest(resolvedAuth, draft, authContext);

    const headerRecord = headers.toRecord();
    if (!supportsHeaders && Object.keys(headerRecord).length) {
        warnings.push(
            'Browsers cannot send handshake headers, so they were skipped. Use a query parameter, a subprotocol, or the desktop app.',
        );
    }
    if (resolver.unresolved.size > 0) {
        warnings.push(
            `Not defined, used as written: ${[...resolver.unresolved].map((name) => `{{${name}}}`).join(', ')}.`,
        );
    }

    return {
        prepared: {
            url: draft.url.toString(),
            headers: supportsHeaders ? headerRecord : {},
            subprotocols: request.subprotocols
                .map((item) => resolver.resolve(item).trim())
                .filter(Boolean),
            handshakeTimeoutMs: request.settings.handshakeTimeoutMs,
            verifyTls: request.settings.verifyTls,
        },
        effectiveAuth,
        warnings,
    };
};

/** Hex form used to carry binary frames through the UI and the message log. */
export const bytesToHex = (bytes: Uint8Array): string =>
    Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

export const hexToBytes = (hex: string): Uint8Array => {
    const clean = hex.replace(/[\s:]/g, '');
    if (clean.length % 2 !== 0 || /[^0-9a-f]/i.test(clean)) {
        throw new AppError('INVALID_REQUEST', 'Enter binary data as pairs of hexadecimal digits.');
    }
    const bytes = new Uint8Array(clean.length / 2);
    for (let index = 0; index < bytes.length; index += 1) {
        bytes[index] = Number.parseInt(clean.slice(index * 2, index * 2 + 2), 16);
    }
    return bytes;
};

const textSize = (text: string) =>
    typeof TextEncoder === 'undefined' ? text.length : new TextEncoder().encode(text).byteLength;

/**
 * Native `WebSocket`, for the browser. The handshake is controlled by the browser, so headers and
 * TLS verification settings cannot be applied here; {@link buildWebSocket} warns when they were set.
 */
export class BrowserWebSocketRuntime implements WebSocketRuntime {
    readonly kind = 'browser' as const;
    readonly supportsHeaders = false;

    async connect(
        prepared: PreparedWebSocket,
        onEvent: (event: WebSocketEvent) => void,
    ): Promise<WebSocketConnection> {
        let socket: WebSocket;
        try {
            socket = prepared.subprotocols.length
                ? new WebSocket(prepared.url, prepared.subprotocols)
                : new WebSocket(prepared.url);
        } catch (cause) {
            throw new AppError(
                'INVALID_REQUEST',
                `The WebSocket URL was rejected: ${String(cause)}`,
                {
                    cause,
                },
            );
        }
        socket.binaryType = 'arraybuffer';

        socket.onopen = () => onEvent({ type: 'open', protocol: socket.protocol });
        socket.onmessage = (event: MessageEvent<string | ArrayBuffer>) => {
            if (typeof event.data === 'string') {
                onEvent({
                    type: 'message',
                    payloadType: 'text',
                    data: event.data,
                    sizeBytes: textSize(event.data),
                });
            } else {
                const bytes = new Uint8Array(event.data);
                onEvent({
                    type: 'message',
                    payloadType: 'binary',
                    data: bytesToHex(bytes),
                    sizeBytes: bytes.byteLength,
                });
            }
        };
        // The browser deliberately hides the reason a handshake failed (it would leak cross-origin
        // information), so the close event that follows carries what little detail there is.
        socket.onerror = () =>
            onEvent({
                type: 'error',
                message:
                    'WebSocket connection failed. Check the URL, that the server is reachable, and its TLS certificate.',
            });
        socket.onclose = (event: CloseEvent) =>
            onEvent({
                type: 'close',
                code: event.code,
                reason: event.reason,
                clean: event.wasClean,
            });

        return {
            id: prepared.url,
            send: (payload) => {
                if (socket.readyState !== WebSocket.OPEN) {
                    throw new AppError('NETWORK_ERROR', 'The WebSocket is not connected.');
                }
                if (payload.kind === 'text') socket.send(payload.data);
                // A copy, because `send` may keep the buffer past this call.
                else socket.send(payload.data.slice().buffer as ArrayBuffer);
            },
            close: (code, reason) => {
                if (socket.readyState === WebSocket.CLOSED) return;
                socket.close(code ?? 1000, reason);
            },
        };
    }
}

/**
 * Desktop runtime. The socket itself lives in the Electron main process, which can set handshake
 * headers and honour the TLS setting; the renderer only ever holds an id.
 */
export class ElectronWebSocketRuntime implements WebSocketRuntime {
    readonly kind = 'electron' as const;
    readonly supportsHeaders = true;

    private nextId = 0;
    private readonly listeners = new Map<string, (event: WebSocketEvent) => void>();
    private unsubscribe: (() => void) | null = null;

    private bridge() {
        const bridge = window.httpreq?.webSocket;
        if (!bridge)
            throw new AppError('NETWORK_ERROR', 'The desktop WebSocket bridge is unavailable.');
        return bridge;
    }

    async connect(
        prepared: PreparedWebSocket,
        onEvent: (event: WebSocketEvent) => void,
    ): Promise<WebSocketConnection> {
        const bridge = this.bridge();
        // One IPC subscription serves every socket; each event carries the id it belongs to.
        this.unsubscribe ??= bridge.onEvent((socketId, event) =>
            this.listeners.get(socketId)?.(event),
        );

        this.nextId += 1;
        const socketId = `ws-${this.nextId}`;
        const release = () => {
            this.listeners.delete(socketId);
            if (this.listeners.size === 0) {
                this.unsubscribe?.();
                this.unsubscribe = null;
            }
        };
        this.listeners.set(socketId, (event) => {
            onEvent(event);
            if (event.type === 'close') release();
        });

        const result = await bridge.open(socketId, prepared);
        if (!result.ok) {
            release();
            throw new AppError(result.error.code, result.error.message);
        }

        return {
            id: socketId,
            send: (payload) => {
                if (payload.kind === 'text') bridge.sendText(socketId, payload.data);
                else bridge.sendBinary(socketId, payload.data);
            },
            close: (code, reason) => bridge.close(socketId, code, reason),
        };
    }
}
