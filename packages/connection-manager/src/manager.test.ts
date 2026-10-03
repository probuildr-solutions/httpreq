/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
    DbError,
    type Capability,
    type ConnectionConfig,
    type DatabaseProvider,
    type Session,
} from '@httpreq/db-core';
import { ConnectionManager, ProviderRegistry, type ConnectionStatus } from './index';

const config = (engine = 'fake', extra: Partial<ConnectionConfig> = {}): ConnectionConfig => ({
    engine,
    host: 'localhost',
    port: 1234,
    tls: { mode: 'disable' },
    connectTimeoutMs: 1000,
    queryTimeoutMs: 0,
    options: {},
    ...extra,
});

class FakeSession implements Session {
    alive = true;
    closed = false;
    pings = 0;
    failPing = false;
    readonly info = { product: 'Fake', version: '1.0', secure: false };
    constructor(readonly serial: number) {}
    async ping() {
        this.pings++;
        if (this.failPing) throw new DbError('CONNECTION_FAILED', 'gone');
    }
    async getPermissions() {
        return { read: true, write: false, schema: false };
    }
    async close() {
        this.closed = true;
        this.alive = false;
    }
}

const makeProvider = (behavior: { failures?: number; authFailure?: boolean } = {}) => {
    const sessions: FakeSession[] = [];
    let remaining = behavior.failures ?? 0;
    let connects = 0;
    const provider: DatabaseProvider = {
        id: 'fake',
        displayName: 'Fake',
        defaultPort: 1,
        capabilities: new Set<Capability>(['sql']),
        createConnector: () => ({
            connect: async () => {
                connects++;
                if (behavior.authFailure) throw new DbError('AUTH_FAILED', 'denied');
                if (remaining-- > 0) throw new DbError('CONNECTION_FAILED', 'refused');
                const session = new FakeSession(sessions.length + 1);
                sessions.push(session);
                return session;
            },
        }),
    };
    return { provider, sessions, connects: () => connects };
};

const manager = (provider: DatabaseProvider, options = {}) =>
    new ConnectionManager(new ProviderRegistry().register(provider), {
        keepAliveMs: 0,
        reconnectDelayMs: 5,
        ...options,
    });

describe('ProviderRegistry', () => {
    it('registers engines by id and refuses duplicates and unknown ids', () => {
        const { provider } = makeProvider();
        const registry = new ProviderRegistry().register(provider);
        expect(registry.get('fake')).toBe(provider);
        expect(registry.list()).toEqual([provider]);
        expect(() => registry.register(provider)).toThrow(/already registered/);
        expect(() => registry.get('nope')).toThrow(/no driver/);
    });
});

describe('ConnectionManager', () => {
    it('tests a connection without keeping it, and reports what the account may do', async () => {
        const { provider, sessions } = makeProvider();
        const result = await manager(provider).test(config());
        expect(result).toMatchObject({
            ok: true,
            server: { product: 'Fake' },
            permissions: { read: true, write: false },
        });
        expect(sessions[0]!.closed).toBe(true);
    });

    it('opens several connections at once and reports each one', async () => {
        const { provider, sessions } = makeProvider();
        const connections = manager(provider);
        const seen: ConnectionStatus[] = [];
        connections.onStatus((status) => seen.push({ ...status }));
        await connections.open('a', config());
        await connections.open('b', config());
        expect(connections.list().map((s) => [s.id, s.state])).toEqual([
            ['a', 'connected'],
            ['b', 'connected'],
        ]);
        expect(await connections.acquire('a')).toBe(sessions[0]);
        expect(await connections.acquire('b')).toBe(sessions[1]);
        expect(seen.map((s) => `${s.id}:${s.state}`)).toEqual([
            'a:connecting',
            'a:connected',
            'b:connecting',
            'b:connected',
        ]);
        await connections.closeAll();
        expect(sessions.every((s) => s.closed)).toBe(true);
        expect(connections.list()).toEqual([]);
    });

    it('replaces a connection opened again under the same id', async () => {
        const { provider, sessions } = makeProvider();
        const connections = manager(provider);
        await connections.open('a', config());
        await connections.open('a', config());
        expect(sessions[0]!.closed).toBe(true);
        expect(await connections.acquire('a')).toBe(sessions[1]);
    });

    it('records a failed open and throws it', async () => {
        const { provider } = makeProvider({ failures: 1 });
        const connections = manager(provider);
        await expect(connections.open('a', config())).rejects.toMatchObject({
            code: 'CONNECTION_FAILED',
        });
        expect(connections.status('a')).toMatchObject({
            state: 'failed',
            error: { code: 'CONNECTION_FAILED' },
        });
        await expect(connections.acquire('missing')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('re-establishes a dropped connection when it is next needed', async () => {
        const { provider, sessions } = makeProvider();
        const connections = manager(provider);
        await connections.open('a', config());
        sessions[0]!.alive = false; // the server went away
        const again = await connections.acquire('a');
        expect(again).toBe(sessions[1]);
        expect(connections.status('a')).toMatchObject({ state: 'connected', reconnects: 1 });
    });

    it('shares one reconnect between callers that ask at the same time', async () => {
        const { provider, sessions, connects } = makeProvider();
        const connections = manager(provider);
        await connections.open('a', config());
        sessions[0]!.alive = false;
        const [x, y, z] = await Promise.all([
            connections.acquire('a'),
            connections.acquire('a'),
            connections.acquire('a'),
        ]);
        expect(x).toBe(y);
        expect(y).toBe(z);
        expect(connects()).toBe(2);
    });

    it('retries with back-off, then gives up', async () => {
        const { provider, sessions, connects } = makeProvider();
        const connections = manager(provider, { reconnectAttempts: 3 });
        await connections.open('a', config());
        sessions[0]!.alive = false;
        // From now on every attempt fails.
        const failing = makeProvider({ failures: 99 });
        (provider as { createConnector: unknown }).createConnector =
            failing.provider.createConnector;
        await expect(connections.acquire('a')).rejects.toMatchObject({ code: 'CONNECTION_FAILED' });
        expect(failing.connects()).toBe(3);
        expect(connections.status('a')).toMatchObject({ state: 'failed' });
        void connects;
    });

    it('does not retry a rejected password', async () => {
        const good = makeProvider();
        const connections = manager(good.provider, { reconnectAttempts: 5 });
        await connections.open('a', config());
        good.sessions[0]!.alive = false;
        const denied = makeProvider({ authFailure: true });
        (good.provider as { createConnector: unknown }).createConnector =
            denied.provider.createConnector;
        await expect(connections.acquire('a')).rejects.toMatchObject({ code: 'AUTH_FAILED' });
        expect(denied.connects()).toBe(1);
    });

    it('notices a dead connection with a periodic ping', async () => {
        const { provider, sessions } = makeProvider();
        const connections = manager(provider, { keepAliveMs: 20 });
        await connections.open('a', config());
        await new Promise((resolve) => setTimeout(resolve, 70));
        expect(sessions[0]!.pings).toBeGreaterThan(0);
        sessions[0]!.failPing = true;
        await new Promise((resolve) => setTimeout(resolve, 70));
        expect(connections.status('a')).toMatchObject({
            state: 'disconnected',
            error: { code: 'CONNECTION_FAILED' },
        });
        await connections.closeAll();
    });

    it('does not reconnect a connection that was closed', async () => {
        const { provider } = makeProvider();
        const connections = manager(provider);
        await connections.open('a', config());
        await connections.close('a');
        await expect(connections.acquire('a')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
});
