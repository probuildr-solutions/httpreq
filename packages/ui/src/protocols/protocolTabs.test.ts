/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { describe, expect, it } from 'vitest';
import { createEmptyRequest, createGrpcConfig, PROTOCOL_IDS, protocolOf } from '@httpreq/shared';
import { deepEqual } from '@httpreq/shared';
import { effectiveTab, PROTOCOL_VIEWS, protocolPatch } from './protocolTabs';

describe('protocol views', () => {
    it('defines a view for every protocol, whose default tab is one of its tabs', () => {
        for (const id of PROTOCOL_IDS) {
            const view = PROTOCOL_VIEWS[id];
            expect(view.tabs).toContain(view.defaultTab);
            expect(view.tabs).toContain('code');
        }
    });

    it('falls back to the protocol’s first tab when the remembered one does not exist', () => {
        expect(effectiveTab('http', 'body')).toBe('body');
        expect(effectiveTab('grpc', 'body')).toBe('protocol');
        expect(effectiveTab('mqtt', undefined)).toBe('protocol');
    });

    it('only MQTT is a session without a response pane', () => {
        expect(PROTOCOL_VIEWS.mqtt.hasResponsePane).toBe(false);
        expect(
            PROTOCOL_VIEWS.http.sends && PROTOCOL_VIEWS.soap.sends && PROTOCOL_VIEWS.grpc.sends,
        ).toBe(true);
    });
});

describe('switching protocol', () => {
    const base = createEmptyRequest();

    it('adds the protocol configuration and adjusts only what the protocol needs', () => {
        const patch = protocolPatch({ ...base, method: 'GET' }, 'grpc');
        expect(patch).toMatchObject({ protocol: 'grpc', method: 'POST' });
        expect(patch.grpc).toEqual(createGrpcConfig());
        expect(patch.body?.mode).toBe('json');
    });

    it('keeps a configuration the user already made when switching away and back', () => {
        const configured = {
            ...base,
            grpc: { ...createGrpcConfig(), service: 'a.B', method: 'C' },
        };
        expect(protocolPatch(configured, 'grpc').grpc).toBe(configured.grpc);
    });

    it('returns to plain HTTP without leaving anything that makes the request look edited', () => {
        const grpc = { ...base, ...protocolPatch(base, 'grpc') };
        const back = { ...grpc, ...protocolPatch(grpc, 'http') };
        expect(protocolOf(back)).toBe('http');
        expect(
            deepEqual({ ...back, grpc: undefined, method: base.method, body: base.body }, base),
        ).toBe(true);
    });
});
