/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { connect as connectTcp, type Socket } from 'node:net';
import { connect as connectTls, type TLSSocket } from 'node:tls';
import {
    DbError,
    throwIfAborted,
    type ColumnMeta,
    type DbValue,
    type ResultEvent,
    type TlsConfig,
} from '@httpreq/db-core';
import { cachingSha2Response, encryptPassword, nativePasswordResponse } from './auth';
import { PacketReader, PayloadReader, framePacket, writeLenEnc, type Packet } from './packets';
import { decodeText, typeName, ColumnFlag, type ColumnDefinition } from './types';

/* Client and server capability flags (the ones this client uses). */
const CLIENT_LONG_PASSWORD = 0x1;
const CLIENT_LONG_FLAG = 0x4;
const CLIENT_CONNECT_WITH_DB = 0x8;
const CLIENT_PROTOCOL_41 = 0x200;
const CLIENT_SSL = 0x800;
const CLIENT_TRANSACTIONS = 0x2000;
const CLIENT_SECURE_CONNECTION = 0x8000;
const CLIENT_MULTI_RESULTS = 0x2_0000;
const CLIENT_PS_MULTI_RESULTS = 0x4_0000;
const CLIENT_PLUGIN_AUTH = 0x8_0000;
const CLIENT_PLUGIN_AUTH_LENENC_CLIENT_DATA = 0x20_0000;
const CLIENT_DEPRECATE_EOF = 0x100_0000;

const SERVER_MORE_RESULTS_EXISTS = 0x8;
/** utf8mb4_general_ci: known to every MySQL and MariaDB release that has utf8mb4. */
const DEFAULT_CHARSET = 45;
/** Pages of rows buffered before the socket is paused. */
const HIGH_WATER_ROWS = 20_000;
const LOW_WATER_ROWS = 5_000;

export interface MysqlConnectOptions {
    host: string;
    port: number;
    user: string;
    password: string;
    database?: string;
    tls: TlsConfig;
    connectTimeoutMs: number;
}

export interface MysqlQueryOptions {
    /** Rows per `rows` event. */
    pageRows?: number;
}

/** An error the server reported for a statement or a login. */
export class MysqlServerError extends DbError {
    constructor(
        readonly errno: number,
        readonly sqlState: string,
        message: string,
    ) {
        super(codeFor(errno), message, { server: { number: errno, state: sqlState } });
        this.name = 'MysqlServerError';
    }
}

const codeFor = (errno: number) => {
    if (errno === 1045 || errno === 1044 || errno === 1698) return 'AUTH_FAILED' as const;
    if (errno === 1142 || errno === 1143 || errno === 1227 || errno === 1370)
        return 'PERMISSION_DENIED' as const;
    if (errno === 1317) return 'CANCELLED' as const; // Query execution was interrupted
    if (errno === 3024) return 'TIMEOUT' as const; // max_execution_time exceeded
    return 'QUERY_FAILED' as const;
};

const parseError = (payload: Buffer, protocol41: boolean): MysqlServerError => {
    const reader = new PayloadReader(payload);
    reader.skip(1);
    const errno = reader.u16();
    let sqlState = 'HY000';
    if (protocol41 && payload[reader.offset] === 0x23) {
        reader.skip(1);
        sqlState = reader.bytes(5).toString('ascii');
    }
    return new MysqlServerError(errno, sqlState, reader.rest());
};

interface OkPacket {
    affectedRows: number | bigint;
    insertId: number | bigint;
    status: number;
    warnings: number;
    info: string;
}

const parseOk = (payload: Buffer): OkPacket => {
    const reader = new PayloadReader(payload);
    reader.skip(1);
    const affectedRows = reader.lenEnc() ?? 0;
    const insertId = reader.lenEnc() ?? 0;
    const status = reader.remaining >= 2 ? reader.u16() : 0;
    const warnings = reader.remaining >= 2 ? reader.u16() : 0;
    // Session-state tracking is not requested, so the rest is a plain message.
    const info = reader.remaining > 0 ? (reader.lenEncString() ?? '') : '';
    return { affectedRows, insertId, status, warnings, info };
};

const parseColumn = (payload: Buffer): ColumnDefinition => {
    const reader = new PayloadReader(payload);
    reader.lenEncBytes(); // catalog
    const schema = reader.lenEncString() ?? '';
    const table = reader.lenEncString() ?? '';
    reader.lenEncBytes(); // original table
    const name = reader.lenEncString() ?? '';
    reader.lenEncBytes(); // original name
    reader.lenEnc(); // length of the fixed fields (0x0c)
    const charset = reader.u16();
    const length = reader.u32();
    const type = reader.u8();
    const flags = reader.u16();
    const decimals = reader.u8();
    return { schema, table, name, charset, length, type, flags, decimals };
};

const toMeta = (column: ColumnDefinition): ColumnMeta => ({
    name: column.name,
    type: typeName(column),
    nullable: (column.flags & ColumnFlag.NotNull) === 0,
});

/** Whether bytes of a field are a number that fits a JavaScript number. */
const asCount = (value: number | bigint): number =>
    typeof value === 'bigint' ? Number(value) : value;

/**
 * A statement being run: an async iterable of events. It reads from the socket only as fast as
 * its consumer iterates: past a high-water mark of buffered rows the socket is paused, which makes
 * the kernel's receive window fill and the server wait, and it is resumed when the consumer has
 * caught up. A consumer that stops iterating early drains the rest of the response in the
 * background so the connection stays usable.
 */
export class MysqlQuery implements AsyncIterable<ResultEvent> {
    private events: ResultEvent[] = [];
    private bufferedRows = 0;
    private waiter: { resolve: () => void } | null = null;
    private finished = false;
    private failure: unknown;
    private abandoned = false;
    private paused = false;

    private state: 'start' | 'columns' | 'columnsEof' | 'rows' = 'start';
    private expected = 0;
    private columns: ColumnDefinition[] = [];
    private page: DbValue[][] = [];
    private rowCount = 0;

    constructor(
        private readonly connection: MysqlConnection,
        private readonly pageRows: number,
        private readonly pause: () => void,
        private readonly resume: () => void,
        private readonly onDone: () => void,
    ) {}

    /** Called by the connection with each packet of the response. */
    handle(packet: Packet): void {
        try {
            this.process(packet);
        } catch (error) {
            this.fail(error);
        }
    }

    /** Called when the connection closes before the response was complete. */
    abort(error: unknown): void {
        if (!this.finished) this.fail(error);
    }

    [Symbol.asyncIterator](): AsyncIterator<ResultEvent> {
        return {
            next: async () => {
                for (;;) {
                    const event = this.events.shift();
                    if (event) {
                        if (event.kind === 'rows') this.bufferedRows -= event.rows.length;
                        if (this.paused && this.bufferedRows <= LOW_WATER_ROWS) {
                            this.paused = false;
                            this.resume();
                        }
                        return { value: event, done: false };
                    }
                    if (this.failure !== undefined) {
                        const error = this.failure;
                        this.failure = undefined;
                        throw error;
                    }
                    if (this.finished) return { value: undefined, done: true };
                    await new Promise<void>((resolve) => (this.waiter = { resolve }));
                }
            },
            return: async () => {
                // The consumer is done: discard the rest, but keep reading so the connection is
                // left in a clean state.
                this.abandoned = true;
                this.events = [];
                this.bufferedRows = 0;
                if (this.paused) {
                    this.paused = false;
                    this.resume();
                }
                return { value: undefined, done: true };
            },
        };
    }

    private emit(event: ResultEvent): void {
        if (this.abandoned) return;
        this.events.push(event);
        if (event.kind === 'rows') this.bufferedRows += event.rows.length;
        this.wake();
        if (!this.paused && this.bufferedRows >= HIGH_WATER_ROWS) {
            this.paused = true;
            this.pause();
        }
    }

    private wake(): void {
        const waiter = this.waiter;
        this.waiter = null;
        waiter?.resolve();
    }

    private fail(error: unknown): void {
        this.finished = true;
        this.failure = error;
        this.onDone();
        this.wake();
    }

    private complete(): void {
        this.finished = true;
        this.onDone();
        this.wake();
    }

    private flushPage(): void {
        if (this.page.length === 0) return;
        const rows = this.page;
        this.page = [];
        this.emit({ kind: 'rows', rows });
    }

    private process(packet: Packet): void {
        const payload = packet.payload;
        const first = payload[0];
        const deprecateEof = this.connection.deprecateEof;

        switch (this.state) {
            case 'start': {
                if (first === 0xff) {
                    this.fail(parseError(payload, true));
                    return;
                }
                if (first === 0x00) {
                    const ok = parseOk(payload);
                    this.emit({
                        kind: 'end',
                        affectedRows: asCount(ok.affectedRows),
                        ...(asCount(ok.insertId) ? { insertId: String(ok.insertId) } : {}),
                        ...(ok.info ? { info: ok.info } : {}),
                        warnings: ok.warnings,
                    });
                    if (ok.status & SERVER_MORE_RESULTS_EXISTS) return;
                    this.complete();
                    return;
                }
                if (first === 0xfb) {
                    // The server asks for a local file. Reading arbitrary local files on a server's
                    // request is a known attack, so it is always refused.
                    this.connection.sendRaw(Buffer.alloc(0), packet.sequence + 1);
                    return;
                }
                const reader = new PayloadReader(payload);
                this.expected = reader.lenEncNumber();
                this.columns = [];
                this.state = 'columns';
                return;
            }
            case 'columns': {
                this.columns.push(parseColumn(payload));
                if (this.columns.length === this.expected) {
                    if (deprecateEof) {
                        this.beginRows();
                    } else {
                        this.state = 'columnsEof';
                    }
                }
                return;
            }
            case 'columnsEof': {
                this.beginRows();
                return;
            }
            case 'rows': {
                if (first === 0xff) {
                    this.flushPage();
                    this.fail(parseError(payload, true));
                    return;
                }
                const terminator = deprecateEof
                    ? first === 0xfe && payload.length < 0xff_ffff
                    : first === 0xfe && payload.length < 9;
                if (terminator) {
                    this.flushPage();
                    let status: number;
                    let warnings: number;
                    let info = '';
                    if (deprecateEof) {
                        const ok = parseOk(payload);
                        status = ok.status;
                        warnings = ok.warnings;
                        info = ok.info;
                    } else {
                        const reader = new PayloadReader(payload);
                        reader.skip(1);
                        warnings = reader.remaining >= 2 ? reader.u16() : 0;
                        status = reader.remaining >= 2 ? reader.u16() : 0;
                    }
                    this.emit({
                        kind: 'end',
                        rowCount: this.rowCount,
                        ...(info ? { info } : {}),
                        warnings,
                    });
                    if (status & SERVER_MORE_RESULTS_EXISTS) {
                        this.state = 'start';
                        return;
                    }
                    this.complete();
                    return;
                }
                const reader = new PayloadReader(payload);
                const row: DbValue[] = new Array(this.columns.length);
                for (let i = 0; i < this.columns.length; i++) {
                    const raw = reader.lenEncBytes();
                    row[i] = raw === null ? null : decodeText(this.columns[i]!, raw);
                }
                this.rowCount++;
                this.page.push(row);
                if (this.page.length >= this.pageRows) this.flushPage();
                return;
            }
        }
    }

    private beginRows(): void {
        this.emit({ kind: 'columns', columns: this.columns.map(toMeta) });
        this.rowCount = 0;
        this.state = 'rows';
    }
}

/**
 * One connection to a MySQL or MariaDB server, speaking the wire protocol directly: handshake,
 * TLS upgrade, authentication (`caching_sha2_password`, `mysql_native_password`), and text
 * commands with streamed results.
 *
 * A connection runs one command at a time (the protocol has no multiplexing). To cancel a running
 * statement, open a second connection and run `KILL QUERY <id>`, which is what the engine does.
 */
export class MysqlConnection {
    serverVersion = '';
    connectionId = 0;
    secure = false;
    /** The server reported the ending of a result with an OK packet instead of an EOF packet. */
    deprecateEof = false;

    private socket!: Socket | TLSSocket;
    private readonly reader = new PacketReader();
    private inbox: Packet[] = [];
    private inboxWaiter: {
        resolve: (packet: Packet) => void;
        reject: (error: unknown) => void;
    } | null = null;
    private handler: ((packet: Packet) => void) | null = null;
    private closedWith: unknown;
    private current: MysqlQuery | null = null;
    private lastSequence = 0;

    private constructor() {}

    static async connect(
        options: MysqlConnectOptions,
        signal?: AbortSignal,
    ): Promise<MysqlConnection> {
        const connection = new MysqlConnection();
        try {
            await connection.open(options, signal);
        } catch (error) {
            connection.destroy();
            throw error;
        }
        return connection;
    }

    get busy(): boolean {
        return this.current !== null;
    }

    get closed(): boolean {
        return this.closedWith !== undefined;
    }

    /** Starts a statement. Throws if another is still running. */
    query(sql: string, options: MysqlQueryOptions = {}): MysqlQuery {
        if (this.closedWith !== undefined) {
            throw new DbError('CONNECTION_FAILED', 'The connection is closed.');
        }
        if (this.current)
            throw new DbError('INTERNAL', 'The connection is busy with another statement.');
        const query = new MysqlQuery(
            this,
            options.pageRows ?? 500,
            () => this.socket.pause(),
            () => this.socket.resume(),
            () => {
                this.current = null;
                this.handler = null;
            },
        );
        this.current = query;
        this.handler = (packet) => query.handle(packet);
        this.send(Buffer.concat([Buffer.from([0x03]), Buffer.from(sql, 'utf8')]), 0);
        // Anything that arrived before the handler was set belongs to this statement.
        for (const packet of this.inbox.splice(0)) query.handle(packet);
        return query;
    }

    /** Selects a database (`USE`). */
    async useDatabase(name: string): Promise<void> {
        await this.runSimple(Buffer.concat([Buffer.from([0x02]), Buffer.from(name, 'utf8')]));
    }

    async ping(): Promise<void> {
        await this.runSimple(Buffer.from([0x0e]));
    }

    /** Sends COM_QUIT and closes the socket. */
    async close(): Promise<void> {
        if (this.closedWith === undefined && !this.current) {
            try {
                this.send(Buffer.from([0x01]), 0);
            } catch {
                // Already gone.
            }
        }
        this.destroy();
    }

    destroy(): void {
        this.closedWith ??= new DbError('CONNECTION_FAILED', 'The connection was closed.');
        this.socket?.destroy();
    }

    /** Sends a payload as its own packet(s), used by the query to answer the server. */
    sendRaw(payload: Buffer, sequence: number): void {
        this.send(payload, sequence);
    }

    /* ---------- Internals ---------- */

    private send(payload: Buffer, sequence: number): void {
        const { frame, next } = framePacket(payload, sequence);
        this.lastSequence = next;
        this.socket.write(frame);
    }

    private async runSimple(command: Buffer): Promise<void> {
        const query = this.current;
        if (query) throw new DbError('INTERNAL', 'The connection is busy with another statement.');
        const done = new Promise<void>((resolve, reject) => {
            this.handler = (packet) => {
                this.handler = null;
                if (packet.payload[0] === 0xff) reject(parseError(packet.payload, true));
                else resolve();
            };
        });
        this.send(command, 0);
        for (const packet of this.inbox.splice(0)) this.handler?.(packet);
        await done;
    }

    private async open(options: MysqlConnectOptions, signal?: AbortSignal): Promise<void> {
        throwIfAborted(signal);
        const socket = await new Promise<Socket>((resolve, reject) => {
            const raw = connectTcp({ host: options.host, port: options.port });
            const timer = setTimeout(
                () => raw.destroy(new DbError('TIMEOUT', 'The connection timed out.')),
                options.connectTimeoutMs,
            );
            const onAbort = () =>
                raw.destroy(new DbError('CANCELLED', 'The connection was cancelled.'));
            signal?.addEventListener('abort', onAbort, { once: true });
            raw.once('connect', () => {
                clearTimeout(timer);
                signal?.removeEventListener('abort', onAbort);
                resolve(raw);
            });
            raw.once('error', (error) => {
                clearTimeout(timer);
                signal?.removeEventListener('abort', onAbort);
                reject(
                    error instanceof DbError
                        ? error
                        : new DbError(
                              'CONNECTION_FAILED',
                              `Could not connect to ${options.host}:${options.port} (${(error as NodeJS.ErrnoException).code ?? 'error'}).`,
                              { cause: error },
                          ),
                );
            });
        });
        socket.setNoDelay(true);
        socket.setKeepAlive(true, 30_000);
        this.attach(socket);

        // The server speaks first.
        const greeting = await this.readPacket(options.connectTimeoutMs);
        if (greeting.payload[0] === 0xff) throw parseError(greeting.payload, false);
        const hello = this.parseHandshake(greeting.payload);
        this.serverVersion = hello.version;
        this.connectionId = hello.connectionId;
        this.deprecateEof = (hello.capabilities & CLIENT_DEPRECATE_EOF) !== 0;

        let flags =
            CLIENT_LONG_PASSWORD |
            CLIENT_LONG_FLAG |
            CLIENT_PROTOCOL_41 |
            CLIENT_TRANSACTIONS |
            CLIENT_SECURE_CONNECTION |
            CLIENT_MULTI_RESULTS |
            CLIENT_PS_MULTI_RESULTS |
            CLIENT_PLUGIN_AUTH |
            CLIENT_PLUGIN_AUTH_LENENC_CLIENT_DATA;
        if (this.deprecateEof) flags |= CLIENT_DEPRECATE_EOF;
        if (options.database) flags |= CLIENT_CONNECT_WITH_DB;

        let sequence = greeting.sequence + 1;
        const serverHasTls = (hello.capabilities & CLIENT_SSL) !== 0;
        const wantTls =
            options.tls.mode !== 'disable' && (serverHasTls || options.tls.mode !== 'prefer');
        if (options.tls.mode !== 'disable' && !serverHasTls && options.tls.mode !== 'prefer') {
            throw new DbError(
                'CONNECTION_FAILED',
                'The server does not offer TLS, which this connection requires.',
            );
        }
        if (wantTls) {
            flags |= CLIENT_SSL;
            const request = Buffer.alloc(32);
            request.writeUInt32LE(flags, 0);
            request.writeUInt32LE(0x4000_0000, 4);
            request[8] = DEFAULT_CHARSET;
            this.send(request, sequence);
            sequence = this.lastSequence;
            await this.upgradeToTls(options);
        }

        const response = this.authResponse(hello.plugin, options.password, hello.nonce);
        const body = Buffer.concat([
            Buffer.from(options.user, 'utf8'),
            Buffer.from([0]),
            writeLenEnc(response.length),
            response,
            ...(options.database ? [Buffer.from(options.database, 'utf8'), Buffer.from([0])] : []),
            Buffer.from(hello.plugin, 'utf8'),
            Buffer.from([0]),
        ]);
        const head = Buffer.alloc(32);
        head.writeUInt32LE(flags, 0);
        head.writeUInt32LE(0x4000_0000, 4);
        head[8] = DEFAULT_CHARSET;
        this.send(Buffer.concat([head, body]), sequence);

        await this.authenticate(options, hello.plugin, hello.nonce);
    }

    private parseHandshake(payload: Buffer) {
        const reader = new PayloadReader(payload);
        const protocol = reader.u8();
        if (protocol !== 10)
            throw new DbError('UNSUPPORTED', `Unsupported MySQL protocol version ${protocol}.`);
        const version = reader.nullTerminated();
        const connectionId = reader.u32();
        const nonce1 = reader.bytes(8);
        reader.skip(1);
        let capabilities = reader.u16();
        reader.skip(1 + 2); // charset, status
        capabilities |= reader.u16() << 16;
        const nonceLength = reader.u8();
        reader.skip(10);
        const nonce2 = reader.bytes(Math.max(13, nonceLength - 8));
        const nonce = Buffer.concat([nonce1, nonce2.subarray(0, nonce2.length - 1)]);
        const plugin =
            capabilities & CLIENT_PLUGIN_AUTH ? reader.nullTerminated() : 'mysql_native_password';
        return { version, connectionId, capabilities: capabilities >>> 0, nonce, plugin };
    }

    private authResponse(plugin: string, password: string, nonce: Buffer): Buffer {
        switch (plugin) {
            case 'caching_sha2_password':
                return cachingSha2Response(password, nonce);
            case 'mysql_native_password':
                return nativePasswordResponse(password, nonce);
            case 'mysql_clear_password':
                if (!this.secure) {
                    throw new DbError(
                        'AUTH_FAILED',
                        'This account needs its password sent in clear text, which is only done over TLS.',
                    );
                }
                return Buffer.concat([Buffer.from(password, 'utf8'), Buffer.from([0])]);
            default:
                throw new DbError(
                    'UNSUPPORTED',
                    `The server asked for the “${plugin}” login method, which is not supported.`,
                );
        }
    }

    private async authenticate(
        options: MysqlConnectOptions,
        startPlugin: string,
        startNonce: Buffer,
    ): Promise<void> {
        let plugin = startPlugin;
        let nonce = startNonce;
        for (;;) {
            const packet = await this.readPacket(options.connectTimeoutMs);
            const payload = packet.payload;
            switch (payload[0]) {
                case 0x00:
                    return;
                case 0xff:
                    throw parseError(payload, true);
                case 0xfe: {
                    // The server wants a different login method.
                    const reader = new PayloadReader(payload);
                    reader.skip(1);
                    plugin = reader.nullTerminated();
                    const data = reader.bytes(reader.remaining);
                    nonce =
                        data.length > 0 && data[data.length - 1] === 0
                            ? data.subarray(0, data.length - 1)
                            : data;
                    this.send(
                        this.authResponse(plugin, options.password, nonce),
                        packet.sequence + 1,
                    );
                    continue;
                }
                case 0x01: {
                    if (plugin !== 'caching_sha2_password') {
                        throw new DbError(
                            'UNSUPPORTED',
                            'The server sent an unexpected login step.',
                        );
                    }
                    const status = payload[1];
                    if (status === 0x03) continue; // fast authentication succeeded; OK follows
                    if (status !== 0x04)
                        throw new DbError('AUTH_FAILED', 'The server refused the login.');
                    // Full authentication: the password must reach the server in a form that is safe.
                    if (this.secure) {
                        this.send(
                            Buffer.concat([
                                Buffer.from(options.password, 'utf8'),
                                Buffer.from([0]),
                            ]),
                            packet.sequence + 1,
                        );
                        continue;
                    }
                    this.send(Buffer.from([0x02]), packet.sequence + 1); // ask for the server's public key
                    const keyPacket = await this.readPacket(options.connectTimeoutMs);
                    if (keyPacket.payload[0] !== 0x01)
                        throw new DbError('AUTH_FAILED', 'The server did not send its public key.');
                    const key = keyPacket.payload.subarray(1).toString('utf8');
                    this.send(
                        encryptPassword(options.password, nonce, key),
                        keyPacket.sequence + 1,
                    );
                    continue;
                }
                default:
                    throw new DbError(
                        'AUTH_FAILED',
                        'The server sent an unexpected response to the login.',
                    );
            }
        }
    }

    private async upgradeToTls(options: MysqlConnectOptions): Promise<void> {
        const tls = options.tls;
        const verify = tls.mode === 'verify-ca' || tls.mode === 'verify-full';
        const raw = this.socket as Socket;
        raw.removeAllListeners('data');
        const secureSocket = await new Promise<TLSSocket>((resolve, reject) => {
            const upgraded = connectTls({
                socket: raw,
                servername: tls.serverName ?? (isIp(options.host) ? undefined : options.host),
                rejectUnauthorized: verify,
                // verify-ca checks the chain but not the name; verify-full checks both.
                ...(tls.mode === 'verify-ca' ? { checkServerIdentity: () => undefined } : {}),
                ...(tls.ca ? { ca: tls.ca } : {}),
                ...(tls.cert ? { cert: tls.cert } : {}),
                ...(tls.key ? { key: tls.key } : {}),
                minVersion: 'TLSv1.2',
            });
            upgraded.once('secureConnect', () => resolve(upgraded));
            upgraded.once('error', (error) =>
                reject(
                    new DbError('CONNECTION_FAILED', `TLS failed: ${(error as Error).message}`, {
                        cause: error,
                    }),
                ),
            );
        });
        this.attach(secureSocket);
        this.secure = true;
    }

    private attach(socket: Socket | TLSSocket): void {
        this.socket = socket;
        socket.on('data', (chunk: Buffer) => {
            let packets: Packet[];
            try {
                packets = this.reader.push(chunk);
            } catch (error) {
                this.fail(error);
                return;
            }
            for (const packet of packets) {
                this.lastSequence = packet.sequence + 1;
                if (this.handler) this.handler(packet);
                else if (this.inboxWaiter) {
                    const waiter = this.inboxWaiter;
                    this.inboxWaiter = null;
                    waiter.resolve(packet);
                } else this.inbox.push(packet);
            }
        });
        socket.on('error', (error) =>
            this.fail(
                new DbError(
                    'CONNECTION_FAILED',
                    `The connection failed (${(error as NodeJS.ErrnoException).code ?? error.message}).`,
                    { cause: error },
                ),
            ),
        );
        socket.on('close', () =>
            this.fail(new DbError('CONNECTION_FAILED', 'The server closed the connection.')),
        );
    }

    private fail(error: unknown): void {
        this.closedWith ??= error;
        this.current?.abort(this.closedWith);
        const waiter = this.inboxWaiter;
        this.inboxWaiter = null;
        waiter?.reject(this.closedWith);
    }

    private readPacket(timeoutMs: number): Promise<Packet> {
        const queued = this.inbox.shift();
        if (queued) return Promise.resolve(queued);
        if (this.closedWith !== undefined) return Promise.reject(this.closedWith);
        return new Promise<Packet>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.inboxWaiter = null;
                reject(new DbError('TIMEOUT', 'The server did not answer in time.'));
            }, timeoutMs);
            this.inboxWaiter = {
                resolve: (packet) => {
                    clearTimeout(timer);
                    resolve(packet);
                },
                reject: (error) => {
                    clearTimeout(timer);
                    reject(error);
                },
            };
        });
    }
}

const isIp = (host: string): boolean => /^[\d.]+$/.test(host) || host.includes(':');
