/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { describe, expect, it } from 'vitest';
import { createEmptyRequest } from '@httpreq/shared';
import { normalizeRequest } from './index';
import { normalizeGrpc, normalizeMqtt, normalizeProtocolFields, normalizeSoap } from './protocols';

describe('protocol normalization', () => {
    it('leaves HTTP requests exactly as before', () => {
        const normalized = normalizeRequest({ ...createEmptyRequest() }, null);
        expect(normalized).not.toHaveProperty('protocol');
        expect(normalized).not.toHaveProperty('soap');
        expect(normalizeProtocolFields({ protocol: 'http' })).toEqual({});
        expect(normalizeProtocolFields({ protocol: 'ftp' })).toEqual({});
    });

    it('restores each protocol’s configuration and fills what is missing', () => {
        const soap = normalizeRequest(
            { ...createEmptyRequest(), protocol: 'soap', soap: { action: 'a' } },
            null,
        );
        expect(soap.protocol).toBe('soap');
        expect(soap.soap).toMatchObject({ version: '1.1', action: 'a', headerXml: '' });
        expect(normalizeRequest({ protocol: 'grpc' }, null).grpc).toMatchObject({
            protoFiles: [],
            deadlineMs: 30000,
        });
        expect(normalizeRequest({ protocol: 'mqtt' }, null).mqtt).toMatchObject({
            protocolVersion: 5,
        });
    });

    it('rejects wrong types instead of trusting them', () => {
        expect(normalizeSoap({ version: '9.9', action: 7, wsdl: {} })).toMatchObject({
            version: '1.1',
            action: '',
            wsdl: '',
        });
        const mqtt = normalizeMqtt({
            protocolVersion: 9,
            keepAliveSeconds: -5,
            subscriptions: [{ topic: 5, qos: 7 }, 'x', { topic: 'a/#', qos: 2, enabled: false }],
            will: 'nope',
        });
        expect(mqtt.protocolVersion).toBe(5);
        expect(mqtt.keepAliveSeconds).toBe(60);
        expect(mqtt.subscriptions.map((s) => [s.topic, s.qos, s.enabled])).toEqual([
            ['', 0, true],
            ['a/#', 2, false],
        ]);
    });

    it('never reads a TLS private key back from stored or imported data', () => {
        const mqtt = normalizeMqtt({ tls: { clientKey: 'KEY', caCertificate: 'CA' } });
        expect(mqtt.tls.clientKey).toBe('');
        expect(mqtt.tls.caCertificate).toBe('CA');
    });

    it('bounds the size and number of definitions', () => {
        const grpc = normalizeGrpc({
            protoFiles: Array.from({ length: 80 }, (_, i) => ({
                name: `f${i}.proto`,
                content: 'x',
            })),
        });
        expect(grpc.protoFiles).toHaveLength(50);
        const big = normalizeSoap({ wsdl: 'x'.repeat(3 * 1024 * 1024) });
        expect(big.wsdl.length).toBe(2 * 1024 * 1024);
    });
});
