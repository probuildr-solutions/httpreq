/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { DbError, type ConnectionConfig } from '@httpreq/db-core';
import type { MongoConnection, MongoConnectOptions } from '@httpreq/db-protocol-mongo';
import { connectToTopology, resolveTopology, type DnsResolver } from './topology';

const config = (host: string, options: Record<string, string> = {}): ConnectionConfig => ({
    engine: 'mongodb',
    host,
    port: 27017,
    tls: { mode: 'verify-full' },
    connectTimeoutMs: 5000,
    queryTimeoutMs: 0,
    options,
});

const dnsError = (code: string) => Object.assign(new Error(code), { code });

const resolver = (
    srv: { name: string; port: number }[] | Error,
    txt: string[][] | Error = [],
): DnsResolver => ({
    resolveSrv: async () => {
        if (srv instanceof Error) throw srv;
        return srv;
    },
    resolveTxt: async () => {
        if (txt instanceof Error) throw txt;
        return txt;
    },
});

describe('mongodb+srv', () => {
    const cluster = 'cluster0.ab1cd.mongodb.net';
    const shards = [
        { name: 'cluster0-shard-00-00.ab1cd.mongodb.net', port: 27017 },
        { name: 'cluster0-shard-00-01.ab1cd.mongodb.net', port: 27017 },
    ];

    it('uses the SRV records as the seed list and the TXT record for authSource and replicaSet', async () => {
        const topology = await resolveTopology(
            config(cluster, { srv: 'true' }),
            resolver(shards, [['authSource=admin&replicaSet=atlas-xyz-shard-0']]),
        );
        expect(topology.srv).toBe(true);
        expect(topology.seeds.map((s) => s.host)).toEqual(shards.map((s) => s.name));
        expect(topology.options).toMatchObject({
            authSource: 'admin',
            replicaSet: 'atlas-xyz-shard-0',
        });
    });

    it('lets options from the connection string override the TXT record', async () => {
        const topology = await resolveTopology(
            config(cluster, { srv: 'true', authSource: 'users' }),
            resolver(shards, [['authSource=admin']]),
        );
        expect(topology.options.authSource).toBe('users');
    });

    it('refuses an SRV target outside the cluster domain', async () => {
        await expect(
            resolveTopology(
                config(cluster, { srv: 'true' }),
                resolver([{ name: 'evil.example.com', port: 27017 }]),
            ),
        ).rejects.toThrow(/outside/);
    });

    it('explains a failed SRV lookup, a missing record and a DNS timeout', async () => {
        await expect(
            resolveTopology(config(cluster, { srv: 'true' }), resolver(dnsError('ENOTFOUND'))),
        ).rejects.toThrow(/no SRV records/);
        await expect(
            resolveTopology(config(cluster, { srv: 'true' }), resolver(dnsError('ETIMEOUT'))),
        ).rejects.toThrow(/did not answer/);
        await expect(
            resolveTopology(config(cluster, { srv: 'true' }), resolver([])),
        ).rejects.toThrow(/lists no servers/);
    });

    it('rejects several TXT records and options a TXT record may not set', async () => {
        await expect(
            resolveTopology(config(cluster, { srv: 'true' }), resolver(shards, [['a=b'], ['c=d']])),
        ).rejects.toThrow(/more than one TXT/);
        await expect(
            resolveTopology(config(cluster, { srv: 'true' }), resolver(shards, [['tls=false']])),
        ).rejects.toThrow(/may not set/);
    });

    it('treats a missing TXT record as no options', async () => {
        const topology = await resolveTopology(
            config(cluster, { srv: 'true' }),
            resolver(shards, dnsError('ENODATA')),
        );
        expect(topology.seeds).toHaveLength(2);
    });
});

describe('plain mongodb:// seeds', () => {
    it('lists the primary host and the extra seeds', async () => {
        const topology = await resolveTopology(config('a', { seeds: 'b:27018,[::1]:27019' }));
        expect(topology.seeds).toEqual([
            { host: 'a', port: 27017 },
            { host: 'b', port: 27018 },
            { host: '::1', port: 27019 },
        ]);
    });
});

describe('choosing a member', () => {
    const fake = (
        behaviour: Record<
            string,
            { writable?: boolean; primary?: string; setName?: string } | Error
        >,
    ) => {
        const opened: string[] = [];
        const connect = async (options: MongoConnectOptions): Promise<MongoConnection> => {
            const key = `${options.host}:${options.port}`;
            opened.push(key);
            const item = behaviour[key];
            if (!item || item instanceof Error)
                throw item ?? new DbError('CONNECTION_FAILED', `no route to ${key}`);
            return {
                hello: { writable: true, process: 'mongod', ...item },
                close: async () => undefined,
            } as unknown as MongoConnection;
        };
        return { connect, opened };
    };
    const base = { tls: { mode: 'disable' as const }, connectTimeoutMs: 1000 };
    const topology = (seeds: string[], options: Record<string, string> = {}) => ({
        seeds: seeds.map((s) => ({ host: s.split(':')[0]!, port: Number(s.split(':')[1]) })),
        options,
        srv: false,
    });

    it('skips an unreachable seed', async () => {
        const { connect } = fake({ 'b:2': {} });
        const result = await connectToTopology(topology(['a:1', 'b:2']), base, undefined, connect);
        expect(result.target).toEqual({ host: 'b', port: 2 });
    });

    it('moves from a secondary to the primary it reports', async () => {
        const { connect, opened } = fake({
            'a:1': { writable: false, primary: 'c:3' },
            'c:3': {},
        });
        const result = await connectToTopology(topology(['a:1']), base, undefined, connect);
        expect(result.target).toEqual({ host: 'c', port: 3 });
        expect(opened).toEqual(['a:1', 'c:3']);
    });

    it('stays on a secondary when the read preference asks for one', async () => {
        const { connect } = fake({ 'a:1': { writable: false, primary: 'c:3' } });
        const result = await connectToTopology(
            topology(['a:1']),
            { ...base, readPreference: 'secondary' },
            undefined,
            connect,
        );
        expect(result.target.host).toBe('a');
    });

    it('stays put for a direct connection', async () => {
        const { connect } = fake({ 'a:1': { writable: false, primary: 'c:3' } });
        const result = await connectToTopology(
            topology(['a:1'], { directConnection: 'true' }),
            base,
            undefined,
            connect,
        );
        expect(result.target.host).toBe('a');
    });

    it('rejects a member of another replica set', async () => {
        const { connect } = fake({ 'a:1': { setName: 'other' } });
        await expect(
            connectToTopology(topology(['a:1'], { replicaSet: 'rs0' }), base, undefined, connect),
        ).rejects.toThrow(/replica set/);
    });

    it('reports the last connection error when every seed fails', async () => {
        const { connect } = fake({});
        await expect(
            connectToTopology(topology(['a:1', 'b:2']), base, undefined, connect),
        ).rejects.toThrow(/no route to b:2/);
    });

    it('does not try other members after a failed login', async () => {
        const opened: string[] = [];
        const connect = async (o: MongoConnectOptions): Promise<MongoConnection> => {
            opened.push(o.host);
            throw new DbError('AUTH_FAILED', 'Authentication failed.');
        };
        await expect(
            connectToTopology(topology(['a:1', 'b:2']), base, undefined, connect),
        ).rejects.toMatchObject({ code: 'AUTH_FAILED' });
        expect(opened).toEqual(['a']);
    });
});
