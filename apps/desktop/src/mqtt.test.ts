/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { createMqttConfig } from '@httpreq/shared';
import {
    describeMqttError,
    parseMqttPublish,
    parseMqttSubscriptions,
    parseMqttTopics,
    parsePreparedMqtt,
} from './mqtt';

const prepared = (patch: Record<string, unknown> = {}) => ({
    url: 'mqtts://broker.example.com:8883',
    clientId: 'c1',
    username: 'ada',
    password: 'secret',
    protocolVersion: 5,
    keepAliveSeconds: 60,
    cleanSession: true,
    connectTimeoutMs: 30000,
    reconnectPeriodMs: 0,
    tls: { ...createMqttConfig().tls },
    will: null,
    ...patch,
});

const PEM = '-----BEGIN CERTIFICATE-----\nABC\n-----END CERTIFICATE-----';

describe('MQTT connection validation', () => {
    it('accepts a well-formed connection', () => {
        expect(parsePreparedMqtt(prepared())).toMatchObject({
            url: 'mqtts://broker.example.com:8883',
            clientId: 'c1',
            protocolVersion: 5,
        });
    });

    it('only accepts MQTT and WebSocket schemes', () => {
        expect(parsePreparedMqtt(prepared({ url: 'http://broker' }))).toBeNull();
        expect(parsePreparedMqtt(prepared({ url: 'file:///etc/passwd' }))).toBeNull();
        expect(parsePreparedMqtt(prepared({ url: 'not a url' }))).toBeNull();
        expect(parsePreparedMqtt(prepared({ url: 'wss://broker/mqtt' }))).not.toBeNull();
    });

    it('requires certificates to look like PEM and verification on by default', () => {
        const tls = {
            verifyCertificate: undefined,
            caCertificate: PEM,
            clientCertificate: '',
            clientKey: '',
        };
        expect(parsePreparedMqtt(prepared({ tls }))?.tls.verifyCertificate).toBe(true);
        expect(
            parsePreparedMqtt(prepared({ tls: { ...tls, caCertificate: 'not a certificate' } })),
        ).toBeNull();
        expect(
            parsePreparedMqtt(prepared({ tls: { ...tls, verifyCertificate: false } }))?.tls
                .verifyCertificate,
        ).toBe(false);
    });

    it('validates the last will and clamps numbers', () => {
        expect(
            parsePreparedMqtt(
                prepared({ will: { enabled: true, topic: 'a/+', payload: 'x', qos: 0 } }),
            ),
        ).toBeNull();
        const parsed = parsePreparedMqtt(
            prepared({
                will: { enabled: true, topic: 'status', payload: 'gone', qos: 1, retain: true },
                keepAliveSeconds: 10 ** 9,
            }),
        );
        expect(parsed?.will).toMatchObject({ topic: 'status', qos: 1, retain: true });
        expect(parsed?.keepAliveSeconds).toBe(65535);
    });

    it('rejects oversized or NUL-containing text', () => {
        expect(parsePreparedMqtt(prepared({ clientId: 'a'.repeat(300) }))).toBeNull();
        expect(parsePreparedMqtt(prepared({ username: 'a\0b' }))).toBeNull();
    });
});

describe('MQTT message validation', () => {
    it('validates publish input', () => {
        expect(
            parseMqttPublish({ topic: 'a/b', payload: 'x', format: 'text', qos: 1, retain: true }),
        ).toEqual({ topic: 'a/b', payload: 'x', format: 'text', qos: 1, retain: true });
        expect(parseMqttPublish({ topic: 'a/#', payload: 'x', format: 'text', qos: 0 })).toBeNull();
        expect(parseMqttPublish({ topic: 'a', payload: 'x', format: 'text', qos: 3 })).toBeNull();
        expect(parseMqttPublish({ topic: 'a', payload: 'zz', format: 'hex', qos: 0 })).toBeNull();
        expect(
            parseMqttPublish({ topic: 'a', payload: 'de ad', format: 'hex', qos: 0 }),
        ).not.toBeNull();
        expect(parseMqttPublish({ topic: 'a', payload: 'x', format: 'binary', qos: 0 })).toBeNull();
    });

    it('validates subscription filters and topics', () => {
        expect(parseMqttSubscriptions([{ topic: 'a/+/c', qos: 1 }])).toEqual([
            { topic: 'a/+/c', qos: 1 },
        ]);
        expect(parseMqttSubscriptions([{ topic: 'a/#/c', qos: 1 }])).toBeNull();
        expect(parseMqttSubscriptions('nope')).toBeNull();
        expect(parseMqttTopics(['a/#'])).toEqual(['a/#']);
        expect(parseMqttTopics(['a#'])).toBeNull();
    });
});

describe('MQTT errors', () => {
    it('describes failures without leaking credentials', () => {
        expect(describeMqttError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))).toMatch(
            /refused/,
        );
        expect(describeMqttError(Object.assign(new Error('x'), { code: 4 }))).toMatch(
            /user name or password/,
        );
        expect(describeMqttError(new Error('failed password=hunter2 for user'))).not.toContain(
            'hunter2',
        );
    });
});
