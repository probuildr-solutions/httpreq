/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

// @vitest-environment node
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ResultEvent, TlsConfig } from '@httpreq/db-core';
import { startMysql, type TestServer } from '@httpreq/test-servers';
import {
    MysqlConnection,
    MysqlServerError,
    PacketReader,
    PayloadReader,
    cachingSha2Response,
    framePacket,
    nativePasswordResponse,
    writeLenEnc,
    type MysqlConnectOptions,
} from './index';

/* ---------- Pure parts: no server needed ---------- */

describe('PacketReader', () => {
    const packet = (payload: Buffer, sequence: number) => framePacket(payload, sequence).frame;

    it('returns whole packets however the bytes are split', () => {
        const payloads = [Buffer.from('hello'), Buffer.alloc(0), Buffer.from('x'.repeat(1000))];
        const wire = Buffer.concat(payloads.map((p, i) => packet(p, i)));
        for (const size of [1, 2, 3, 7, 100, wire.length]) {
            const reader = new PacketReader();
            const got = [];
            for (let at = 0; at < wire.length; at += size)
                got.push(...reader.push(wire.subarray(at, at + size)));
            expect(
                got.map((p) => p.payload.toString()),
                `chunk ${size}`,
            ).toEqual(payloads.map((p) => p.toString()));
            expect(got.map((p) => p.sequence)).toEqual([0, 1, 2]);
        }
    });

    it('joins a payload that spans several packets, including an exact multiple of the maximum', () => {
        const big = Buffer.alloc(0xff_ffff * 2 + 5, 7);
        const { frame, next } = framePacket(big, 3);
        expect(next).toBe(6); // three packets
        const reader = new PacketReader();
        const [joined] = reader.push(frame);
        expect(joined!.payload.length).toBe(big.length);
        expect(joined!.sequence).toBe(5);

        const exact = Buffer.alloc(0xff_ffff, 1);
        const framed = framePacket(exact, 0);
        expect(framed.next).toBe(2); // a full packet and an empty terminator
        expect(new PacketReader().push(framed.frame)[0]!.payload.length).toBe(exact.length);
    });
});

describe('length-encoded integers', () => {
    it('round-trips every encoding width', () => {
        for (const value of [0, 250, 251, 65_535, 65_536, 16_777_215, 16_777_216, 2 ** 40]) {
            const reader = new PayloadReader(writeLenEnc(value));
            expect(reader.lenEnc()).toBe(value);
        }
        expect(new PayloadReader(Buffer.from([0xfb])).lenEnc()).toBeNull();
    });
});

describe('password scrambles', () => {
    const nonce = Buffer.from('0123456789abcdefghij');
    const xor = (a: Buffer, b: Buffer) => Buffer.from(a.map((byte, i) => byte ^ b[i]!));
    const sha1 = (...p: Buffer[]) => p.reduce((h, b) => h.update(b), createHash('sha1')).digest();
    const sha256 = (...p: Buffer[]) =>
        p.reduce((h, b) => h.update(b), createHash('sha256')).digest();

    it('mysql_native_password verifies the way the server checks it', () => {
        // The server stores SHA1(SHA1(password)) and recovers SHA1(password) from the response.
        const stored = sha1(sha1(Buffer.from('secret')));
        const response = nativePasswordResponse('secret', nonce);
        const stage1 = xor(response, sha1(nonce, stored));
        expect(sha1(stage1).equals(stored)).toBe(true);
        expect(nativePasswordResponse('', nonce)).toHaveLength(0);
        expect(nativePasswordResponse('other', nonce).equals(response)).toBe(false);
    });

    it('caching_sha2_password verifies the way the server checks it', () => {
        const stored = sha256(sha256(Buffer.from('secret')));
        const response = cachingSha2Response('secret', nonce);
        const stage1 = xor(response, sha256(stored, nonce));
        expect(sha256(stage1).equals(stored)).toBe(true);
        expect(cachingSha2Response('', nonce)).toHaveLength(0);
    });
});

/* ---------- Against a real MySQL server ---------- */

let server: TestServer | null = null;
beforeAll(async () => {
    server = await startMysql();
}, 180_000);
afterAll(async () => {
    await server?.stop();
});

const NO_TLS: TlsConfig = { mode: 'disable' };

const options = (user: string, extra: Partial<MysqlConnectOptions> = {}): MysqlConnectOptions => ({
    host: server!.host,
    port: server!.port,
    user,
    password: server!.users[user] ?? '',
    tls: NO_TLS,
    connectTimeoutMs: 10_000,
    ...extra,
});

const collect = async (query: AsyncIterable<ResultEvent>) => {
    const events: ResultEvent[] = [];
    for await (const event of query) events.push(event);
    return events;
};

const rowsOf = (events: ResultEvent[]) =>
    events.flatMap((event) => (event.kind === 'rows' ? event.rows : []));

const connect = (user = 'app', extra: Partial<MysqlConnectOptions> = {}) =>
    MysqlConnection.connect(options(user, extra));

const live = (name: string, body: () => Promise<void>, timeout = 60_000) =>
    it(
        name,
        async (context) => {
            if (!server) return context.skip();
            await body();
        },
        timeout,
    );

describe('connecting', () => {
    live(
        'logs in with caching_sha2_password over a plain connection (full authentication)',
        async () => {
            const connection = await connect('app');
            expect(connection.serverVersion).toMatch(/^\d+\./);
            expect(connection.secure).toBe(false);
            expect(connection.connectionId).toBeGreaterThan(0);
            await connection.ping();
            await connection.close();
            // The second login can use the server's cache (fast authentication).
            await (await connect('app')).close();
        },
    );

    live('logs in over TLS, where the password is sent through the encrypted channel', async () => {
        const connection = await connect('app', { tls: { mode: 'require' } });
        expect(connection.secure).toBe(true);
        const [event] = rowsOf(await collect(connection.query('SELECT 1')));
        expect(event).toEqual([1]);
        await connection.close();
    });

    live('refuses a self-signed certificate when asked to verify it', async () => {
        await expect(connect('app', { tls: { mode: 'verify-ca' } })).rejects.toMatchObject({
            code: 'CONNECTION_FAILED',
        });
        await expect(connect('app', { tls: { mode: 'verify-full' } })).rejects.toMatchObject({
            code: 'CONNECTION_FAILED',
        });
    });

    live('accounts without a password can log in', async () => {
        await (await connect('blank')).close();
        await (await connect('root')).close();
    });

    live(
        'reports a wrong password as an authentication failure with the server error number',
        async () => {
            const error = await connect('app', { password: 'wrong' }).catch((e: unknown) => e);
            expect(error).toBeInstanceOf(MysqlServerError);
            expect(error).toMatchObject({ code: 'AUTH_FAILED', errno: 1045, sqlState: '28000' });
            expect((error as Error).message).not.toContain('wrong'); // the password never comes back
        },
    );

    live('reports a closed port and a connection timeout', async () => {
        await expect(connect('app', { port: 1, connectTimeoutMs: 2_000 })).rejects.toMatchObject({
            code: 'CONNECTION_FAILED',
        });
    });

    live('selects a database at login', async () => {
        const connection = await connect('app', { database: 'shop' });
        expect(rowsOf(await collect(connection.query('SELECT DATABASE()')))[0]).toEqual(['shop']);
        await connection.close();
    });
});

describe('statements', () => {
    live('runs a query and reports columns, rows and the end of the result', async () => {
        const connection = await connect();
        const events = await collect(
            connection.query("SELECT 1 AS a, 'héllo 日本' AS b, NULL AS c, 2.50 AS d"),
        );
        expect(events.map((e) => e.kind)).toEqual(['columns', 'rows', 'end']);
        const columns = events[0] as Extract<ResultEvent, { kind: 'columns' }>;
        expect(columns.columns.map((c) => c.name)).toEqual(['a', 'b', 'c', 'd']);
        expect(rowsOf(events)).toEqual([[1, 'héllo 日本', null, '2.50']]);
        expect(events.at(-1)).toMatchObject({ kind: 'end', rowCount: 1 });
        await connection.close();
    });

    live('decodes the column types faithfully', async () => {
        const connection = await connect();
        await collect(connection.query('CREATE DATABASE IF NOT EXISTS t1'));
        await connection.useDatabase('t1');
        await collect(
            connection.query(`CREATE TABLE types (
                i INT, u BIGINT UNSIGNED, s SMALLINT, d DECIMAL(20,4), f FLOAT, r DOUBLE,
                dt DATETIME(3), dd DATE, t TIME, ts TIMESTAMP NULL, y YEAR, b BLOB, vb VARBINARY(8),
                j JSON, e ENUM('x','y'), st SET('a','b'), bt BIT(8), tx TEXT, c CHAR(3)
            )`),
        );
        await collect(
            connection.query(`INSERT INTO types VALUES (
                -5, 18446744073709551615, 7, 12345678901234.5678, 1.5, 2.25,
                '2026-10-03 12:34:56.789', '2026-10-03', '-12:30:00', NULL, 2026, 'bytes', 'ab',
                '{"a": [1, 2]}', 'y', 'a,b', b'1010', 'tëxt', 'abc')`),
        );
        const events = await collect(connection.query('SELECT * FROM types'));
        const columns = (events[0] as Extract<ResultEvent, { kind: 'columns' }>).columns;
        const [row] = rowsOf(events);
        const byName = Object.fromEntries(columns.map((c, i) => [c.name, row![i]]));
        expect(byName.i).toBe(-5);
        expect(byName.u).toBe(18446744073709551615n); // too big for a number: exact as a bigint
        expect(byName.s).toBe(7);
        expect(byName.d).toBe('12345678901234.5678'); // decimals stay exact text
        expect(byName.f).toBe(1.5);
        expect(byName.r).toBe(2.25);
        expect(byName.dt).toBe('2026-10-03 12:34:56.789');
        expect(byName.dd).toBe('2026-10-03');
        expect(byName.t).toBe('-12:30:00');
        expect(byName.ts).toBeNull();
        expect(byName.y).toBe(2026);
        expect(byName.b).toEqual(new Uint8Array(Buffer.from('bytes')));
        expect(byName.vb).toEqual(new Uint8Array(Buffer.from('ab')));
        expect(JSON.parse(byName.j as string)).toEqual({ a: [1, 2] });
        expect(byName.e).toBe('y');
        expect(byName.st).toBe('a,b');
        expect(byName.bt).toBe(10);
        expect(byName.tx).toBe('tëxt');
        expect(byName.c).toBe('abc');
        expect(columns.find((c) => c.name === 'u')!.type).toBe('bigint unsigned');
        expect(columns.find((c) => c.name === 'd')!.type).toBe('decimal(20,4)');
        expect(columns.find((c) => c.name === 'dt')!.type).toBe('datetime');
        expect(columns.find((c) => c.name === 'tx')!.type).toBe('text');
        await collect(connection.query('DROP DATABASE t1'));
        await connection.close();
    });

    live('reports affected rows and the generated id for a write', async () => {
        const connection = await connect('app', { database: 'shop' });
        await collect(
            connection.query(
                'CREATE TABLE IF NOT EXISTS items (id INT AUTO_INCREMENT PRIMARY KEY, n INT)',
            ),
        );
        const [insert] = await collect(
            connection.query('INSERT INTO items (n) VALUES (1), (2), (3)'),
        );
        expect(insert).toMatchObject({ kind: 'end', affectedRows: 3, insertId: '1' });
        const [update] = await collect(connection.query('UPDATE items SET n = n + 1 WHERE n > 1'));
        expect(update).toMatchObject({ kind: 'end', affectedRows: 2 });
        expect(update).toMatchObject({ info: expect.stringContaining('Rows matched: 2') });
        await collect(connection.query('DROP TABLE items'));
        await connection.close();
    });

    live(
        'reports a failing statement with the server error and keeps the connection usable',
        async () => {
            const connection = await connect();
            const error = await collect(connection.query('SELEC 1')).catch((e: unknown) => e);
            expect(error).toBeInstanceOf(MysqlServerError);
            expect(error).toMatchObject({ code: 'QUERY_FAILED', errno: 1064, sqlState: '42000' });
            expect(rowsOf(await collect(connection.query('SELECT 42')))[0]).toEqual([42]);
            await connection.close();
        },
    );

    live('returns several result sets from one call', async () => {
        const connection = await connect('app', { database: 'shop' });
        await collect(connection.query('DROP PROCEDURE IF EXISTS two'));
        await collect(
            connection.query(
                'CREATE PROCEDURE two() BEGIN SELECT 1 AS a; SELECT 2 AS b, 3 AS c; END',
            ),
        );
        const events = await collect(connection.query('CALL two()'));
        expect(events.map((e) => e.kind)).toEqual([
            'columns',
            'rows',
            'end',
            'columns',
            'rows',
            'end',
            'end',
        ]);
        expect(rowsOf(events)).toEqual([[1], [2, 3]]);
        await collect(connection.query('DROP PROCEDURE two'));
        await connection.close();
    });

    live(
        'streams a large result in pages without holding it all',
        async () => {
            const connection = await connect();
            await collect(connection.query('SET SESSION cte_max_recursion_depth = 2000000'));
            const query = connection.query(
                "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 300000) SELECT i, REPEAT('x', 50) AS pad FROM n",
                { pageRows: 1000 },
            );
            let rows = 0;
            let pages = 0;
            let last = 0;
            for await (const event of query) {
                if (event.kind !== 'rows') continue;
                pages++;
                rows += event.rows.length;
                expect(event.rows.length).toBeLessThanOrEqual(1000);
                last = event.rows.at(-1)![0] as number;
                // A slow consumer: the connection must pause the socket rather than buffer everything.
                if (pages % 50 === 0) await new Promise((resolve) => setTimeout(resolve, 5));
            }
            expect(rows).toBe(300_000);
            expect(last).toBe(300_000);
            expect(pages).toBe(300);
            await connection.close();
        },
        120_000,
    );

    live('leaves the connection clean when the consumer stops early', async () => {
        const connection = await connect();
        await collect(connection.query('SET SESSION cte_max_recursion_depth = 2000000'));
        const query = connection.query(
            'WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 100000) SELECT i FROM n',
            { pageRows: 100 },
        );
        for await (const event of query) {
            if (event.kind === 'rows') break;
        }
        // The rest of the response is drained in the background, then the connection is free again.
        for (let i = 0; i < 100 && connection.busy; i++)
            await new Promise((resolve) => setTimeout(resolve, 50));
        expect(connection.busy).toBe(false);
        expect(rowsOf(await collect(connection.query('SELECT 7')))[0]).toEqual([7]);
        await connection.close();
    });

    live('reads a value larger than one 16 MiB packet', async () => {
        const connection = await connect();
        const [row] = rowsOf(
            await collect(connection.query("SELECT REPEAT('a', 20000000) AS big")),
        );
        expect((row![0] as string).length).toBe(20_000_000);
        await connection.close();
    });

    live('cancels a running statement from a second connection with KILL QUERY', async () => {
        const worker = await connect();
        const killer = await connect();
        const started = Date.now();
        const running = collect(worker.query('SELECT SLEEP(30)'));
        await new Promise((resolve) => setTimeout(resolve, 500));
        await collect(killer.query(`KILL QUERY ${worker.connectionId}`));
        const events = await running;
        expect(Date.now() - started).toBeLessThan(10_000);
        expect(rowsOf(events)[0]).toEqual([1]); // SLEEP returns 1 when it is interrupted
        // The interrupted connection is still good.
        expect(rowsOf(await collect(worker.query('SELECT 1')))[0]).toEqual([1]);
        await worker.close();
        await killer.close();
    });

    live('refuses a request to read a local file', async () => {
        const connection = await connect('app', { database: 'shop' });
        await collect(connection.query('CREATE TABLE IF NOT EXISTS sink (a TEXT)'));
        const error = await collect(
            connection.query("LOAD DATA LOCAL INFILE 'C:/Windows/win.ini' INTO TABLE sink"),
        ).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(MysqlServerError); // refused by the server, or by this client
        await collect(connection.query('DROP TABLE sink'));
        await connection.close();
    });

    live('only runs one statement at a time on a connection', async () => {
        const connection = await connect();
        const first = connection.query('SELECT SLEEP(0.3)');
        expect(() => connection.query('SELECT 1')).toThrow(/busy/);
        await collect(first);
        await connection.close();
    });

    live('fails pending work when the server goes away', async () => {
        const connection = await connect();
        const killer = await connect();
        const running = collect(connection.query('SELECT SLEEP(30)'));
        await new Promise((resolve) => setTimeout(resolve, 300));
        await collect(killer.query(`KILL ${connection.connectionId}`));
        await expect(running).rejects.toMatchObject({
            code: expect.stringMatching(/CONNECTION_FAILED|CANCELLED/),
        });
        expect(connection.closed).toBe(true);
        await killer.close();
    });
});
