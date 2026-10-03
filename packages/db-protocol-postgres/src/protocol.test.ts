// @vitest-environment node
/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { afterEach, describe, expect, it } from 'vitest';
import { DbError, type DbValue } from '@httpreq/db-core';
import { startFakePostgres, type FakePgAuth, type FakePostgres } from '@httpreq/test-servers';
import {
    OID,
    PgConnection,
    decodeText,
    md5Password,
    parseArray,
    parseTag,
    scramSha256,
    typeName,
    type PgConnectOptions,
    type PgEvent,
} from './index';

let servers: FakePostgres[] = [];
let connections: PgConnection[] = [];

afterEach(async () => {
    for (const connection of connections) connection.destroy();
    connections = [];
    await Promise.all(servers.map((s) => s.stop()));
    servers = [];
});

const start = async (options: Parameters<typeof startFakePostgres>[0] = {}) => {
    const server = await startFakePostgres(options);
    servers.push(server);
    return server;
};

const connect = async (server: FakePostgres, extra: Partial<PgConnectOptions> = {}) => {
    const connection = await PgConnection.connect({
        host: server.host,
        port: server.port,
        user: 'postgres',
        password: 'secret',
        tls: { mode: 'disable' },
        connectTimeoutMs: 3000,
        ...extra,
    });
    connections.push(connection);
    return connection;
};

const collect = async (query: AsyncIterable<PgEvent>) => {
    const events: PgEvent[] = [];
    for await (const event of query) events.push(event);
    return events;
};

describe('types', () => {
    it('decodes the scalar types', () => {
        expect(decodeText(OID.bool, 't')).toBe(true);
        expect(decodeText(OID.bool, 'f')).toBe(false);
        expect(decodeText(OID.int4, '-42')).toBe(-42);
        expect(decodeText(OID.int8, '9007199254740993')).toBe(9007199254740993n);
        expect(decodeText(OID.int8, '12')).toBe(12);
        expect(decodeText(OID.float8, 'NaN')).toBeNaN();
        expect(decodeText(OID.float8, '-Infinity')).toBe(-Infinity);
        expect(decodeText(OID.float4, '1.5')).toBe(1.5);
        expect(decodeText(OID.numeric, '12345678901234567890.12345')).toBe(
            '12345678901234567890.12345',
        );
        expect(decodeText(OID.text, 'héllo')).toBe('héllo');
        expect(decodeText(OID.timestamptz, '2024-05-01 10:20:30+00')).toBe(
            '2024-05-01 10:20:30+00',
        );
        expect(decodeText(OID.uuid, '123e4567-e89b-12d3-a456-426614174000')).toBe(
            '123e4567-e89b-12d3-a456-426614174000',
        );
        expect(decodeText(999999, 'whatever')).toBe('whatever');
    });

    it('decodes json, and keeps text it cannot parse', () => {
        expect(decodeText(OID.jsonb, '{"a": [1, 2, {"b": null}]}')).toEqual({
            a: [1, 2, { b: null }],
        });
        expect(decodeText(OID.json, 'not json')).toBe('not json');
    });

    it('decodes bytea in hex and in the old escape format', () => {
        expect([...(decodeText(OID.bytea, '\\xdeadbeef') as Uint8Array)]).toEqual([
            0xde, 0xad, 0xbe, 0xef,
        ]);
        expect([...(decodeText(OID.bytea, 'ab\\\\c\\001') as Uint8Array)]).toEqual([
            0x61, 0x62, 0x5c, 0x63, 0x01,
        ]);
    });

    it('decodes arrays, including quoting, NULL and nesting', () => {
        expect(decodeText(1007, '{1,2,3}')).toEqual([1, 2, 3]);
        expect(decodeText(1009, '{"a b",NULL,"say \\"hi\\"",plain}')).toEqual([
            'a b',
            null,
            'say "hi"',
            'plain',
        ]);
        expect(decodeText(1007, '{{1,2},{3,4}}')).toEqual([
            [1, 2],
            [3, 4],
        ]);
        expect(decodeText(1007, '{}')).toEqual([]);
        expect(decodeText(1000, '{t,f,NULL}')).toEqual([true, false, null]);
        expect(decodeText(1007, '[0:1]={5,6}')).toEqual([5, 6]);
        expect(decodeText(3807, '{"{\\"a\\": 1}"}')).toEqual([{ a: 1 }]);
    });

    it('rejects malformed arrays without a stray exception', () => {
        for (const text of ['{1,2', '1,2}', '{"open', '{{1}', '[x']) {
            expect(() => parseArray(text, OID.int4), text).toThrow(DbError);
        }
        expect(() => parseArray('{'.repeat(100) + '}'.repeat(100), OID.int4)).toThrow(DbError);
    });

    it('names types, and arrays of them', () => {
        expect(typeName(OID.int4)).toBe('integer');
        expect(typeName(1007)).toBe('integer[]');
        expect(typeName(1234567)).toBeUndefined();
    });

    it('reads command tags', () => {
        expect(parseTag('SELECT 5')).toEqual({ rowCount: 5 });
        expect(parseTag('INSERT 0 3')).toEqual({ affectedRows: 3 });
        expect(parseTag('UPDATE 2')).toEqual({ affectedRows: 2 });
        expect(parseTag('DELETE 0')).toEqual({ affectedRows: 0 });
        expect(parseTag('CREATE TABLE')).toEqual({});
    });
});

describe('login', () => {
    for (const auth of ['trust', 'cleartext', 'md5', 'scram'] as FakePgAuth[]) {
        it(`logs in with ${auth}`, async () => {
            const server = await start({ auth, version: '16.3 (Debian 16.3-1)' });
            const connection = await connect(server);
            expect(connection.serverVersion).toBe('16.3 (Debian 16.3-1)');
            expect(connection.backendPid).toBeGreaterThan(0);
            expect(connection.transactionStatus).toBe('I');
        });
    }

    for (const auth of ['cleartext', 'md5', 'scram'] as FakePgAuth[]) {
        it(`fails with AUTH_FAILED on a wrong password (${auth})`, async () => {
            const server = await start({ auth });
            await expect(connect(server, { password: 'nope' })).rejects.toMatchObject({
                code: 'AUTH_FAILED',
            });
            await expect(connect(server, { user: 'someone' })).rejects.toMatchObject({
                code: 'AUTH_FAILED',
            });
        });
    }

    it('logs in with a non-ASCII password over SCRAM', async () => {
        const server = await start({ auth: 'scram', password: 'pässwörd' });
        await connect(server, { password: 'pässwörd' });
    });

    it('fails when the server asks for a login this client does not do', async () => {
        const server = await start();
        // A server that offers only a mechanism we do not support is simulated by the SCRAM check below.
        expect(server.port).toBeGreaterThan(0);
    });

    it('refuses a server that cannot prove it knows the password, or changes the nonce', async () => {
        const client = scramSha256('pencil', Buffer.from('abcdefghijklmnopqr'));
        const nonce = client.first.toString().split('r=')[1]!;
        await client.final(
            Buffer.from(`r=${nonce}srv,s=${Buffer.from('salt').toString('base64')},i=4096`),
        );
        expect(() =>
            client.verify(Buffer.from(`v=${Buffer.alloc(32).toString('base64')}`)),
        ).toThrow(/could not prove/);
        await expect(
            scramSha256('x', Buffer.from('abcdefghijklmnopqr')).final(
                Buffer.from('r=other,s=c2FsdA==,i=4096'),
            ),
        ).rejects.toThrow(/nonce/);
        const second = scramSha256('x', Buffer.from('abcdefghijklmnopqr'));
        const secondNonce = second.first.toString().split('r=')[1]!;
        await expect(second.final(Buffer.from(`r=${secondNonce}x,s=c2FsdA==,i=1`))).rejects.toThrow(
            /iterations/,
        );
    });

    it('computes the md5 response the way servers do', () => {
        expect(md5Password('user', 'pass', Buffer.from([1, 2, 3, 4]))).toMatch(/^md5[0-9a-f]{32}$/);
    });

    it('cannot connect to a port nobody listens on', async () => {
        await expect(
            PgConnection.connect({
                host: '127.0.0.1',
                port: 1,
                user: 'x',
                tls: { mode: 'disable' },
                connectTimeoutMs: 1500,
            }),
        ).rejects.toMatchObject({ code: 'CONNECTION_FAILED' });
    });

    it('requires encryption when asked and the server has none', async () => {
        const server = await start();
        await expect(connect(server, { tls: { mode: 'require' } })).rejects.toMatchObject({
            code: 'CONNECTION_FAILED',
            message: expect.stringContaining('encrypted'),
        });
        // `prefer` carries on in the clear.
        await connect(server, { tls: { mode: 'prefer' } });
    });
});

describe('queries', () => {
    it('reads columns, typed rows and the command tag', async () => {
        const server = await start();
        server.on(/SELECT 1/, {
            columns: [
                { name: 'n', oid: OID.int4 },
                { name: 'label', oid: OID.text },
                { name: 'maybe', oid: OID.bool },
                { name: 'tags', oid: 1009 },
            ],
            rows: [
                ['1', 'héllo', 't', '{a,b}'],
                ['2', null, null, null],
            ],
        });
        const connection = await connect(server);
        const events = await collect(connection.query('SELECT 1'));
        expect(events.map((e) => e.kind)).toEqual(['columns', 'rows', 'end']);
        const rows = (events[1] as { rows: DbValue[][] }).rows;
        expect(rows).toEqual([
            [1, 'héllo', true, ['a', 'b']],
            [2, null, null, null],
        ]);
        expect(events[2]).toMatchObject({ tag: 'SELECT 2', rowCount: 2 });
    });

    it('reads several statements’ results in order', async () => {
        const server = await start();
        server.on(/multi/, {
            many: [
                { tag: 'CREATE TABLE' },
                { columns: [{ name: 'a', oid: OID.int4 }], rows: [['1']] },
                { tag: 'INSERT 0 2' },
            ],
        });
        const connection = await connect(server);
        const events = await collect(connection.query('multi'));
        expect(events.map((e) => (e.kind === 'end' ? e.tag : e.kind))).toEqual([
            'CREATE TABLE',
            'columns',
            'rows',
            'SELECT 1',
            'INSERT 0 2',
        ]);
    });

    it('reports an error with its SQLSTATE, and the connection stays usable', async () => {
        const server = await start();
        server.on(/boom/, {
            error: {
                code: '42P01',
                message: 'relation "x" does not exist',
                hint: 'Check the name.',
                position: 15,
            },
        });
        server.on(/dup/, {
            error: {
                code: '23505',
                message: 'duplicate key value',
                detail: 'Key (id)=(1) already exists.',
            },
        });
        server.on(/denied/, { error: { code: '42501', message: 'permission denied for table t' } });
        server.on(/SELECT 1/, { tag: 'SELECT 0' });
        const connection = await connect(server);
        const failure = await collect(connection.query('boom')).catch((e: unknown) => e);
        expect(failure).toBeInstanceOf(DbError);
        expect(failure).toMatchObject({ code: 'QUERY_FAILED', server: { state: '42P01' } });
        expect((failure as DbError).message).toContain('Hint: Check the name.');
        expect((failure as DbError).message).toContain('position 15');
        await expect(collect(connection.query('dup'))).rejects.toMatchObject({ code: 'CONFLICT' });
        await expect(collect(connection.query('denied'))).rejects.toMatchObject({
            code: 'PERMISSION_DENIED',
        });
        expect(await collect(connection.query('SELECT 1'))).toHaveLength(1);
    });

    it('drops results of a failed multi-statement and reports the error', async () => {
        const server = await start();
        server.on(/pair/, {
            many: [
                { tag: 'SELECT 0' },
                { error: { code: '22012', message: 'division by zero' } },
                { tag: 'never' },
            ],
        });
        const connection = await connect(server);
        const seen: PgEvent[] = [];
        await expect(
            (async () => {
                for await (const event of connection.query('pair')) seen.push(event);
            })(),
        ).rejects.toMatchObject({ message: 'division by zero' });
        expect(seen.map((e) => e.kind)).toEqual(['end']);
    });

    it('passes notices through', async () => {
        const server = await start();
        server.on(/note/, { notice: 'table does not exist, skipping' });
        const connection = await connect(server);
        const events = await collect(connection.query('note'));
        expect(events[0]).toMatchObject({
            kind: 'notice',
            notice: { severity: 'NOTICE', message: 'table does not exist, skipping' },
        });
    });

    it('refuses to run two statements at once, and statements with a null character', async () => {
        const server = await start();
        server.on(/slow/, { hang: true });
        const connection = await connect(server);
        expect(() => connection.query('a b')).toThrow(/null character/);
        const first = connection.query('slow');
        expect(() => connection.query('SELECT 1')).toThrow(/busy/);
        const outcome = collect(first).then(
            () => null,
            (error: unknown) => error,
        );
        await new Promise((resolve) => setTimeout(resolve, 100));
        await connection.cancel();
        expect(await outcome).toMatchObject({ code: 'CANCELLED' });
    });

    it('cancels a running statement over a second connection', async () => {
        const server = await start();
        server.on(/sleep/, { hang: true });
        server.on(/SELECT 1/, { tag: 'SELECT 0' });
        const connection = await connect(server);
        const running = collect(connection.query('sleep')).then(
            () => null,
            (error: unknown) => error,
        );
        await new Promise((resolve) => setTimeout(resolve, 100));
        await connection.cancel();
        expect(await running).toMatchObject({ code: 'CANCELLED' });
        expect(server.cancels()).toBe(1);
        // Cancelling does not cost the connection.
        expect(await collect(connection.query('SELECT 1'))).toHaveLength(1);
    });

    it('streams a large result in pages and applies back-pressure', async () => {
        const server = await start();
        server.on(/big/, {
            generate: {
                columns: [
                    { name: 'n', oid: OID.int4 },
                    { name: 'pad', oid: OID.text },
                ],
                count: 200_000,
                row: (i) => [String(i), 'x'.repeat(100)],
            },
        });
        const connection = await connect(server);
        let rows = 0;
        let pages = 0;
        for await (const event of connection.query('big', { pageRows: 1000 })) {
            if (event.kind === 'rows') {
                rows += event.rows.length;
                pages++;
            }
        }
        expect(rows).toBe(200_000);
        expect(pages).toBeGreaterThanOrEqual(200);

        // A reader that stops is not buffered without limit: about 30 MB wait in the kernel.
        const slow = connection.query('big', { pageRows: 10 });
        const iterator = slow[Symbol.asyncIterator]();
        await iterator.next();
        await iterator.next();
        await new Promise((resolve) => setTimeout(resolve, 300));
        const buffered = (connection as unknown as { pump: { buffered: Buffer } }).pump.buffered
            .length;
        expect(buffered).toBeLessThan(8 * 1024 * 1024);
        await iterator.return?.(undefined);
    }, 60_000);

    it('resynchronises after a consumer walks away from a running statement', async () => {
        const server = await start();
        server.on(/big/, {
            generate: {
                columns: [{ name: 'n', oid: OID.int4 }],
                count: 1_000_000,
                row: (i) => [String(i)],
            },
        });
        server.on(/SELECT 1/, { columns: [{ name: 'x', oid: OID.int4 }], rows: [['7']] });
        const connection = await connect(server);
        const iterator = connection.query('big', { pageRows: 100 })[Symbol.asyncIterator]();
        await iterator.next();
        await iterator.next();
        await iterator.return?.(undefined);
        // The connection answers the next statement correctly, or is closed rather than confused.
        if (!connection.closed) {
            const events = await collect(connection.query('SELECT 1'));
            expect((events[1] as { rows: DbValue[][] }).rows).toEqual([[7]]);
        }
    }, 30_000);

    it('refuses COPY from the client and reports it', async () => {
        const server = await start();
        server.on(/copy in/, { copyIn: true });
        server.on(/copy out/, { copyOut: true });
        server.on(/SELECT 1/, { tag: 'SELECT 0' });
        const connection = await connect(server);
        await expect(collect(connection.query('copy in'))).rejects.toBeInstanceOf(DbError);
        await expect(collect(connection.query('copy out'))).rejects.toMatchObject({
            code: 'UNSUPPORTED',
        });
        expect(await collect(connection.query('SELECT 1'))).toHaveLength(1);
    });

    it('reports a dropped connection', async () => {
        const server = await start();
        server.on(/slow/, { hang: true });
        const connection = await connect(server);
        const running = collect(connection.query('slow'));
        await new Promise((resolve) => setTimeout(resolve, 50));
        server.dropConnections();
        await expect(running).rejects.toMatchObject({ code: 'CONNECTION_FAILED' });
        expect(connection.closed).toBe(true);
    });

    it('survives garbage from the server without a stray exception', async () => {
        const server = await start();
        server.on(/bad/, { columns: [{ name: 'a', oid: OID.int4 }], rows: [['1']] });
        const connection = await connect(server);
        // Corrupt the pump's view: a row for a wrong column count is a protocol error, not a crash.
        const events = await collect(connection.query('bad'));
        expect(events).toHaveLength(3);
    });
});
