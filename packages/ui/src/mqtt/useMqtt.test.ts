/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
    AppError,
    createEmptyRequest,
    createMqttConfig,
    type HttpRequest,
    type MqttConnection,
    type MqttEvent,
    type MqttRuntime,
} from '@httpreq/shared';
import { createWorkspace } from '@httpreq/workspace';
import { resetConnections, useConnectionsStore } from '../connections';
import { useMqttManager } from './useMqtt';

const request = (patch: Partial<HttpRequest> = {}): HttpRequest => {
    const config = createMqttConfig();
    config.publishTopic = 'a/b';
    config.subscriptions = [{ id: 's1', topic: 'cmd/#', qos: 1, enabled: true }];
    return {
        ...createEmptyRequest(),
        id: 'r1',
        protocol: 'mqtt',
        url: 'mqtt://broker.test',
        mqtt: config,
        body: { ...createEmptyRequest().body, text: 'hello' },
        ...patch,
    };
};

interface Fake {
    runtime: MqttRuntime;
    emit: (event: MqttEvent) => void;
    connection: MqttConnection;
    connect: ReturnType<typeof vi.fn>;
}

/** A runtime whose connection the test drives by hand, to observe each state in between. */
const fakeRuntime = (options: { fail?: string } = {}): Fake => {
    let listener: (event: MqttEvent) => void = () => undefined;
    const connection: MqttConnection = {
        id: 'c',
        publish: vi.fn(async () => undefined),
        subscribe: vi.fn(async (subs: { topic: string; qos: 0 | 1 | 2 }[]) =>
            subs.map((s) => ({ topic: s.topic, grantedQos: s.qos })),
        ),
        unsubscribe: vi.fn(async () => undefined),
        disconnect: vi.fn(async () => undefined),
    };
    const connect = vi.fn(async (_prepared: unknown, onEvent: (event: MqttEvent) => void) => {
        listener = onEvent;
        if (options.fail) throw new AppError('NETWORK_ERROR', options.fail);
        return connection;
    });
    return {
        runtime: { kind: 'electron', available: true, connect } as unknown as MqttRuntime,
        emit: (event) => listener(event),
        connection,
        connect,
    };
};

const context = () => ({ workspace: createWorkspace('T'), environment: null });
const status = () => useConnectionsStore.getState().mqtt.r1?.status;

beforeEach(() => resetConnections());

describe('MQTT connection lifecycle', () => {
    it('shows connecting until the broker reports connected, then subscribes', async () => {
        const fake = fakeRuntime();
        const { result } = renderHook(() => useMqttManager(fake.runtime, context));

        await act(() => result.current.connect(request()));
        // The handshake call returned, but the state is still the broker's to report.
        expect(status()).toBe('connecting');

        await act(async () => fake.emit({ type: 'status', status: 'connected' }));
        expect(status()).toBe('connected');
        expect(fake.connection.subscribe).toHaveBeenCalledWith([{ topic: 'cmd/#', qos: 1 }]);
        expect(useConnectionsStore.getState().mqtt.r1?.subscriptions).toEqual({ 'cmd/#': 1 });
    });

    it('ignores Connect while connecting or connected', async () => {
        const fake = fakeRuntime();
        const { result } = renderHook(() => useMqttManager(fake.runtime, context));
        await act(() => result.current.connect(request()));
        await act(() => result.current.connect(request()));
        expect(fake.connect).toHaveBeenCalledTimes(1);
        await act(async () => fake.emit({ type: 'status', status: 'connected' }));
        await act(() => result.current.connect(request()));
        expect(fake.connect).toHaveBeenCalledTimes(1);
    });

    it('goes to error with the reason when the connection fails, and can be retried', async () => {
        const fake = fakeRuntime({ fail: 'The broker refused the connection.' });
        const { result } = renderHook(() => useMqttManager(fake.runtime, context));
        await act(() => result.current.connect(request()));
        expect(status()).toBe('error');
        expect(useConnectionsStore.getState().mqtt.r1?.error).toBe(
            'The broker refused the connection.',
        );
        await act(() => result.current.connect(request()));
        expect(fake.connect).toHaveBeenCalledTimes(2);
    });

    it('reports a request that cannot be prepared without touching the network', async () => {
        const fake = fakeRuntime();
        const { result } = renderHook(() => useMqttManager(fake.runtime, context));
        await act(() => result.current.connect(request({ url: 'https://example.com' })));
        expect(fake.connect).not.toHaveBeenCalled();
        expect(status()).toBe('error');
    });

    it('passes through disconnecting before disconnected, and ignores a second Disconnect', async () => {
        const fake = fakeRuntime();
        let release: () => void = () => undefined;
        vi.mocked(fake.connection.disconnect).mockImplementation(
            () => new Promise<void>((resolve) => (release = resolve)),
        );
        const { result } = renderHook(() => useMqttManager(fake.runtime, context));
        await act(() => result.current.connect(request()));
        await act(async () => fake.emit({ type: 'status', status: 'connected' }));

        let first: Promise<void> = Promise.resolve();
        act(() => {
            first = result.current.disconnect('r1');
        });
        expect(status()).toBe('disconnecting');
        await act(() => result.current.disconnect('r1'));
        expect(fake.connection.disconnect).toHaveBeenCalledTimes(1);

        await act(async () => {
            release();
            await first;
        });
        expect(status()).toBe('disconnected');
    });

    it('logs received messages and trims the log to the limit', async () => {
        const fake = fakeRuntime();
        const req = request();
        req.mqtt!.messageLimit = 2;
        const { result } = renderHook(() => useMqttManager(fake.runtime, context));
        await act(() => result.current.connect(req));
        for (const payload of ['1', '2', '3']) {
            await act(async () =>
                fake.emit({
                    type: 'message',
                    topic: 't',
                    payload,
                    encoding: 'text',
                    sizeBytes: 1,
                    qos: 0,
                    retain: false,
                    duplicate: false,
                }),
            );
        }
        const received = useConnectionsStore
            .getState()
            .mqtt.r1!.messages.filter((m) => m.direction === 'received');
        expect(received.map((m) => m.payload)).toEqual(['2', '3']);
    });

    it('publishes only while connected, and validates the topic', async () => {
        const fake = fakeRuntime();
        const { result } = renderHook(() => useMqttManager(fake.runtime, context));
        await act(() => result.current.connect(request()));
        await act(() => result.current.publish(request()));
        expect(fake.connection.publish).not.toHaveBeenCalled();

        await act(async () => fake.emit({ type: 'status', status: 'connected' }));
        await act(() => result.current.publish(request()));
        expect(fake.connection.publish).toHaveBeenCalledWith(
            expect.objectContaining({ topic: 'a/b', payload: 'hello' }),
        );

        const wildcard = request();
        wildcard.mqtt!.publishTopic = 'a/#';
        await act(() => result.current.publish(wildcard));
        expect(fake.connection.publish).toHaveBeenCalledTimes(1);
    });

    it('closes the session and drops the log when the tab is closed', async () => {
        const fake = fakeRuntime();
        const { result } = renderHook(() => useMqttManager(fake.runtime, context));
        await act(() => result.current.connect(request()));
        await act(async () => fake.emit({ type: 'status', status: 'connected' }));
        act(() => result.current.forget('r1'));
        expect(fake.connection.disconnect).toHaveBeenCalled();
        expect(useConnectionsStore.getState().mqtt.r1).toBeUndefined();
    });
});
