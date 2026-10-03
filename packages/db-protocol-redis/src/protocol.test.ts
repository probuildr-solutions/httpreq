// @vitest-environment node
/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { createServer } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { DbError } from '@httpreq/db-core';
import { SocketPump } from '@httpreq/streaming-engine';
import { startFakeRedis, type FakeRedis } from '@httpreq/test-servers';
import {
    RedisConnection,
    RespError,
    RespMap,
    RespReader,
    encodeCommand,
    type RedisConnectOptions,
} from './index';

let servers: FakeRedis[] = [];
let connections: RedisConnection[] = [];

afterEach(async () => {
    for (const connection of connections) connection.destroy();
    connections = [];
    await Promise.all(servers.map((server) => server.stop()));
    servers = [];
});

const start = async (options: Parameters<typeof startFakeRedis>[0] = {}) => {
    const server = await startFakeRedis(options);
    servers.push(server);
    return server;
};

const connect = async (server: FakeRedis, extra: Partial<RedisConnectOptions> = {}) => {
    const connection = await RedisConnection.connect({
        host: server.host,
        port: server.port,
        tls: { mode: 'disable' },
        connectTimeoutMs: 3000,
        ...extra,
    });
    connections.push(connection);
    return connection;
};

/** Feeds raw bytes to a reader through a real socket, to test the parser on exact byte strings. */
const parse = async (bytes: string | Buffer) => {
    const server = createServer((socket) => socket.end(bytes));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const pump = await SocketPump.open({
        host: '127.0.0.1',
        port,
        tls: { mode: 'disable' },
        connectTimeoutMs: 2000,
    });
    try {
        return await new RespReader(pump).readValue();
    } finally {
        pump.destroy();
        server.close();
    }
};

describe('RESP parser', () => {
    it('reads every RESP2 type', async () => {
        expect(await parse('+OK\r\n')).toBe('OK');
        expect(await parse(':42\r\n')).toBe(42);
        expect(await parse('$5\r\nhello\r\n')).toBe('hello');
        expect(await parse('$-1\r\n')).toBeNull();
        expect(await parse('*-1\r\n')).toBeNull();
        expect(await parse('*2\r\n$1\r\na\r\n:1\r\n')).toEqual(['a', 1]);
        const error = await parse('-WRONGTYPE bad kind\r\n');
        expect(error).toBeInstanceOf(RespError);
        expect(error).toMatchObject({ code: 'WRONGTYPE', message: 'WRONGTYPE bad kind' });
    });

    it('reads the RESP3 types', async () => {
        expect(await parse('_\r\n')).toBeNull();
        expect(await parse('#t\r\n')).toBe(true);
        expect(await parse('#f\r\n')).toBe(false);
        expect(await parse(',3.14\r\n')).toBe(3.14);
        expect(await parse(',-inf\r\n')).toBe(-Infinity);
        expect(await parse('(123456789012345678901234567890\r\n')).toBe(
            123456789012345678901234567890n,
        );
        expect(await parse('=15\r\ntxt:Some string\r\n')).toBe('Some string');
        expect(await parse('~2\r\n+a\r\n+b\r\n')).toEqual(['a', 'b']);
        expect(await parse('!21\r\nSYNTAX invalid syntax\r\n')).toMatchObject({ code: 'SYNTAX' });
        const map = await parse('%2\r\n+first\r\n:1\r\n+second\r\n:2\r\n');
        expect(map).toBeInstanceOf(RespMap);
        expect((map as RespMap).entries).toEqual([
            ['first', 1],
            ['second', 2],
        ]);
    });

    it('skips attributes that describe the next reply', async () => {
        expect(await parse('|1\r\n+ttl\r\n:3600\r\n$3\r\nfoo\r\n')).toBe('foo');
    });

    it('returns bytes that are not valid text as bytes', async () => {
        const value = await parse(
            Buffer.concat([
                Buffer.from('$3\r\n'),
                Buffer.from([0xff, 0xfe, 0x00]),
                Buffer.from('\r\n'),
            ]),
        );
        expect(value).toBeInstanceOf(Uint8Array);
        expect([...(value as Uint8Array)]).toEqual([0xff, 0xfe, 0x00]);
    });

    it('survives replies split across many tiny packets', async () => {
        const reply = Buffer.from('*3\r\n$5\r\nhello\r\n:7\r\n$-1\r\n');
        const server = createServer((socket) => {
            let i = 0;
            const timer = setInterval(() => {
                if (i >= reply.length) {
                    clearInterval(timer);
                    socket.end();
                    return;
                }
                socket.write(reply.subarray(i, i + 1));
                i++;
            }, 1);
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const pump = await SocketPump.open({
            host: '127.0.0.1',
            port: (server.address() as { port: number }).port,
            tls: { mode: 'disable' },
            connectTimeoutMs: 2000,
        });
        expect(await new RespReader(pump).readValue()).toEqual(['hello', 7, null]);
        pump.destroy();
        server.close();
    });

    it('refuses unknown types and absurd nesting', async () => {
        await expect(parse('?what\r\n')).rejects.toMatchObject({ code: 'CONNECTION_FAILED' });
        await expect(parse('*1\r\n'.repeat(100))).rejects.toBeInstanceOf(DbError);
    });

    it('fails when the server hangs up mid-reply', async () => {
        await expect(parse('$10\r\nabc')).rejects.toMatchObject({ code: 'CONNECTION_FAILED' });
    });
});

describe('encodeCommand', () => {
    it('writes bulk strings with byte lengths, not character counts', () => {
        expect(encodeCommand(['SET', 'k', 'é']).toString()).toBe(
            '*3\r\n$3\r\nSET\r\n$1\r\nk\r\n$2\r\né\r\n',
        );
        expect(encodeCommand(['SELECT', 3]).toString()).toBe('*2\r\n$6\r\nSELECT\r\n$1\r\n3\r\n');
    });
});

describe('RedisConnection', () => {
    it('negotiates RESP3 and reports the server', async () => {
        const server = await start();
        const connection = await connect(server);
        expect(connection.hello).toMatchObject({ server: 'redis', protocol: 3, version: '7.4.0' });
        expect(await connection.command(['PING'])).toBe('PONG');
    });

    it('recognises Valkey', async () => {
        const server = await start({ serverName: 'valkey' });
        expect((await connect(server)).hello).toMatchObject({ server: 'valkey', version: '8.0.1' });
    });

    it('falls back to RESP2 on a server without HELLO', async () => {
        const server = await start({ resp2Only: true });
        const connection = await connect(server);
        expect(connection.hello.protocol).toBe(2);
        expect(connection.hello.server).toBe('redis');
        await connection.command(['HSET', 'h', 'a', '1']);
        // RESP2 has no maps: a hash comes back flat.
        expect(await connection.command(['HGETALL', 'h'])).toEqual(['a', '1']);
    });

    it('authenticates with a password, or a user and password', async () => {
        const server = await start({ password: 'secret', users: { alice: 'wonder' } });
        await expect(connect(server)).rejects.toMatchObject({ code: 'AUTH_FAILED' });
        await expect(connect(server, { password: 'wrong' })).rejects.toMatchObject({
            code: 'AUTH_FAILED',
        });
        expect(
            await (
                await connect(server, { username: 'alice', password: 'wonder' })
            ).command(['PING']),
        ).toBe('PONG');
    });

    it('authenticates with a bare password as the default user', async () => {
        const server = await start({ password: 'secret' });
        expect(await (await connect(server, { password: 'secret' })).command(['PING'])).toBe(
            'PONG',
        );
    });

    it('selects the database it was asked for', async () => {
        const server = await start();
        const connection = await connect(server, { database: 3 });
        await connection.command(['SET', 'k', 'v']);
        expect(server.data.get(3)?.has('k')).toBe(true);
    });

    it('returns error replies as values and keeps working afterwards', async () => {
        const server = await start();
        const connection = await connect(server);
        await connection.command(['SET', 's', '1']);
        expect(await connection.command(['LPUSH', 's', 'x'])).toMatchObject({ code: 'WRONGTYPE' });
        expect(await connection.command(['GET', 's'])).toBe('1');
    });

    it('pipelines commands and reads their replies in order', async () => {
        const server = await start();
        const connection = await connect(server);
        const replies = await connection.pipeline([
            ['SET', 'a', '1'],
            ['GET', 'a'],
            ['NOPE'],
            ['TYPE', 'a'],
        ]);
        expect(replies[0]).toBe('OK');
        expect(replies[1]).toBe('1');
        expect(replies[2]).toBeInstanceOf(RespError);
        expect(replies[3]).toBe('string');
    });

    it('refuses to run two commands at once', async () => {
        const server = await start();
        const connection = await connect(server);
        const slow = connection.command(['DEBUG', 'SLEEP', '0.2']);
        await expect(connection.command(['PING'])).rejects.toMatchObject({ code: 'INTERNAL' });
        expect(await slow).toBe('OK');
    });

    it('refuses commands that turn the connection into a stream', async () => {
        const server = await start();
        const connection = await connect(server);
        await expect(connection.command(['subscribe', 'ch'])).rejects.toMatchObject({
            code: 'UNSUPPORTED',
        });
        expect(await connection.command(['PING'])).toBe('PONG');
    });

    it('streams the elements of a large reply one at a time', async () => {
        const server = await start();
        const connection = await connect(server);
        const stream = connection.open(['XBIG', 50_000, 20]);
        const header = await stream.header();
        expect(header).toEqual({ kind: 'array', length: 50_000 });
        let count = 0;
        let last = '';
        for (let i = 0; i < 50_000; i++) {
            last = (await stream.value()) as string;
            count++;
        }
        stream.done();
        expect(count).toBe(50_000);
        expect(last.startsWith('49999:')).toBe(true);
        // The connection is usable again once the reply has been read.
        expect(await connection.command(['PING'])).toBe('PONG');
    });

    it('applies back-pressure: an unread reply does not fill memory', async () => {
        const server = await start();
        const connection = await connect(server);
        const stream = connection.open(['XBIG', 400_000, 100]); // about 50 MB of reply
        await stream.header();
        await new Promise((resolve) => setTimeout(resolve, 300));
        // Nothing was read past the header, so almost nothing is buffered here.
        const pump = (connection as unknown as { pump: SocketPump }).pump;
        expect(pump.buffered.length).toBeLessThan(8 * 1024 * 1024);
        connection.destroy();
    });

    it('reports a dropped connection as a failure and stays closed', async () => {
        const server = await start();
        const connection = await connect(server);
        await server.stop();
        servers = [];
        await expect(connection.command(['PING'])).rejects.toMatchObject({
            code: 'CONNECTION_FAILED',
        });
        expect(connection.closed).toBe(true);
    });

    it('times out connecting to a port nobody listens on', async () => {
        await expect(
            RedisConnection.connect({
                host: '127.0.0.1',
                port: 1,
                tls: { mode: 'disable' },
                connectTimeoutMs: 1500,
            }),
        ).rejects.toMatchObject({ code: 'CONNECTION_FAILED' });
    });
});
