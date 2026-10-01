/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { describe, expect, it } from 'vitest';
import { parsePreparedWebSocket, parseWebSocketUrl } from './websocket';

describe('parseWebSocketUrl', () => {
    it('accepts ws and wss only', () => {
        expect(parseWebSocketUrl('wss://a.dev/s')?.toString()).toBe('wss://a.dev/s');
        expect(parseWebSocketUrl('ws://a.dev/s')?.toString()).toBe('ws://a.dev/s');
    });

    it('rejects every other scheme the renderer might send', () => {
        for (const url of [
            'https://a.dev',
            'file:///etc/passwd',
            'javascript:alert(1)',
            '',
            'nonsense',
        ]) {
            expect(parseWebSocketUrl(url)).toBeNull();
        }
        expect(parseWebSocketUrl(42)).toBeNull();
        expect(parseWebSocketUrl(null)).toBeNull();
    });
});

describe('parsePreparedWebSocket', () => {
    const valid = {
        url: 'wss://a.dev/s',
        headers: { 'X-Tenant': 'acme' },
        subprotocols: ['json'],
        handshakeTimeoutMs: 5000,
        verifyTls: true,
    };

    it('accepts a well-formed payload', () => {
        expect(parsePreparedWebSocket(valid)).toEqual(valid);
    });

    it('rejects a payload with no usable URL', () => {
        expect(parsePreparedWebSocket({ ...valid, url: 'https://a.dev' })).toBeNull();
        expect(parsePreparedWebSocket(null)).toBeNull();
        expect(parsePreparedWebSocket('wss://a.dev')).toBeNull();
    });

    it('drops header names and values that could forge a request', () => {
        const parsed = parsePreparedWebSocket({
            ...valid,
            headers: {
                Good: 'fine',
                'Bad Name': 'x',
                Injected: 'a\r\nX-Admin: true',
                'Also:Bad': 'x',
            },
        });
        expect(parsed?.headers).toEqual({ Good: 'fine' });
    });

    it('keeps TLS verification on unless it was explicitly switched off', () => {
        expect(parsePreparedWebSocket({ ...valid, verifyTls: undefined })?.verifyTls).toBe(true);
        expect(parsePreparedWebSocket({ ...valid, verifyTls: 'no' })?.verifyTls).toBe(true);
        expect(parsePreparedWebSocket({ ...valid, verifyTls: false })?.verifyTls).toBe(false);
    });

    it('ignores non-string subprotocols and a nonsense timeout', () => {
        const parsed = parsePreparedWebSocket({
            ...valid,
            subprotocols: ['json', 42, null, ''],
            handshakeTimeoutMs: -1,
        });
        expect(parsed?.subprotocols).toEqual(['json']);
        expect(parsed?.handshakeTimeoutMs).toBe(0);
    });
});
