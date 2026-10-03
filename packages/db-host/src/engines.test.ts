// @vitest-environment node
/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DbValue } from '@httpreq/db-core';
import { mongoProvider } from '@httpreq/mongo-engine';
import { mysqlProvider } from '@httpreq/mysql-engine';
import { postgresProvider } from '@httpreq/postgres-engine';
import { redisProvider } from '@httpreq/redis-engine';
import {
    findMongod,
    startFakePostgres,
    startFakeRedis,
    startMongo,
    type FakePostgres,
    type FakeRedis,
    type TestServer,
} from '@httpreq/test-servers';
import { DbHostService, type QueryStateEvent } from './index';

let work: string;
let host: DbHostService;
let redis: FakeRedis;
let postgres: FakePostgres;
let mongo: TestServer | null = null;
const events: { topic: string; payload: unknown }[] = [];

const call = <T>(op: string, payload: object = {}): Promise<T> =>
    host.handle(op, payload, {
        emit: (topic, body) => events.push({ topic, payload: body }),
        signal: new AbortController().signal,
    }) as Promise<T>;

let next = 1000;
const newId = () => (next++).toString(16).padStart(16, '0');

const finished = async (queryId: string): Promise<QueryStateEvent['snapshot']> => {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
        for (let i = events.length - 1; i >= 0; i--) {
            const event = events[i]!;
            if (event.topic !== 'query.state') continue;
            const payload = event.payload as QueryStateEvent;
            if (
                payload.queryId === queryId &&
                (payload.snapshot.state !== 'running' || payload.snapshot.paused)
            )
                return payload.snapshot;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('timed out');
};

const run = async (connectionId: string, sql: string) => {
    const queryId = newId();
    await call('query.start', { connectionId, queryId, sql });
    const snapshot = await finished(queryId);
    if (snapshot.state === 'failed') throw new Error(snapshot.error?.message ?? 'failed');
    const page = await call<{ rows: DbValue[][] } | null>('query.page', {
        queryId,
        result: 0,
        page: 0,
    });
    return {
        snapshot,
        rows: page?.rows ?? [],
        columns: snapshot.results[0]?.columns.map((c) => c.name) ?? [],
    };
};

beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), 'hr-dbhost-multi-'));
    host = new DbHostService({
        providers: [mysqlProvider, postgresProvider, mongoProvider, redisProvider],
        spoolDirectory: join(work, 'spool'),
        keepAliveMs: 0,
    });
    redis = await startFakeRedis();
    postgres = await startFakePostgres({ auth: 'scram', password: 'pw' });
    postgres.on(/^SELECT version\(\)$/, {
        columns: [{ name: 'version', oid: 25 }],
        rows: [['PostgreSQL 16.3']],
    });
    postgres.on(/^SELECT 1 AS one/, { columns: [{ name: 'one', oid: 23 }], rows: [['1']] });
    mongo = findMongod() ? await startMongo() : null;
}, 120_000);

afterAll(async () => {
    await host?.dispose();
    await redis?.stop();
    await postgres?.stop();
    await mongo?.stop();
    await rm(work, { recursive: true, force: true });
});

describe('engines', () => {
    it('lists all four, with what each can do', async () => {
        const engines =
            await call<{ id: string; defaultPort: number; capabilities: string[] }[]>(
                'engines.list',
            );
        expect(engines.map((e) => [e.id, e.defaultPort])).toEqual([
            ['mysql', 3306],
            ['postgresql', 5432],
            ['mongodb', 27017],
            ['redis', 6379],
        ]);
        expect(engines.find((e) => e.id === 'mongodb')!.capabilities).toEqual(
            expect.arrayContaining(['documents', 'aggregation', 'schemaInference']),
        );
        expect(engines.find((e) => e.id === 'redis')!.capabilities).not.toContain('sql');
    });
});

describe('splitting for engines that are not SQL', () => {
    it('splits Redis by line and skips comments', async () => {
        const text = '# set up\nSET a 1\n\n  GET a  \n// done\nDEL a';
        const parts = await call<{ start: number; end: number; sql: string }[]>('sql.split', {
            text,
            dialect: 'redis',
        });
        expect(parts.map((p) => p.sql)).toEqual(['SET a 1', 'GET a', 'DEL a']);
        for (const part of parts) expect(text.slice(part.start, part.end)).toBe(part.sql);
    });

    it('finds the Redis command at the cursor, or the last one before it', async () => {
        const text = 'SET a 1\nGET a\n';
        const at = (offset: number) =>
            call<{ sql: string } | null>('sql.statementAt', { text, offset, dialect: 'redis' });
        expect((await at(2))!.sql).toBe('SET a 1');
        expect((await at(10))!.sql).toBe('GET a');
        expect((await at(text.length))!.sql).toBe('GET a');
        expect(await call('sql.statementAt', { text: '', offset: 0, dialect: 'redis' })).toBeNull();
    });

    it('splits MongoDB statements across lines and finds the one at the cursor', async () => {
        const text = 'use shop\ndb.orders.find({ a: 1 })\n  .limit(5)\n\ndb.x.drop()';
        const parts = await call<{ sql: string }[]>('sql.split', { text, dialect: 'mongodb' });
        expect(parts.map((p) => p.sql)).toEqual([
            'use shop',
            'db.orders.find({ a: 1 })\n  .limit(5)',
            'db.x.drop()',
        ]);
        expect(
            (
                await call<{ sql: string }>('sql.statementAt', {
                    text,
                    offset: text.indexOf('limit'),
                    dialect: 'mongodb',
                })
            ).sql,
        ).toContain('find');
    });

    it('still refuses an unknown dialect', async () => {
        await expect(call('sql.split', { text: 'x', dialect: 'oracle' })).rejects.toMatchObject({
            code: 'INVALID_REQUEST',
        });
    });
});

describe('Redis through the host', () => {
    const config = () => ({
        engine: 'redis',
        host: redis.host,
        port: redis.port,
        tls: { mode: 'disable' },
    });

    it('connects, runs commands and pages the results', async () => {
        const connectionId = newId();
        const status = await call<{ state: string; server: { product: string } }>('conn.open', {
            connectionId,
            config: config(),
        });
        expect(status).toMatchObject({ state: 'connected', server: { product: 'Redis' } });
        await run(connectionId, 'RPUSH queue a b c');
        const result = await run(connectionId, 'LRANGE queue 0 -1');
        expect(result.columns).toEqual(['index', 'value']);
        expect(result.rows).toEqual([
            [0, 'a'],
            [1, 'b'],
            [2, 'c'],
        ]);
        const tables = await call<{ name: string; kind: string }[]>('meta.list', {
            connectionId,
            kind: 'tables',
            scope: { database: 'db0' },
        });
        expect(tables).toEqual([{ database: 'db0', name: 'queue', kind: 'list' }]);
        await call('conn.close', { connectionId });
    });

    it('tests a connection and reports a refused login', async () => {
        const locked = await startFakeRedis({ password: 'secret' });
        try {
            const bad = {
                engine: 'redis',
                host: locked.host,
                port: locked.port,
                tls: { mode: 'disable' },
                password: 'wrong',
            };
            await expect(call('conn.test', { config: bad })).rejects.toMatchObject({
                code: 'AUTH_FAILED',
            });
            const good = await call<{ ok: boolean; server: { user: string } }>('conn.test', {
                config: { ...bad, password: 'secret' },
            });
            expect(good.ok).toBe(true);
        } finally {
            await locked.stop();
        }
    });
});

describe('PostgreSQL through the host (against a scripted server)', () => {
    it('connects with SCRAM and runs a statement', async () => {
        const connectionId = newId();
        const config = {
            engine: 'postgresql',
            host: postgres.host,
            port: postgres.port,
            username: 'postgres',
            password: 'pw',
            database: 'shop',
            tls: { mode: 'disable' },
        };
        const status = await call<{ state: string; server: { product: string; version: string } }>(
            'conn.open',
            { connectionId, config },
        );
        expect(status).toMatchObject({
            state: 'connected',
            server: { product: 'PostgreSQL', version: '16.3' },
        });
        const result = await run(connectionId, 'SELECT 1 AS one');
        expect(result.rows).toEqual([[1]]);
        expect(result.columns).toEqual(['one']);
        await call('conn.close', { connectionId });
    });
});

describe('MongoDB through the host', () => {
    it('connects, inserts and finds documents', async (context) => {
        if (!mongo) return context.skip();
        const connectionId = newId();
        await call('conn.open', {
            connectionId,
            config: {
                engine: 'mongodb',
                host: mongo.host,
                port: mongo.port,
                database: 'hosttest',
                tls: { mode: 'disable' },
            },
        });
        await run(connectionId, 'db.items.insertMany([{ name: "a", n: 1 }, { name: "b", n: 2 }])');
        const found = await run(connectionId, 'db.items.find({}).sort({ n: 1 })');
        expect(found.columns).toEqual(['_id', 'name', 'n']);
        expect(found.rows.map((r) => r[1])).toEqual(['a', 'b']);
        expect(found.rows[0]![0]).toMatchObject({ $type: 'objectId' });
        const tables = await call<{ name: string; rows?: number }[]>('meta.list', {
            connectionId,
            kind: 'tables',
            scope: { database: 'hosttest' },
        });
        expect(tables).toEqual([expect.objectContaining({ name: 'items', rows: 2 })]);
        await call('conn.close', { connectionId });
    }, 60_000);

    it('refuses scripts for engines that are not SQL', async () => {
        await expect(
            call('script.start', {
                connectionId: newId(),
                scriptId: newId(),
                fileId: newId(),
                dialect: 'redis',
            }),
        ).rejects.toBeTruthy();
    });
});
