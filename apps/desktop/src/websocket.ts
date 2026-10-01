/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { WebSocket } from 'ws';
import type { PreparedWebSocket, WebSocketEvent } from '@httpreq/shared';

/**
 * WebSocket connections for the desktop app.
 *
 * The renderer cannot open these itself: a browser handshake cannot carry custom headers and
 * cannot relax TLS verification per request. Sockets live here, keyed by the window that opened
 * them, and the renderer only ever holds an id.
 */

const socketKey = (senderId: number, socketId: string) => `${senderId}:${socketId}`;

export type WebSocketEmitter = (senderId: number, socketId: string, event: WebSocketEvent) => void;

/** Rejects anything that is not a WebSocket URL before a socket is created. */
export const parseWebSocketUrl = (value: unknown): URL | null => {
    if (typeof value !== 'string' || !value) return null;
    try {
        const url = new URL(value);
        return url.protocol === 'ws:' || url.protocol === 'wss:' ? url : null;
    } catch {
        return null;
    }
};

const headerRecord = (value: unknown): Record<string, string> => {
    if (!value || typeof value !== 'object') return {};
    const headers: Record<string, string> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        // Header injection through a renderer-supplied name or value is not possible here.
        if (typeof item === 'string' && /^[\w-]+$/.test(key) && !/[\r\n]/.test(item)) {
            headers[key] = item;
        }
    }
    return headers;
};

/** Rebuilds a prepared socket from an untrusted IPC payload. Returns null when it is not usable. */
export const parsePreparedWebSocket = (value: unknown): PreparedWebSocket | null => {
    if (!value || typeof value !== 'object') return null;
    const raw = value as Record<string, unknown>;
    const url = parseWebSocketUrl(raw.url);
    if (!url) return null;
    const timeout = typeof raw.handshakeTimeoutMs === 'number' ? raw.handshakeTimeoutMs : 0;
    return {
        url: url.toString(),
        headers: headerRecord(raw.headers),
        subprotocols: Array.isArray(raw.subprotocols)
            ? raw.subprotocols.filter((item): item is string => typeof item === 'string' && !!item)
            : [],
        handshakeTimeoutMs: Number.isFinite(timeout) && timeout >= 0 ? timeout : 0,
        // Verification is only ever turned off when the renderer asked for it explicitly.
        verifyTls: raw.verifyTls !== false,
    };
};

export class WebSocketManager {
    private readonly sockets = new Map<string, WebSocket>();

    constructor(private readonly emit: WebSocketEmitter) {}

    get size(): number {
        return this.sockets.size;
    }

    open(senderId: number, socketId: string, prepared: PreparedWebSocket): void {
        const key = socketKey(senderId, socketId);
        this.close(senderId, socketId);

        const socket = new WebSocket(prepared.url, prepared.subprotocols, {
            headers: prepared.headers,
            handshakeTimeout:
                prepared.handshakeTimeoutMs > 0 ? prepared.handshakeTimeoutMs : undefined,
            rejectUnauthorized: prepared.verifyTls,
        });
        this.sockets.set(key, socket);
        const send = (event: WebSocketEvent) => this.emit(senderId, socketId, event);

        socket.on('open', () => send({ type: 'open', protocol: socket.protocol }));
        socket.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
            const bytes = Array.isArray(data)
                ? Buffer.concat(data)
                : Buffer.isBuffer(data)
                  ? data
                  : Buffer.from(new Uint8Array(data));
            send(
                isBinary
                    ? {
                          type: 'message',
                          payloadType: 'binary',
                          data: bytes.toString('hex'),
                          sizeBytes: bytes.byteLength,
                      }
                    : {
                          type: 'message',
                          payloadType: 'text',
                          data: bytes.toString('utf8'),
                          sizeBytes: bytes.byteLength,
                      },
            );
        });
        socket.on('error', (error: Error) => send({ type: 'error', message: describe(error) }));
        socket.on('close', (code: number, reason: Buffer) => {
            if (this.sockets.get(key) === socket) this.sockets.delete(key);
            send({
                type: 'close',
                code,
                reason: reason.toString('utf8'),
                // 1000 and 1001 are the orderly closures; everything else ended the connection abruptly.
                clean: code === 1000 || code === 1001,
            });
        });
    }

    sendText(senderId: number, socketId: string, data: string): void {
        this.sockets.get(socketKey(senderId, socketId))?.send(data);
    }

    sendBinary(senderId: number, socketId: string, data: Uint8Array): void {
        this.sockets.get(socketKey(senderId, socketId))?.send(Buffer.from(data));
    }

    close(senderId: number, socketId: string, code?: number, reason?: string): void {
        const key = socketKey(senderId, socketId);
        const socket = this.sockets.get(key);
        if (!socket) return;
        this.sockets.delete(key);
        try {
            // A socket still handshaking has no close frame to send; terminate is the only way out.
            if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
            else socket.close(code ?? 1000, reason);
        } catch {
            socket.terminate();
        }
    }

    disposeForSender(senderId: number): void {
        const prefix = `${senderId}:`;
        for (const key of [...this.sockets.keys()]) {
            if (key.startsWith(prefix)) this.close(senderId, key.slice(prefix.length));
        }
    }

    disposeAll(): void {
        for (const socket of this.sockets.values()) socket.terminate();
        this.sockets.clear();
    }
}

/** A short, non-sensitive reason for the UI. `ws` puts the useful part in `code`. */
const describe = (error: Error): string => {
    const code = (error as { code?: string }).code;
    switch (code) {
        case 'ENOTFOUND':
        case 'EAI_AGAIN':
            return 'The host could not be resolved.';
        case 'ECONNREFUSED':
            return 'The connection was refused.';
        case 'ETIMEDOUT':
            return 'The connection timed out.';
        case 'CERT_HAS_EXPIRED':
        case 'DEPTH_ZERO_SELF_SIGNED_CERT':
        case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
        case 'SELF_SIGNED_CERT_IN_CHAIN':
            return `WebSocket TLS connection failed: ${code}. Turn off certificate verification in Settings to accept it.`;
        default:
            return error.message || 'The WebSocket connection failed.';
    }
};
