/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { createServer, type Server, type Socket } from 'node:net';

/**
 * A small in-memory server that speaks the Redis protocol (RESP2 and RESP3), for the tests of the
 * Redis driver and engine on machines without a Redis or Valkey installed.
 *
 * It is NOT Redis. It implements the commands the driver and the explorer issue, with the replies
 * a real server gives for them, and nothing more: what it proves is that our reading and writing
 * of the protocol is self-consistent and handles the documented reply shapes, not that every
 * server behaves this way. Tests that matter for correctness against the real thing belong on a
 * real server (`startRedis` would be the place; none is installed here).
 */

export interface FakeRedisOptions {
    /** `requirepass`. */
    password?: string;
    /** ACL users: name to password. */
    users?: Record<string, string>;
    /** What `HELLO` reports as `server`. */
    serverName?: 'redis' | 'valkey';
    /** Pretend to be a server older than 6 that has no `HELLO`. */
    resp2Only?: boolean;
    databases?: number;
}

export interface FakeRedis {
    host: string;
    port: number;
    /** Direct access to the data for assertions: database index to key to value. */
    data: Map<number, Map<string, Entry>>;
    /** Number of connections accepted so far. */
    connections: () => number;
    stop(): Promise<void>;
}

type Entry =
    | { type: 'string'; value: Buffer; expiresAt?: number }
    | { type: 'hash'; value: Map<string, Buffer>; expiresAt?: number }
    | { type: 'list'; value: Buffer[]; expiresAt?: number }
    | { type: 'set'; value: Set<string>; expiresAt?: number }
    | { type: 'zset'; value: Map<string, number>; expiresAt?: number };

const CRLF = '\r\n';

class Session {
    db = 0;
    proto: 2 | 3 = 2;
    authed: boolean;
    user = 'default';
    id: number;
    name = '';
    queue: Buffer[][] | null = null;
    blocked: (() => void) | null = null;

    constructor(
        readonly socket: Socket,
        id: number,
        authed: boolean,
    ) {
        this.id = id;
        this.authed = authed;
    }
}

const bulk = (value: Buffer | string): Buffer => {
    const bytes = typeof value === 'string' ? Buffer.from(value) : value;
    return Buffer.concat([Buffer.from(`$${bytes.length}${CRLF}`), bytes, Buffer.from(CRLF)]);
};

const globToRegExp = (pattern: string): RegExp =>
    new RegExp(
        `^${pattern
            .replace(/[.+^${}()|\\]/g, '\\$&')
            .replace(/\*/g, '.*')
            .replace(/\?/g, '.')}$`,
        's',
    );

export const startFakeRedis = async (options: FakeRedisOptions = {}): Promise<FakeRedis> => {
    const databases = options.databases ?? 16;
    const data = new Map<number, Map<string, Entry>>();
    const db = (index: number) => {
        let map = data.get(index);
        if (!map) data.set(index, (map = new Map()));
        return map;
    };
    const sessions = new Set<Session>();
    let nextId = 1;
    let accepted = 0;
    const needsAuth = options.password !== undefined || options.users !== undefined;

    const live = (session: Session, key: string): Entry | undefined => {
        const map = db(session.db);
        const entry = map.get(key);
        if (entry?.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
            map.delete(key);
            return undefined;
        }
        return entry;
    };

    const simple = (text: string) => Buffer.from(`+${text}${CRLF}`);
    const error = (text: string) => Buffer.from(`-${text}${CRLF}`);
    const integer = (n: number) => Buffer.from(`:${n}${CRLF}`);
    const nil = (session: Session) => Buffer.from(session.proto === 3 ? `_${CRLF}` : `$-1${CRLF}`);
    const array = (items: Buffer[]) =>
        Buffer.concat([Buffer.from(`*${items.length}${CRLF}`), ...items]);
    const map = (session: Session, pairs: [Buffer, Buffer][]) =>
        session.proto === 3
            ? Buffer.concat([Buffer.from(`%${pairs.length}${CRLF}`), ...pairs.flat()])
            : array(pairs.flat());

    const wrongType = () =>
        error('WRONGTYPE Operation against a key holding the wrong kind of value');

    const run = async (session: Session, args: Buffer[]): Promise<Buffer | null> => {
        const name = args[0]!.toString().toUpperCase();
        const text = (index: number) => args[index]?.toString() ?? '';
        const arity = (min: number) =>
            args.length < min
                ? error(`ERR wrong number of arguments for '${name.toLowerCase()}' command`)
                : null;

        if (!session.authed && !['AUTH', 'HELLO', 'QUIT'].includes(name)) {
            return error('NOAUTH Authentication required.');
        }
        const tryAuth = (user: string, password: string): boolean => {
            if (options.users?.[user] !== undefined) return options.users[user] === password;
            if (user === 'default' && options.password !== undefined) {
                return options.password === password;
            }
            return !needsAuth;
        };

        switch (name) {
            case 'PING':
                return args[1] ? bulk(args[1]) : simple('PONG');
            case 'ECHO':
                return bulk(args[1] ?? '');
            case 'QUIT':
                session.socket.end(simple('OK'));
                return null;
            case 'HELLO': {
                if (options.resp2Only) return error("ERR unknown command 'HELLO'");
                const version = args[1] ? Number(text(1)) : 2;
                if (version !== 2 && version !== 3) {
                    return error('NOPROTO unsupported protocol version');
                }
                const authAt = args.findIndex((a) => a.toString().toUpperCase() === 'AUTH');
                if (authAt > 0) {
                    if (!tryAuth(text(authAt + 1), text(authAt + 2))) {
                        return error(
                            'WRONGPASS invalid username-password pair or user is disabled.',
                        );
                    }
                    session.authed = true;
                    session.user = text(authAt + 1);
                } else if (!session.authed) {
                    return error(
                        'NOAUTH HELLO must be called with the client already authenticated',
                    );
                }
                session.proto = version;
                return map(session, [
                    [bulk('server'), bulk(options.serverName ?? 'redis')],
                    [bulk('version'), bulk(options.serverName === 'valkey' ? '8.0.1' : '7.4.0')],
                    [bulk('proto'), integer(version)],
                    [bulk('id'), integer(session.id)],
                    [bulk('mode'), bulk('standalone')],
                    [bulk('role'), bulk('master')],
                    [bulk('modules'), array([])],
                ]);
            }
            case 'AUTH': {
                const user = args.length > 2 ? text(1) : 'default';
                const password = args.length > 2 ? text(2) : text(1);
                if (!needsAuth) {
                    return error(
                        'ERR AUTH <password> called without any password configured for the default user. Are you sure your configuration is correct?',
                    );
                }
                if (!tryAuth(user, password)) {
                    return error('WRONGPASS invalid username-password pair or user is disabled.');
                }
                session.authed = true;
                session.user = user;
                return simple('OK');
            }
            case 'SELECT': {
                const index = Number(text(1));
                if (!Number.isInteger(index) || index < 0 || index >= databases) {
                    return error('ERR DB index is out of range');
                }
                session.db = index;
                return simple('OK');
            }
            case 'DBSIZE':
                return integer(
                    [...db(session.db).keys()].filter((key) => live(session, key)).length,
                );
            case 'FLUSHDB':
                db(session.db).clear();
                return simple('OK');
            case 'SET': {
                const missing = arity(3);
                if (missing) return missing;
                const entry: Entry = { type: 'string', value: args[2]! };
                for (let i = 3; i < args.length; i++) {
                    if (text(i).toUpperCase() === 'EX')
                        entry.expiresAt = Date.now() + Number(text(++i)) * 1000;
                }
                db(session.db).set(text(1), entry);
                return simple('OK');
            }
            case 'GET': {
                const entry = live(session, text(1));
                if (!entry) return nil(session);
                return entry.type === 'string' ? bulk(entry.value) : wrongType();
            }
            case 'DEL': {
                let removed = 0;
                for (let i = 1; i < args.length; i++) {
                    if (live(session, text(i))) {
                        db(session.db).delete(text(i));
                        removed++;
                    }
                }
                return integer(removed);
            }
            case 'EXISTS':
                return integer(args.slice(1).filter((a) => live(session, a.toString())).length);
            case 'TYPE':
                return simple(live(session, text(1))?.type ?? 'none');
            case 'TTL':
            case 'PTTL': {
                const entry = live(session, text(1));
                if (!entry) return integer(-2);
                if (entry.expiresAt === undefined) return integer(-1);
                const ms = entry.expiresAt - Date.now();
                return integer(name === 'TTL' ? Math.ceil(ms / 1000) : ms);
            }
            case 'EXPIRE': {
                const entry = live(session, text(1));
                if (!entry) return integer(0);
                entry.expiresAt = Date.now() + Number(text(2)) * 1000;
                return integer(1);
            }
            case 'KEYS': {
                const matcher = globToRegExp(text(1));
                return array(
                    [...db(session.db).keys()]
                        .filter((key) => live(session, key) && matcher.test(key))
                        .map((key) => bulk(key)),
                );
            }
            case 'SCAN': {
                const cursor = Number(text(1));
                let match = '*';
                let count = 10;
                for (let i = 2; i < args.length; i++) {
                    const option = text(i).toUpperCase();
                    if (option === 'MATCH') match = text(++i);
                    else if (option === 'COUNT') count = Number(text(++i));
                }
                const matcher = globToRegExp(match);
                const keys = [...db(session.db).keys()].filter((key) => live(session, key));
                const slice = keys.slice(cursor, cursor + count);
                const next = cursor + count >= keys.length ? 0 : cursor + count;
                return array([
                    bulk(String(next)),
                    array(slice.filter((key) => matcher.test(key)).map((key) => bulk(key))),
                ]);
            }
            case 'HSET': {
                let entry = live(session, text(1));
                if (entry && entry.type !== 'hash') return wrongType();
                if (!entry) {
                    entry = { type: 'hash', value: new Map() };
                    db(session.db).set(text(1), entry);
                }
                let added = 0;
                for (let i = 2; i + 1 < args.length; i += 2) {
                    if (!entry.value.has(text(i))) added++;
                    entry.value.set(text(i), args[i + 1]!);
                }
                return integer(added);
            }
            case 'HGETALL': {
                const entry = live(session, text(1));
                if (!entry) return map(session, []);
                if (entry.type !== 'hash') return wrongType();
                return map(
                    session,
                    [...entry.value].map(([field, value]) => [bulk(field), bulk(value)]),
                );
            }
            case 'RPUSH':
            case 'LPUSH': {
                let entry = live(session, text(1));
                if (entry && entry.type !== 'list') return wrongType();
                if (!entry) {
                    entry = { type: 'list', value: [] };
                    db(session.db).set(text(1), entry);
                }
                for (const item of args.slice(2)) {
                    if (name === 'RPUSH') entry.value.push(item);
                    else entry.value.unshift(item);
                }
                for (const other of sessions) other.blocked?.();
                return integer(entry.value.length);
            }
            case 'LRANGE': {
                const entry = live(session, text(1));
                if (!entry) return array([]);
                if (entry.type !== 'list') return wrongType();
                const length = entry.value.length;
                let from = Number(text(2));
                let to = Number(text(3));
                if (from < 0) from += length;
                if (to < 0) to += length;
                return array(entry.value.slice(Math.max(0, from), to + 1).map((v) => bulk(v)));
            }
            case 'BLPOP': {
                const key = text(1);
                const waitMs = Number(text(args.length - 1)) * 1000;
                const started = Date.now();
                for (;;) {
                    const entry = live(session, key);
                    if (entry?.type === 'list' && entry.value.length > 0) {
                        return array([bulk(key), bulk(entry.value.shift()!)]);
                    }
                    if (session.socket.destroyed) return null;
                    if (waitMs > 0 && Date.now() - started >= waitMs) return nil(session);
                    await new Promise<void>((resolve) => {
                        const timer = setTimeout(resolve, 50);
                        session.blocked = () => {
                            clearTimeout(timer);
                            resolve();
                        };
                    });
                    session.blocked = null;
                }
            }
            case 'SADD': {
                let entry = live(session, text(1));
                if (entry && entry.type !== 'set') return wrongType();
                if (!entry) {
                    entry = { type: 'set', value: new Set() };
                    db(session.db).set(text(1), entry);
                }
                let added = 0;
                for (const member of args.slice(2)) {
                    if (!entry.value.has(member.toString())) added++;
                    entry.value.add(member.toString());
                }
                return integer(added);
            }
            case 'SMEMBERS': {
                const entry = live(session, text(1));
                if (!entry) return session.proto === 3 ? Buffer.from(`~0${CRLF}`) : array([]);
                if (entry.type !== 'set') return wrongType();
                const items = [...entry.value].map((member) => bulk(member));
                return session.proto === 3
                    ? Buffer.concat([Buffer.from(`~${items.length}${CRLF}`), ...items])
                    : array(items);
            }
            case 'ZADD': {
                let entry = live(session, text(1));
                if (entry && entry.type !== 'zset') return wrongType();
                if (!entry) {
                    entry = { type: 'zset', value: new Map() };
                    db(session.db).set(text(1), entry);
                }
                let added = 0;
                for (let i = 2; i + 1 < args.length; i += 2) {
                    if (!entry.value.has(text(i + 1))) added++;
                    entry.value.set(text(i + 1), Number(text(i)));
                }
                return integer(added);
            }
            case 'ZRANGE': {
                const entry = live(session, text(1));
                if (!entry) return array([]);
                if (entry.type !== 'zset') return wrongType();
                const withScores = args.some((a) => a.toString().toUpperCase() === 'WITHSCORES');
                const sorted = [...entry.value].sort((a, b) => a[1] - b[1]);
                let from = Number(text(2));
                let to = Number(text(3));
                if (from < 0) from += sorted.length;
                if (to < 0) to += sorted.length;
                const slice = sorted.slice(Math.max(0, from), to + 1);
                const score = (n: number) =>
                    session.proto === 3 ? Buffer.from(`,${n}${CRLF}`) : bulk(String(n));
                if (!withScores) return array(slice.map(([member]) => bulk(member)));
                return session.proto === 3
                    ? array(slice.map(([member, n]) => array([bulk(member), score(n)])))
                    : array(slice.flatMap(([member, n]) => [bulk(member), score(n)]));
            }
            case 'STRLEN':
            case 'HLEN':
            case 'LLEN':
            case 'SCARD':
            case 'ZCARD': {
                const entry = live(session, text(1));
                if (!entry) return integer(0);
                const expected = {
                    STRLEN: 'string',
                    HLEN: 'hash',
                    LLEN: 'list',
                    SCARD: 'set',
                    ZCARD: 'zset',
                }[name];
                if (entry.type !== expected) return wrongType();
                return integer(
                    entry.type === 'string'
                        ? entry.value.length
                        : entry.type === 'list'
                          ? entry.value.length
                          : entry.value.size,
                );
            }
            case 'OBJECT':
                return text(1).toUpperCase() === 'ENCODING'
                    ? live(session, text(2))
                        ? bulk('embstr')
                        : nil(session)
                    : error('ERR unknown subcommand');
            case 'MEMORY':
                return live(session, text(2)) ? integer(64) : nil(session);
            case 'CONFIG': {
                if (text(1).toUpperCase() === 'GET' && text(2) === 'databases') {
                    return map(session, [[bulk('databases'), bulk(String(databases))]]);
                }
                return error('ERR unsupported CONFIG');
            }
            case 'INFO': {
                const section = text(1).toLowerCase();
                const lines: string[] = [];
                if (!section || section === 'all' || section === 'server') {
                    lines.push(
                        '# Server',
                        options.serverName === 'valkey'
                            ? 'valkey_version:8.0.1\r\nredis_version:7.2.4'
                            : 'redis_version:7.4.0',
                        'redis_mode:standalone',
                        'uptime_in_seconds:42',
                    );
                }
                if (!section || section === 'all' || section === 'keyspace') {
                    lines.push('# Keyspace');
                    for (const [index, keys] of data) {
                        if (keys.size > 0) {
                            lines.push(`db${index}:keys=${keys.size},expires=0,avg_ttl=0`);
                        }
                    }
                }
                if (!section || section === 'all' || section === 'clients') {
                    lines.push('# Clients', `connected_clients:${sessions.size}`);
                }
                return bulk(lines.join(CRLF) + CRLF);
            }
            case 'CLIENT': {
                const sub = text(1).toUpperCase();
                if (sub === 'ID') return integer(session.id);
                if (sub === 'SETNAME') {
                    session.name = text(2);
                    return simple('OK');
                }
                if (sub === 'LIST') {
                    return bulk(
                        [...sessions]
                            .map(
                                (s) =>
                                    `id=${s.id} addr=127.0.0.1:0 name=${s.name} db=${s.db} cmd=${s === session ? 'client|list' : 'NULL'} age=1 idle=0 user=${s.user}`,
                            )
                            .join('\n') + '\n',
                    );
                }
                if (sub === 'KILL') {
                    const id = text(2).toUpperCase() === 'ID' ? text(3) : '';
                    const victim = [...sessions].find((s) => String(s.id) === id);
                    if (!victim) return error('ERR No such client');
                    victim.socket.destroy();
                    return integer(1);
                }
                return error('ERR unknown subcommand');
            }
            case 'MULTI':
                session.queue = [];
                return simple('OK');
            case 'DISCARD':
                if (!session.queue) return error('ERR DISCARD without MULTI');
                session.queue = null;
                return simple('OK');
            case 'EXEC': {
                if (!session.queue) return error('ERR EXEC without MULTI');
                const queued = session.queue;
                session.queue = null;
                const replies: Buffer[] = [];
                for (const command of queued)
                    replies.push((await run(session, command)) ?? nil(session));
                return array(replies);
            }
            case 'DEBUG':
                if (text(1).toUpperCase() === 'SLEEP') {
                    await new Promise((resolve) => setTimeout(resolve, Number(text(2)) * 1000));
                    return simple('OK');
                }
                return error('ERR unknown subcommand');
            case 'XBIG': {
                // Test-only: an array of N elements, to exercise streaming and back-pressure.
                const count = Number(text(1));
                const size = Number(text(2) || '10');
                const chunks: Buffer[] = [Buffer.from(`*${count}${CRLF}`)];
                const filler = 'x'.repeat(size);
                for (let i = 0; i < count; i++) chunks.push(bulk(`${i}:${filler}`));
                return Buffer.concat(chunks);
            }
            default:
                return error(`ERR unknown command '${name.toLowerCase()}'`);
        }
    };

    const server: Server = createServer((socket) => {
        accepted++;
        const session = new Session(socket, nextId++, !needsAuth);
        sessions.add(session);
        let pending = Buffer.alloc(0);
        let chain: Promise<void> = Promise.resolve();

        const parse = (): Buffer[][] => {
            const commands: Buffer[][] = [];
            for (;;) {
                if (pending.length === 0 || pending[0] !== 0x2a) {
                    if (pending.length > 0) {
                        // Inline commands are not supported: a protocol error closes the connection.
                        socket.end(error('ERR Protocol error: expected array'));
                    }
                    return commands;
                }
                let offset = 0;
                const lineEnd = pending.indexOf(CRLF, offset);
                if (lineEnd < 0) return commands;
                const count = Number(pending.toString('latin1', 1, lineEnd));
                offset = lineEnd + 2;
                const args: Buffer[] = [];
                for (let i = 0; i < count; i++) {
                    const end = pending.indexOf(CRLF, offset);
                    if (end < 0) return commands;
                    const length = Number(pending.toString('latin1', offset + 1, end));
                    const start = end + 2;
                    if (pending.length < start + length + 2) return commands;
                    args.push(pending.subarray(start, start + length));
                    offset = start + length + 2;
                }
                commands.push(args);
                pending = pending.subarray(offset);
            }
        };

        socket.on('data', (chunk) => {
            pending = Buffer.concat([pending, chunk]);
            const commands = parse();
            for (const args of commands) {
                chain = chain.then(async () => {
                    if (socket.destroyed) return;
                    if (
                        session.queue &&
                        !['EXEC', 'DISCARD', 'MULTI'].includes(args[0]!.toString().toUpperCase())
                    ) {
                        session.queue.push(args);
                        socket.write(simple('QUEUED'));
                        return;
                    }
                    const reply = await run(session, args);
                    if (reply && !socket.destroyed) socket.write(reply);
                });
            }
        });
        socket.on('close', () => sessions.delete(session));
        socket.on('error', () => undefined);
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    return {
        host: '127.0.0.1',
        port,
        data,
        connections: () => accepted,
        stop: () =>
            new Promise<void>((resolve) => {
                for (const session of sessions) session.socket.destroy();
                server.close(() => resolve());
            }),
    };
};
