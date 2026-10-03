// @vitest-environment node
/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
    isRelationalSession,
    type ConnectionConfig,
    type DbValue,
    type Execution,
    type RelationalSession,
    type ResultEvent,
} from '@httpreq/db-core';
import { startFakeRedis, type FakeRedis } from '@httpreq/test-servers';
import { parseCommandLine, quoteArgument, redisProvider } from './index';

let servers: FakeRedis[] = [];
let sessions: RelationalSession[] = [];

afterEach(async () => {
    for (const session of sessions) await session.close().catch(() => undefined);
    sessions = [];
    await Promise.all(servers.map((server) => server.stop()));
    servers = [];
});

const open = async (
    options: Parameters<typeof startFakeRedis>[0] = {},
    config: Partial<ConnectionConfig> = {},
) => {
    const server = await startFakeRedis(options);
    servers.push(server);
    const session = await redisProvider
        .createConnector({
            engine: 'redis',
            host: server.host,
            port: server.port,
            tls: { mode: 'disable' },
            connectTimeoutMs: 3000,
            queryTimeoutMs: 0,
            options: {},
            ...config,
        })
        .connect();
    if (!isRelationalSession(session)) throw new Error('expected a command session');
    sessions.push(session);
    return { server, session };
};

interface Collected {
    columns: string[];
    rows: DbValue[][];
    info?: string;
}

const collect = async (execution: Execution): Promise<Collected> => {
    const out: Collected = { columns: [], rows: [] };
    for await (const event of execution as AsyncIterable<ResultEvent>) {
        if (event.kind === 'columns') out.columns = event.columns.map((c) => c.name);
        else if (event.kind === 'rows') out.rows.push(...event.rows);
        else if (event.info) out.info = event.info;
    }
    return out;
};

const run = (session: RelationalSession, command: string) => collect(session.execute(command));

describe('parseCommandLine', () => {
    it('splits words and honours both kinds of quotes', () => {
        expect(parseCommandLine('SET key value')).toEqual(['SET', 'key', 'value']);
        expect(parseCommandLine('  SET   a   "hello world"  ')).toEqual([
            'SET',
            'a',
            'hello world',
        ]);
        expect(parseCommandLine(`SET a 'it\\'s'`)).toEqual(['SET', 'a', "it's"]);
        expect(parseCommandLine('SET a "line\\nbreak\\ttab \\"q\\""')).toEqual([
            'SET',
            'a',
            'line\nbreak\ttab "q"',
        ]);
        expect(parseCommandLine('SET a "\\xc3\\xa9"')).toEqual(['SET', 'a', 'é']);
        expect(parseCommandLine("SET a 'raw \\n stays'")).toEqual(['SET', 'a', 'raw \\n stays']);
        expect(parseCommandLine('SET a ""')).toEqual(['SET', 'a', '']);
        expect(parseCommandLine('')).toEqual([]);
    });

    it('rejects unbalanced quotes and text glued to a closing quote', () => {
        expect(() => parseCommandLine('SET a "oops')).toThrow(/not closed/);
        expect(() => parseCommandLine("SET a 'oops")).toThrow(/not closed/);
        expect(() => parseCommandLine('SET a "x"y')).toThrow(/followed by a space/);
    });

    it('quotes values so that they read back unchanged', () => {
        for (const value of [
            'plain',
            '',
            'with space',
            'quote"inside',
            'new\nline',
            'back\\slash',
            "single'q",
        ]) {
            expect(parseCommandLine(`GET ${quoteArgument(value)}`)).toEqual(['GET', value]);
        }
    });
});

describe('connecting', () => {
    it('reports the product, version and user', async () => {
        const { session } = await open({}, {});
        expect(session.info).toMatchObject({ product: 'Redis', version: '7.4.0', secure: false });
    });

    it('says Valkey when the server is Valkey', async () => {
        const { session } = await open({ serverName: 'valkey' });
        expect(session.info.product).toBe('Valkey');
    });

    it('fails with AUTH_FAILED on a wrong password', async () => {
        const server = await startFakeRedis({ password: 'secret' });
        servers.push(server);
        await expect(
            redisProvider
                .createConnector({
                    engine: 'redis',
                    host: server.host,
                    port: server.port,
                    password: 'nope',
                    tls: { mode: 'disable' },
                    connectTimeoutMs: 2000,
                    queryTimeoutMs: 0,
                    options: {},
                })
                .connect(),
        ).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    });

    it('accepts a database as a number or db3, and rejects other text', async () => {
        const { server } = await open({}, { database: 'db2' });
        expect(server.connections()).toBeGreaterThan(0);
        await expect(open({}, { database: 'abc' })).rejects.toMatchObject({
            code: 'INVALID_REQUEST',
        });
    });
});

describe('running commands', () => {
    it('shows a scalar reply as one row', async () => {
        const { session } = await open();
        expect(await run(session, 'SET greeting hello')).toMatchObject({
            columns: ['result'],
            rows: [['OK']],
        });
        expect(await run(session, 'GET greeting')).toMatchObject({ rows: [['hello']] });
        expect((await run(session, 'GET missing')).rows).toEqual([[null]]);
        expect((await run(session, 'DBSIZE')).rows).toEqual([[1]]);
    });

    it('shows a list as index and value', async () => {
        const { session } = await open();
        await run(session, 'RPUSH queue a b c');
        const result = await run(session, 'LRANGE queue 0 -1');
        expect(result.columns).toEqual(['index', 'value']);
        expect(result.rows).toEqual([
            [0, 'a'],
            [1, 'b'],
            [2, 'c'],
        ]);
    });

    it('shows a hash as field and value on RESP3 and on RESP2', async () => {
        for (const resp2Only of [false, true]) {
            const { session } = await open({ resp2Only });
            await run(session, 'HSET user:1 name Ada age 36');
            const result = await run(session, 'HGETALL user:1');
            expect(result.columns).toEqual(['field', 'value']);
            expect(result.rows).toEqual([
                ['name', 'Ada'],
                ['age', '36'],
            ]);
        }
    });

    it('shows a sorted set with scores as member and score on both protocols', async () => {
        for (const resp2Only of [false, true]) {
            const { session } = await open({ resp2Only });
            await run(session, 'ZADD board 3 carol 1 alice 2 bob');
            const result = await run(session, 'ZRANGE board 0 -1 WITHSCORES');
            expect(result.columns).toEqual(['member', 'score']);
            expect(result.rows.map((r) => r[0])).toEqual(['alice', 'bob', 'carol']);
            expect(result.rows.map((r) => Number(r[1]))).toEqual([1, 2, 3]);
        }
    });

    it('shows a SCAN as keys with the next cursor', async () => {
        const { session } = await open();
        for (let i = 0; i < 25; i++) await run(session, `SET k${i} v`);
        const first = await run(session, 'SCAN 0 COUNT 10');
        expect(first.columns).toEqual(['key']);
        expect(first.rows).toHaveLength(10);
        expect(first.info).toBe('Next cursor: 10');
        const last = await run(session, 'SCAN 20 COUNT 10');
        expect(last.info).toBe('The scan is complete.');
    });

    it('shows long text such as INFO a line to a row', async () => {
        const { session } = await open();
        const result = await run(session, 'INFO server');
        expect(result.columns).toEqual(['line']);
        expect(result.rows.map((r) => r[0])).toContain('redis_version:7.4.0');
    });

    it('reports an error reply as a failure and keeps working', async () => {
        const { session } = await open();
        await run(session, 'SET s 1');
        await expect(run(session, 'LPUSH s x')).rejects.toMatchObject({
            code: 'QUERY_FAILED',
            message: expect.stringContaining('WRONGTYPE'),
        });
        await expect(run(session, 'NOSUCH')).rejects.toMatchObject({ code: 'QUERY_FAILED' });
        expect((await run(session, 'GET s')).rows).toEqual([['1']]);
    });

    it('refuses an empty command and unbalanced quotes before sending anything', async () => {
        const { session } = await open();
        expect(() => session.execute('   ')).toThrow(/no command/);
        expect(() => session.execute('SET a "x')).toThrow(/not closed/);
        expect((await run(session, 'PING')).rows).toEqual([['PONG']]);
    });

    it('streams a large reply in pages without holding it', async () => {
        const { session } = await open();
        let pages = 0;
        let rows = 0;
        for await (const event of session.execute('XBIG 30000 10', { pageRows: 1000 })) {
            if (event.kind === 'rows') {
                pages++;
                rows += event.rows.length;
            }
        }
        expect(rows).toBe(30_000);
        expect(pages).toBe(30);
    });

    it('runs commands in a transaction', async () => {
        const { session } = await open();
        await session.begin();
        expect((await run(session, 'SET a 1')).rows).toEqual([['QUEUED']]);
        await session.rollback();
        expect((await run(session, 'GET a')).rows).toEqual([[null]]);
        await session.begin();
        await run(session, 'SET a 2');
        await session.commit();
        expect((await run(session, 'GET a')).rows).toEqual([['2']]);
    });

    it('stops a command that outlives the time limit', async () => {
        const { session } = await open();
        const started = Date.now();
        await expect(
            collect(session.execute('BLPOP never 0', { timeoutMs: 200 })),
        ).rejects.toMatchObject({ code: 'TIMEOUT' });
        expect(Date.now() - started).toBeLessThan(3000);
        expect(session.alive).toBe(false);
    });

    it('stops a command on request', async () => {
        const { session } = await open();
        const execution = session.execute('BLPOP never 0');
        const pending = collect(execution);
        setTimeout(() => void execution.cancel(), 100);
        await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    });

    it('refuses subscriptions', async () => {
        const { session } = await open();
        await expect(run(session, 'SUBSCRIBE news')).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    });
});

describe('browsing', () => {
    it('lists the databases the server has', async () => {
        const { session } = await open({ databases: 4 });
        expect((await session.listDatabases()).map((d) => d.name)).toEqual([
            'db0',
            'db1',
            'db2',
            'db3',
        ]);
    });

    it('lists keys of a database with their types, sorted', async () => {
        const { session, server } = await open();
        await run(session, 'SET b 1');
        await run(session, 'RPUSH a x');
        await run(session, 'SELECT 2');
        await run(session, 'SET other 1');
        const tables = await session.listTables({ database: 'db0' });
        expect(tables.map((t) => [t.name, t.kind])).toEqual([
            ['a', 'list'],
            ['b', 'string'],
        ]);
        expect((await session.listTables({ database: 'db2' })).map((t) => t.name)).toEqual([
            'other',
        ]);
        expect(server.data.get(0)?.size).toBe(2);
    });

    it('caps a huge keyspace and says so', async () => {
        const { session, server } = await open();
        const keys = new Map();
        for (let i = 0; i < 6000; i++)
            keys.set(`k${i}`, { type: 'string', value: Buffer.from('v') });
        server.data.set(0, keys);
        const tables = await session.listTables({ database: 'db0' });
        expect(tables).toHaveLength(5001);
        expect(tables.at(-1)).toMatchObject({ kind: 'note' });
    });

    it('describes a key', async () => {
        const { session } = await open();
        await run(session, 'RPUSH queue a b c');
        const text = await session.getDefinition({ database: 'db0', name: 'queue', kind: 'table' });
        expect(text).toContain('type:     list');
        expect(text).toContain('size:     3 elements');
        expect(text).toContain('ttl:      no expiry');
        await expect(
            session.getDefinition({ database: 'db0', name: 'absent', kind: 'table' }),
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('browsing works while a command is blocked', async () => {
        const { session } = await open();
        await run(session, 'SET k 1');
        const blocked = collect(session.execute('BLPOP q 1'));
        expect((await session.listTables({ database: 'db0' })).map((t) => t.name)).toEqual(['k']);
        await blocked;
    });

    it('lists and kills client sessions', async () => {
        const { session } = await open();
        const list = await session.listSessions();
        expect(list.length).toBeGreaterThanOrEqual(1);
        expect(list[0]!.id).toMatch(/^\d+$/);
    });

    it('reports server status as a map', async () => {
        const { session } = await open();
        const status = await session.serverStatus();
        expect(status.redis_version).toBe('7.4.0');
    });

    it('says an explain does not exist, and has no relational objects', async () => {
        const { session } = await open();
        expect(() => session.explain('x')).toThrow(/no query plans/);
        expect(await session.listRoutines({})).toEqual([]);
        expect(await session.listColumns({ name: 'x' })).toEqual([]);
    });
});
