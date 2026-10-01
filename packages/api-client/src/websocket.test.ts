/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { describe, expect, it } from 'vitest';
import {
    createCollection,
    createEnvironment,
    createId,
    createWebSocketRequest,
    type Environment,
    type Workspace,
} from '@httpreq/shared';
import { createWorkspace } from '@httpreq/workspace';
import { buildWebSocket, bytesToHex, hexToBytes, toWebSocketUrl } from './websocket';

const environment = (variables: Record<string, string>): Environment => ({
    ...createEnvironment('Dev'),
    variables: Object.entries(variables).map(([key, value]) => ({
        id: createId(),
        key,
        value,
        enabled: true,
        secret: false,
    })),
});

const context = (workspace: Workspace, env: Environment | null = null) => ({
    workspace,
    environment: env,
});

describe('toWebSocketUrl', () => {
    it('leaves ws and wss alone, upgrades http, and assumes ws otherwise', () => {
        expect(toWebSocketUrl('wss://a.dev/s')).toBe('wss://a.dev/s');
        expect(toWebSocketUrl('ws://a.dev/s')).toBe('ws://a.dev/s');
        expect(toWebSocketUrl('https://a.dev/s')).toBe('wss://a.dev/s');
        expect(toWebSocketUrl('http://a.dev/s')).toBe('ws://a.dev/s');
        expect(toWebSocketUrl('localhost:8080/s')).toBe('ws://localhost:8080/s');
        expect(toWebSocketUrl('')).toBe('');
    });
});

describe('buildWebSocket', () => {
    it('resolves variables in the URL, headers and subprotocols', async () => {
        const request = {
            ...createWebSocketRequest(null),
            url: 'wss://{{WS_HOST}}/notifications',
            headers: [{ id: '1', key: 'X-Tenant', value: '{{tenant}}', enabled: true }],
            subprotocols: ['{{protocol}}'],
        };
        const built = await buildWebSocket(
            request,
            context(
                createWorkspace(),
                environment({ WS_HOST: 'api.example.com', tenant: 'acme', protocol: 'json' }),
            ),
        );

        expect(built.prepared.url).toBe('wss://api.example.com/notifications');
        expect(built.prepared.headers).toEqual({ 'X-Tenant': 'acme' });
        expect(built.prepared.subprotocols).toEqual(['json']);
    });

    it('refuses a URL whose host is an undefined variable, and says which one', async () => {
        const request = { ...createWebSocketRequest(null), url: 'wss://{{WS_HOST}}/s' };
        await expect(buildWebSocket(request, context(createWorkspace()))).rejects.toThrow(
            /WS_HOST/,
        );
    });

    it('refuses a URL that is not a WebSocket URL', async () => {
        const request = { ...createWebSocketRequest(null), url: 'mailto:someone@example.com' };
        await expect(buildWebSocket(request, context(createWorkspace()))).rejects.toThrow(
            /ws:\/\/ or wss:\/\//,
        );
    });

    it('drops headers and warns when the runtime cannot send them', async () => {
        const request = {
            ...createWebSocketRequest(null),
            url: 'wss://a.dev/s',
            headers: [{ id: '1', key: 'X-Tenant', value: 'acme', enabled: true }],
        };
        const built = await buildWebSocket(request, context(createWorkspace()), false);

        expect(built.prepared.headers).toEqual({});
        expect(built.warnings.join(' ')).toMatch(/Browsers cannot send handshake headers/);
    });

    it('applies the collection’s authorization, the same as an HTTP request', async () => {
        const collection = {
            ...createCollection('API'),
            auth: { type: 'bearer' as const, token: 'abc123', prefix: 'Bearer' },
        };
        const request = {
            ...createWebSocketRequest(collection.id),
            url: 'wss://a.dev/s',
            auth: { type: 'inherit' as const },
        };
        const workspace = {
            ...createWorkspace(),
            collections: [collection],
            websocketRequests: [request],
        };

        const built = await buildWebSocket(request, context(workspace));
        expect(built.prepared.headers.Authorization).toBe('Bearer abc123');
        expect(built.effectiveAuth.source.kind).toBe('collection');
    });

    it('puts an API key in the query string when the authorization says so', async () => {
        const request = {
            ...createWebSocketRequest(null),
            url: 'wss://a.dev/s',
            auth: {
                type: 'api-key' as const,
                key: 'token',
                value: 'abc',
                location: 'query' as const,
            },
        };
        const built = await buildWebSocket(request, context(createWorkspace()));
        expect(built.prepared.url).toBe('wss://a.dev/s?token=abc');
    });

    it('carries the handshake timeout and TLS setting through', async () => {
        const request = {
            ...createWebSocketRequest(null),
            url: 'wss://a.dev/s',
            settings: {
                handshakeTimeoutMs: 5000,
                verifyTls: false,
                autoReconnect: false,
                reconnectDelayMs: 2000,
                messageLimit: 100,
            },
        };
        const built = await buildWebSocket(request, context(createWorkspace()));
        expect(built.prepared).toMatchObject({ handshakeTimeoutMs: 5000, verifyTls: false });
    });

    it('warns about an undefined variable in the path rather than refusing to connect', async () => {
        const request = { ...createWebSocketRequest(null), url: 'wss://a.dev/{{room}}' };
        const built = await buildWebSocket(request, context(createWorkspace()));
        expect(built.prepared.url).toContain('room');
        expect(built.warnings.join(' ')).toMatch(/\{\{room\}\}/);
    });
});

describe('binary payload encoding', () => {
    it('round trips bytes through hex', () => {
        const bytes = new Uint8Array([0, 15, 16, 255]);
        expect(bytesToHex(bytes)).toBe('000f10ff');
        expect(hexToBytes('000f10ff')).toEqual(bytes);
    });

    it('accepts the spaced and colon-separated forms people paste', () => {
        expect(hexToBytes('48 65 6c')).toEqual(new Uint8Array([0x48, 0x65, 0x6c]));
        expect(hexToBytes('48:65:6c')).toEqual(new Uint8Array([0x48, 0x65, 0x6c]));
    });

    it('rejects anything that is not whole bytes of hex', () => {
        expect(() => hexToBytes('abc')).toThrow(/hexadecimal/i);
        expect(() => hexToBytes('zz')).toThrow(/hexadecimal/i);
    });
});
