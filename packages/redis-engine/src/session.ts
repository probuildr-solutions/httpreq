/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import {
    DbError,
    throwIfAborted,
    type ColumnInfo,
    type ColumnMeta,
    type ConnectionConfig,
    type ConstraintInfo,
    type DatabaseInfo,
    type DbValue,
    type ExecuteOptions,
    type Execution,
    type ExplainPlan,
    type IndexInfo,
    type ObjectRef,
    type PermissionSet,
    type RelationalSession,
    type ResultEvent,
    type RoutineInfo,
    type SchemaInfo,
    type ServerInfo,
    type SessionInfo,
    type TableInfo,
    type TriggerInfo,
} from '@httpreq/db-core';
import {
    RedisConnection,
    RespError,
    RespMap,
    redisError,
    type RedisConnectOptions,
    type RedisReplyStream,
    type RespValue,
} from '@httpreq/db-protocol-redis';
import { parseCommandLine, quoteArgument } from './commandLine';

/** Keys listed in the explorer for one database; the rest are reached with `SCAN`. */
export const MAX_LISTED_KEYS = 5_000;
const SCAN_COUNT = 1_000;
const DEFAULT_PAGE_ROWS = 500;

/** Replies that are flat key/value lists on RESP2 and maps on RESP3. */
const FIELD_VALUE: Record<string, [string, string]> = {
    HGETALL: ['field', 'value'],
    'CONFIG GET': ['parameter', 'value'],
};

/** Sorted-set replies with scores: flat member/score pairs on RESP2, pair arrays on RESP3. */
const MEMBER_SCORE = new Set([
    'ZRANGE',
    'ZREVRANGE',
    'ZRANGEBYSCORE',
    'ZREVRANGEBYSCORE',
    'ZPOPMIN',
    'ZPOPMAX',
    'ZRANGEBYLEX',
]);

const STREAM_ENTRIES = new Set(['XRANGE', 'XREVRANGE']);
const SCANS = new Set(['SCAN', 'SSCAN', 'HSCAN', 'ZSCAN']);

/** What a value looks like in a result, as a plain value the window can show. */
export const toDbValue = (value: RespValue): DbValue => {
    if (value === null) return null;
    if (value instanceof RespError) return { $type: 'error', $value: value.message };
    if (value instanceof RespMap) {
        const out: { [key: string]: DbValue } = {};
        for (const [key, item] of value.entries) out[String(toDbValue(key))] = toDbValue(item);
        return out;
    }
    if (Array.isArray(value)) return value.map(toDbValue);
    return value;
};

const typeOf = (value: RespValue): string => {
    if (value === null) return 'nil';
    if (value instanceof RespError) return 'error';
    if (value instanceof RespMap) return 'map';
    if (Array.isArray(value)) return 'array';
    if (value instanceof Uint8Array) return 'bytes';
    if (typeof value === 'number' || typeof value === 'bigint') return 'integer';
    if (typeof value === 'boolean') return 'boolean';
    return 'string';
};

const text = (value: RespValue | undefined): string => {
    if (value === null || value === undefined) return '';
    if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8');
    if (value instanceof RespError) return value.message;
    return String(value);
};

const pairsOf = (value: RespValue): [RespValue, RespValue][] =>
    value instanceof RespMap
        ? value.entries
        : Array.isArray(value)
          ? Array.from({ length: Math.floor(value.length / 2) }, (_, i) => [
                value[i * 2]!,
                value[i * 2 + 1]!,
            ])
          : [];

/** The first one or two words of a command: what picks its reply shape. */
const commandName = (args: string[]): string => {
    const first = (args[0] ?? '').toUpperCase();
    return first === 'CONFIG' ? `${first} ${(args[1] ?? '').toUpperCase()}` : first;
};

/** `key=value` fields of an `INFO` or `CLIENT LIST` line. */
const fields = (line: string): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const part of line.split(' ')) {
        const at = part.indexOf('=');
        if (at > 0) out[part.slice(0, at)] = part.slice(at + 1);
    }
    return out;
};

/**
 * A Redis or Valkey session. Statements are command lines (`SET greeting hello`, `HGETALL user:1`),
 * one per line, and their replies come back as tables so the same grid shows them: a list becomes
 * an index/value table, a hash a field/value table, a sorted set a member/score table.
 *
 * Two connections are used. The first runs the user's commands; the second serves the explorer
 * (databases, keys, key details) and `CLIENT` administration while the first is busy.
 */
export class RedisSession implements RelationalSession {
    readonly info: ServerInfo;
    private auxiliary: Promise<RedisConnection> | null = null;
    private auxiliaryTurn: Promise<unknown> = Promise.resolve();
    /** The database the auxiliary connection is on, to avoid a `SELECT` before every call. */
    private auxiliaryDb = 0;
    private closed = false;

    private constructor(
        private readonly main: RedisConnection,
        private readonly options: RedisConnectOptions,
        private readonly config: ConnectionConfig,
        info: ServerInfo,
    ) {
        this.info = info;
    }

    static async open(
        options: RedisConnectOptions,
        config: ConnectionConfig,
        signal?: AbortSignal,
    ): Promise<RedisSession> {
        const main = await RedisConnection.connect(options, signal);
        try {
            const user =
                text(await main.command(['ACL', 'WHOAMI'])) || options.username || 'default';
            const valkey = main.hello.server.toLowerCase() === 'valkey';
            return new RedisSession(main, options, config, {
                product: valkey ? 'Valkey' : 'Redis',
                version: main.hello.version,
                connectionId: main.hello.id !== undefined ? String(main.hello.id) : undefined,
                user: user.startsWith('ERR') ? (options.username ?? 'default') : user,
                secure: main.secure,
            });
        } catch (error) {
            main.destroy();
            throw error;
        }
    }

    get alive(): boolean {
        return !this.closed && !this.main.closed;
    }

    async ping(): Promise<void> {
        await this.main.ping();
    }

    async close(): Promise<void> {
        this.closed = true;
        await this.main.close().catch(() => undefined);
        if (this.auxiliary)
            await (await this.auxiliary.catch(() => null))?.close().catch(() => undefined);
    }

    /* ---------- Commands ---------- */

    execute(command: string, options: ExecuteOptions = {}): Execution {
        throwIfAborted(options.signal);
        const args = parseCommandLine(command.trim());
        if (args.length === 0) throw new DbError('INVALID_REQUEST', 'There is no command to run.');
        const pageRows = options.pageRows ?? DEFAULT_PAGE_ROWS;
        const timeoutMs = options.timeoutMs ?? this.config.queryTimeoutMs;
        let stopped: 'cancelled' | 'timeout' | null = null;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const stop = (why: 'cancelled' | 'timeout') => {
            stopped ??= why;
            // Redis cannot interrupt a command that is running. The only way to stop waiting for
            // one is to drop the connection, which the connection manager then re-opens.
            this.main.destroy();
        };
        if (timeoutMs > 0) timer = setTimeout(() => stop('timeout'), timeoutMs);
        const onAbort = () => stop('cancelled');
        options.signal?.addEventListener('abort', onAbort, { once: true });
        const cleanup = () => {
            clearTimeout(timer);
            options.signal?.removeEventListener('abort', onAbort);
        };
        const reason = () =>
            stopped === 'timeout'
                ? new DbError(
                      'TIMEOUT',
                      'The command ran longer than the time limit and was stopped.',
                  )
                : new DbError('CANCELLED', 'The command was cancelled.');

        const main = this.main;
        const iterate = async function* (): AsyncGenerator<ResultEvent> {
            let stream: RedisReplyStream | null = null;
            try {
                stream = main.open(args);
                yield* shapeReply(stream, args, pageRows, main.hello.protocol);
                stream.done();
            } catch (error) {
                if (stopped) throw reason();
                stream?.done();
                throw error;
            } finally {
                cleanup();
            }
            if (stopped) throw reason();
        };
        return Object.assign(iterate(), {
            cancel: async () => {
                stop('cancelled');
            },
        });
    }

    async begin(): Promise<void> {
        await this.simple(['MULTI']);
    }

    async commit(): Promise<void> {
        await this.simple(['EXEC']);
    }

    async rollback(): Promise<void> {
        await this.simple(['DISCARD']);
    }

    private async simple(args: string[]): Promise<void> {
        const reply = await this.main.command(args);
        if (reply instanceof RespError) throw redisError(reply);
    }

    explain(): Promise<ExplainPlan> {
        throw new DbError('UNSUPPORTED', 'Redis has no query plans.');
    }

    quoteIdentifier(name: string): string {
        return quoteArgument(name);
    }

    quoteLiteral(value: string): string {
        return quoteArgument(value);
    }

    /* ---------- Browsing ---------- */

    async getPermissions(): Promise<PermissionSet> {
        const reply = await this.onSecond((connection) =>
            connection.command(['ACL', 'GETUSER', this.info.user ?? 'default']),
        );
        if (reply instanceof RespError) return { read: true, write: true, schema: true };
        const pairs = pairsOf(reply);
        const commands = text(pairs.find(([key]) => text(key) === 'commands')?.[1]);
        const denies = (what: string) =>
            new RegExp(`(^|\\s)-(${what})(\\s|$)`).test(commands) &&
            !new RegExp(`(^|\\s)\\+(${what})(\\s|$)`).test(commands);
        const nothing = /^-@all(\s|$)/.test(commands) && !/\+@/.test(commands);
        return {
            read: !nothing && !denies('@read'),
            write: !nothing && !denies('@write'),
            schema: !nothing && !denies('@dangerous'),
            grants: commands ? [commands] : undefined,
        };
    }

    async listDatabases(): Promise<DatabaseInfo[]> {
        return this.onSecond(async (connection) => {
            let count = 16;
            const config = await connection.command(['CONFIG', 'GET', 'databases']);
            if (!(config instanceof RespError)) {
                const value = Number(text(pairsOf(config)[0]?.[1]));
                if (Number.isInteger(value) && value > 0) count = Math.min(value, 256);
            }
            return Array.from({ length: count }, (_, index) => ({
                name: `db${index}`,
                system: false,
            }));
        });
    }

    async listSchemas(): Promise<SchemaInfo[]> {
        return [];
    }

    /** Keys of one database, with their types. At most `MAX_LISTED_KEYS`. */
    async listTables(scope: { database?: string }): Promise<TableInfo[]> {
        const index = this.databaseIndex(scope.database);
        return this.onSecond(async (connection) => {
            await this.selectOn(connection, index);
            const names: string[] = [];
            let cursor = '0';
            do {
                const reply = await connection.command(['SCAN', cursor, 'COUNT', SCAN_COUNT]);
                if (reply instanceof RespError) throw redisError(reply);
                const [next, batch] = reply as [RespValue, RespValue[]];
                cursor = text(next);
                for (const key of batch) {
                    if (names.length < MAX_LISTED_KEYS) names.push(text(key));
                }
            } while (cursor !== '0' && names.length < MAX_LISTED_KEYS);
            const types = names.length
                ? await connection.pipeline(names.map((name) => ['TYPE', name]))
                : [];
            const tables: TableInfo[] = names.map((name, i) => ({
                database: scope.database,
                name,
                kind: text(types[i]) || 'string',
            }));
            tables.sort((a, b) => a.name.localeCompare(b.name));
            if (cursor !== '0') {
                tables.push({
                    database: scope.database,
                    name: `… more keys than the first ${MAX_LISTED_KEYS.toLocaleString('en-US')}; use SCAN with MATCH`,
                    kind: 'note',
                });
            }
            return tables;
        });
    }

    async listColumns(): Promise<ColumnInfo[]> {
        return [];
    }

    async listIndexes(): Promise<IndexInfo[]> {
        return [];
    }

    async listConstraints(): Promise<ConstraintInfo[]> {
        return [];
    }

    async listRoutines(): Promise<RoutineInfo[]> {
        return [];
    }

    async listTriggers(): Promise<TriggerInfo[]> {
        return [];
    }

    /** What a key is: its type, size, lifetime and encoding, as text. */
    async getDefinition(object: ObjectRef & { kind: string }): Promise<string> {
        const index = this.databaseIndex(object.database);
        return this.onSecond(async (connection) => {
            await this.selectOn(connection, index);
            const type = text(await connection.command(['TYPE', object.name]));
            if (type === 'none')
                throw new DbError('NOT_FOUND', `The key “${object.name}” does not exist.`);
            const length: Record<string, string> = {
                string: 'STRLEN',
                hash: 'HLEN',
                list: 'LLEN',
                set: 'SCARD',
                zset: 'ZCARD',
                stream: 'XLEN',
            };
            const [ttl, encoding, memory, size] = await connection.pipeline([
                ['TTL', object.name],
                ['OBJECT', 'ENCODING', object.name],
                ['MEMORY', 'USAGE', object.name],
                [length[type] ?? 'EXISTS', object.name],
            ]);
            const ttlNumber = Number(ttl);
            return [
                `key:      ${object.name}`,
                `database: db${index}`,
                `type:     ${type}`,
                `size:     ${text(size)} ${type === 'string' ? 'bytes' : 'elements'}`,
                `ttl:      ${ttlNumber < 0 ? 'no expiry' : `${ttlNumber} s`}`,
                ...(encoding instanceof RespError ? [] : [`encoding: ${text(encoding)}`]),
                ...(memory instanceof RespError ? [] : [`memory:   ${text(memory)} bytes`]),
            ].join('\n');
        });
    }

    async listSessions(): Promise<SessionInfo[]> {
        const reply = await this.onSecond((connection) => connection.command(['CLIENT', 'LIST']));
        if (reply instanceof RespError) throw redisError(reply);
        return text(reply)
            .split('\n')
            .filter(Boolean)
            .map((line) => {
                const f = fields(line);
                return {
                    id: f.id ?? '',
                    user: f.user,
                    database: f.db ? `db${f.db}` : undefined,
                    state: f.flags,
                    seconds: Number(f.age ?? 0),
                    statement: f.cmd && f.cmd !== 'NULL' ? f.cmd : undefined,
                };
            });
    }

    async killSession(id: string): Promise<void> {
        const reply = await this.onSecond((connection) =>
            connection.command(['CLIENT', 'KILL', 'ID', id]),
        );
        if (reply instanceof RespError) throw redisError(reply);
    }

    async serverStatus(): Promise<Record<string, string>> {
        const reply = await this.onSecond((connection) => connection.command(['INFO', 'all']));
        if (reply instanceof RespError) throw redisError(reply);
        const out: Record<string, string> = {};
        for (const line of text(reply).split(/\r?\n/)) {
            const at = line.indexOf(':');
            if (at > 0 && !line.startsWith('#')) out[line.slice(0, at)] = line.slice(at + 1);
        }
        return out;
    }

    /* ---------- Plumbing ---------- */

    private databaseIndex(name: string | undefined): number {
        if (name === undefined) return this.options.database ?? 0;
        const match = /^db(\d+)$/.exec(name);
        if (!match)
            throw new DbError('INVALID_REQUEST', `“${name}” is not a Redis database (db0, db1…).`);
        return Number(match[1]);
    }

    private async selectOn(connection: RedisConnection, index: number): Promise<void> {
        if (this.auxiliaryDb === index) return;
        const reply = await connection.command(['SELECT', index]);
        if (reply instanceof RespError) throw redisError(reply);
        this.auxiliaryDb = index;
    }

    private onSecond<T>(work: (connection: RedisConnection) => Promise<T>): Promise<T> {
        const run = async () => work(await this.second());
        const result = this.auxiliaryTurn.then(run, run);
        this.auxiliaryTurn = result.catch(() => undefined);
        return result;
    }

    private second(): Promise<RedisConnection> {
        if (this.closed)
            return Promise.reject(new DbError('CONNECTION_FAILED', 'The session is closed.'));
        this.auxiliary ??= RedisConnection.connect({ ...this.options, database: undefined }).then(
            (connection) => {
                this.auxiliaryDb = 0;
                return connection;
            },
        );
        return this.auxiliary.then(
            (connection) => {
                if (connection.closed) {
                    this.auxiliary = null;
                    return this.second();
                }
                return connection;
            },
            (error: unknown) => {
                this.auxiliary = null;
                throw error;
            },
        );
    }
}

/* ---------- Reply shaping ---------- */

const columns = (...names: [string, string][]): ResultEvent => ({
    kind: 'columns',
    columns: names.map(([name, type]): ColumnMeta => ({ name, type })),
});

/**
 * Turns the reply of a command into result events: a header, the rows in pages as the elements are
 * parsed (so a reply of millions of elements is never held whole), and the end.
 */
async function* shapeReply(
    stream: RedisReplyStream,
    args: string[],
    pageRows: number,
    protocol: 2 | 3,
): AsyncGenerator<ResultEvent> {
    const name = commandName(args);
    const header = await stream.header();

    if (header.kind === 'value') {
        const value = header.value;
        if (value instanceof RespError) throw redisError(value);
        // Long text (INFO, CLIENT LIST) reads better a line to a row.
        if (typeof value === 'string' && value.includes('\n')) {
            const lines = value
                .split(/\r?\n/)
                .filter((line, i, all) => line !== '' || i < all.length - 1);
            yield columns(['line', 'string']);
            for (let i = 0; i < lines.length; i += pageRows) {
                yield { kind: 'rows', rows: lines.slice(i, i + pageRows).map((line) => [line]) };
            }
            yield { kind: 'end', rowCount: lines.length };
            return;
        }
        yield columns(['result', typeOf(value)]);
        yield { kind: 'rows', rows: [[toDbValue(value)]] };
        yield { kind: 'end', rowCount: 1 };
        return;
    }

    if (header.kind === 'map') {
        const labels = FIELD_VALUE[name] ?? ['key', 'value'];
        yield columns([labels[0], 'string'], [labels[1], 'string']);
        let page: DbValue[][] = [];
        let count = 0;
        for (let i = 0; i < header.length; i++) {
            const key = await stream.value();
            const value = await stream.value();
            page.push([toDbValue(key), toDbValue(value)]);
            count++;
            if (page.length >= pageRows) {
                yield { kind: 'rows', rows: page };
                page = [];
            }
        }
        if (page.length > 0) yield { kind: 'rows', rows: page };
        yield { kind: 'end', rowCount: count };
        return;
    }

    // Scans answer with a cursor and a batch: show the batch, and say where to continue.
    if (SCANS.has(name)) {
        // `[cursor, [items…]]`: the header said two elements.
        const cursor = text(await stream.value());
        const items = (await stream.value()) as RespValue[];
        const paired = name === 'HSCAN' || name === 'ZSCAN';
        yield paired
            ? columns(
                  [name === 'HSCAN' ? 'field' : 'member', 'string'],
                  [name === 'HSCAN' ? 'value' : 'score', 'string'],
              )
            : columns(['key', 'string']);
        const rows: DbValue[][] = paired
            ? pairsOf(items).map(([a, b]) => [toDbValue(a), toDbValue(b)])
            : items.map((item) => [toDbValue(item)]);
        for (let i = 0; i < rows.length; i += pageRows)
            yield { kind: 'rows', rows: rows.slice(i, i + pageRows) };
        yield {
            kind: 'end',
            rowCount: rows.length,
            info: cursor === '0' ? 'The scan is complete.' : `Next cursor: ${cursor}`,
        };
        return;
    }
    yield* shapeArray(stream, name, args, header.length, pageRows, protocol);
}

async function* shapeArray(
    stream: RedisReplyStream,
    name: string,
    args: string[],
    length: number,
    pageRows: number,
    protocol: 2 | 3,
): AsyncGenerator<ResultEvent> {
    const flatPairs =
        protocol === 2 &&
        (name in FIELD_VALUE ||
            (MEMBER_SCORE.has(name) &&
                (name.startsWith('ZPOP') || args.some((a) => a.toUpperCase() === 'WITHSCORES'))));
    const pairLabels: [string, string] =
        name in FIELD_VALUE ? FIELD_VALUE[name]! : ['member', 'score'];

    let page: DbValue[][] = [];
    let count = 0;
    const push = async function* (row: DbValue[]): AsyncGenerator<ResultEvent> {
        page.push(row);
        count++;
        if (page.length >= pageRows) {
            const rows = page;
            page = [];
            yield { kind: 'rows', rows };
        }
    };

    if (flatPairs) {
        yield columns([pairLabels[0], 'string'], [pairLabels[1], 'string']);
        for (let i = 0; i + 1 < length; i += 2) {
            const a = await stream.value();
            const b = await stream.value();
            yield* push([toDbValue(a), toDbValue(b)]);
        }
        if (length % 2 === 1) await stream.value();
    } else if (STREAM_ENTRIES.has(name)) {
        yield columns(['id', 'string'], ['fields', 'map']);
        for (let i = 0; i < length; i++) {
            const entry = await stream.value();
            const [id, body] = Array.isArray(entry) ? entry : [null, null];
            yield* push([
                toDbValue(id ?? null),
                toDbValue(body instanceof RespMap ? body : new RespMap(pairsOf(body ?? null))),
            ]);
        }
    } else if (MEMBER_SCORE.has(name) && protocol === 3) {
        yield columns([pairLabels[0], 'string'], [pairLabels[1], 'double']);
        for (let i = 0; i < length; i++) {
            const item = await stream.value();
            yield* push(
                Array.isArray(item) && item.length === 2
                    ? [toDbValue(item[0]!), toDbValue(item[1]!)]
                    : [toDbValue(item), null],
            );
        }
    } else {
        yield columns(['index', 'integer'], ['value', 'string']);
        for (let i = 0; i < length; i++) {
            yield* push([i, toDbValue(await stream.value())]);
        }
    }
    if (page.length > 0) yield { kind: 'rows', rows: page };
    yield { kind: 'end', rowCount: count };
}
