/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { DbError, type DbValue, type TlsConfig } from '@httpreq/db-core';
import { SocketPump } from '@httpreq/streaming-engine';
import { md5Password, scramSha256 } from './scram';
import { decodeText } from './types';

const PROTOCOL_VERSION = 196608; // 3.0
const SSL_REQUEST = 80877103;
const CANCEL_REQUEST = 80877102;
/** Larger than any message a server sends in practice (a row can hold 1 GB, but not on the wire at once). */
const MAX_MESSAGE_BYTES = 1024 * 1024 * 1024;
const DEFAULT_PAGE_ROWS = 500;

export interface PgConnectOptions {
    host: string;
    port: number;
    user: string;
    password?: string;
    database?: string;
    applicationName?: string;
    tls: TlsConfig;
    connectTimeoutMs: number;
}

export interface PgColumn {
    name: string;
    typeOid: number;
    /** `typmod`: the length of a varchar or the precision of a numeric, -1 when none. */
    modifier: number;
    tableOid: number;
}

export interface PgNotice {
    severity: string;
    message: string;
    code?: string;
}

export type PgEvent =
    | { kind: 'columns'; columns: PgColumn[] }
    | { kind: 'rows'; rows: DbValue[][] }
    /** One statement finished. `tag` is the server's command tag: `SELECT 5`, `INSERT 0 1`… */
    | { kind: 'end'; tag: string; rowCount?: number; affectedRows?: number }
    | { kind: 'notice'; notice: PgNotice };

/** The fields of an `ErrorResponse` or `NoticeResponse`. */
const parseFields = (body: Buffer): Record<string, string> => {
    const fields: Record<string, string> = {};
    let i = 0;
    while (i < body.length && body[i] !== 0) {
        const code = String.fromCharCode(body[i]!);
        const end = body.indexOf(0, i + 1);
        if (end < 0) break;
        fields[code] = body.toString('utf8', i + 1, end);
        i = end + 1;
    }
    return fields;
};

/** Turns an `ErrorResponse` into the application's error. */
export const serverError = (fields: Record<string, string>): DbError => {
    const state = fields.C ?? '';
    let message = fields.M ?? 'The server reported an error.';
    if (fields.D) message += `\n${fields.D}`;
    if (fields.H) message += `\nHint: ${fields.H}`;
    if (fields.P) message += ` (at position ${fields.P})`;
    const server = { state, number: undefined };
    if (state === '28P01' || state === '28000')
        return new DbError('AUTH_FAILED', message, { server });
    if (state === '42501') return new DbError('PERMISSION_DENIED', message, { server });
    if (state === '57014') return new DbError('CANCELLED', message, { server });
    if (state.startsWith('57P') || state.startsWith('08'))
        return new DbError('CONNECTION_FAILED', message, { server });
    if (state === '23505') return new DbError('CONFLICT', message, { server });
    return new DbError('QUERY_FAILED', message, { server });
};

const cstring = (text: string): Buffer =>
    Buffer.concat([Buffer.from(text, 'utf8'), Buffer.from([0])]);

const message = (type: string, body: Buffer): Buffer => {
    const out = Buffer.alloc(5 + body.length);
    out[0] = type.charCodeAt(0);
    out.writeInt32BE(4 + body.length, 1);
    body.copy(out, 5);
    return out;
};

/** The tag of a finished statement: the number of rows, where it has one. */
export const parseTag = (tag: string): { rowCount?: number; affectedRows?: number } => {
    const match = /^(SELECT|INSERT|UPDATE|DELETE|MERGE|MOVE|FETCH|COPY)(?: \d+)? (\d+)$/.exec(tag);
    if (!match) return {};
    const n = Number(match[2]);
    return match[1] === 'SELECT' || match[1] === 'FETCH' || match[1] === 'MOVE'
        ? { rowCount: n }
        : { affectedRows: n };
};

/** Encrypts the connection if the server agrees, as the TLS mode asks. */
const negotiateTls = async (pump: SocketPump, options: PgConnectOptions): Promise<void> => {
    const mode = options.tls.mode;
    if (mode === 'disable') return;
    const request = Buffer.alloc(8);
    request.writeInt32BE(8, 0);
    request.writeInt32BE(SSL_REQUEST, 4);
    pump.write(request);
    const answer = (await pump.read(1))[0];
    if (answer === 0x53) {
        await pump.upgradeTls(options);
    } else if (answer === 0x4e) {
        if (mode !== 'prefer') {
            throw new DbError(
                'CONNECTION_FAILED',
                'The server does not support encrypted connections, which this connection requires.',
            );
        }
    } else {
        throw new DbError(
            'CONNECTION_FAILED',
            'The server answered the encryption request with something unexpected.',
        );
    }
};

/**
 * One connection to a PostgreSQL server, speaking the version 3 protocol with the simple query
 * flow: text in, text out. Results are read as the consumer asks for them, one message at a time,
 * so a slow reader pauses the socket and the server waits.
 */
export class PgConnection {
    private pump!: SocketPump;
    private busy = false;
    readonly parameters = new Map<string, string>();
    backendPid = 0;
    private secretKey = Buffer.alloc(0);
    /** `I` idle, `T` in a transaction, `E` in a failed transaction. */
    transactionStatus: 'I' | 'T' | 'E' = 'I';
    private options!: PgConnectOptions;

    private constructor() {}

    static async connect(options: PgConnectOptions, signal?: AbortSignal): Promise<PgConnection> {
        const connection = new PgConnection();
        connection.options = options;
        connection.pump = await SocketPump.open(options, { signal });
        try {
            await negotiateTls(connection.pump, options);
            await connection.startup(options);
        } catch (error) {
            connection.destroy();
            throw error;
        }
        return connection;
    }

    get secure(): boolean {
        return this.pump.secure;
    }

    get closed(): boolean {
        return this.pump.closed;
    }

    get serverVersion(): string {
        return this.parameters.get('server_version') ?? '';
    }

    private async read(): Promise<{ type: string; body: Buffer }> {
        const head = await this.pump.read(5);
        const length = head.readInt32BE(1);
        if (length < 4 || length - 4 > MAX_MESSAGE_BYTES) {
            throw new DbError(
                'CONNECTION_FAILED',
                'The server sent a message of an impossible size.',
            );
        }
        const body = length > 4 ? await this.pump.read(length - 4) : Buffer.alloc(0);
        return { type: String.fromCharCode(head[0]!), body };
    }

    /** Whether the next whole message is already buffered, so reading it will not wait. */
    private nextIsBuffered(): boolean {
        const buffered = this.pump.buffered;
        return buffered.length >= 5 && buffered.length >= buffered.readInt32BE(1) + 1;
    }

    private async startup(options: PgConnectOptions): Promise<void> {
        const parameters: [string, string][] = [
            ['user', options.user],
            ['database', options.database || options.user],
            ['application_name', options.applicationName ?? 'HttpReq'],
            ['client_encoding', 'UTF8'],
            ['DateStyle', 'ISO, MDY'],
        ];
        const body = Buffer.concat([
            Buffer.from([0, 3, 0, 0]),
            ...parameters.flatMap(([key, value]) => [cstring(key), cstring(value)]),
            Buffer.from([0]),
        ]);
        const packet = Buffer.alloc(4 + body.length);
        packet.writeInt32BE(packet.length, 0);
        body.copy(packet, 4);
        // The version number is written by the first four bytes of `body`: 3.0 is 0x00030000.
        packet.writeInt32BE(PROTOCOL_VERSION, 4);
        this.pump.write(packet);
        await this.authenticate(options);
        // Parameter statuses, the key for cancelling, then ReadyForQuery.
        for (;;) {
            const { type, body: data } = await this.read();
            if (type === 'S') this.setParameter(data);
            else if (type === 'K') {
                this.backendPid = data.readInt32BE(0);
                this.secretKey = Buffer.from(data.subarray(4));
            } else if (type === 'Z') {
                this.transactionStatus = String.fromCharCode(data[0]!) as 'I' | 'T' | 'E';
                return;
            } else if (type === 'E') throw serverError(parseFields(data));
            // Notices at login are ignored.
        }
    }

    private setParameter(body: Buffer): void {
        const keyEnd = body.indexOf(0);
        const valueEnd = body.indexOf(0, keyEnd + 1);
        if (keyEnd < 0 || valueEnd < 0) return;
        this.parameters.set(
            body.toString('utf8', 0, keyEnd),
            body.toString('utf8', keyEnd + 1, valueEnd),
        );
    }

    private async authenticate(options: PgConnectOptions): Promise<void> {
        const password = options.password ?? '';
        let scram: ReturnType<typeof scramSha256> | null = null;
        for (;;) {
            const { type, body } = await this.read();
            if (type === 'E') throw serverError(parseFields(body));
            if (type !== 'R')
                throw new DbError(
                    'CONNECTION_FAILED',
                    'The server answered the login with something unexpected.',
                );
            const code = body.readInt32BE(0);
            switch (code) {
                case 0:
                    return;
                case 3:
                    this.pump.write(message('p', cstring(password)));
                    break;
                case 5:
                    this.pump.write(
                        message(
                            'p',
                            cstring(md5Password(options.user, password, body.subarray(4, 8))),
                        ),
                    );
                    break;
                case 10: {
                    const mechanisms = body.toString('utf8', 4).split('\0').filter(Boolean);
                    if (!mechanisms.includes('SCRAM-SHA-256')) {
                        throw new DbError(
                            'AUTH_FAILED',
                            `The server offers only ${mechanisms.join(', ')}, which this client does not support.`,
                        );
                    }
                    scram = scramSha256(password);
                    const first = scram.first;
                    const length = Buffer.alloc(4);
                    length.writeInt32BE(first.length);
                    this.pump.write(
                        message('p', Buffer.concat([cstring('SCRAM-SHA-256'), length, first])),
                    );
                    break;
                }
                case 11: {
                    if (!scram)
                        throw new DbError(
                            'AUTH_FAILED',
                            'The server continued a login it had not started.',
                        );
                    this.pump.write(message('p', await scram.final(body.subarray(4))));
                    break;
                }
                case 12:
                    if (!scram)
                        throw new DbError(
                            'AUTH_FAILED',
                            'The server finished a login it had not started.',
                        );
                    scram.verify(body.subarray(4));
                    break;
                default:
                    throw new DbError(
                        'AUTH_FAILED',
                        `The server asked for a login method this client does not support (${code}).`,
                    );
            }
        }
    }

    /** Runs SQL (one statement or several) and returns its events as they are read. */
    query(sql: string, options: { pageRows?: number } = {}): PgQuery {
        if (this.pump.closed) throw new DbError('CONNECTION_FAILED', 'The connection is closed.');
        if (this.busy)
            throw new DbError('INTERNAL', 'The connection is busy with another statement.');
        if (sql.includes('\0'))
            throw new DbError('INVALID_REQUEST', 'A statement cannot contain a null character.');
        this.busy = true;
        return new PgQuery(this, sql, options.pageRows ?? DEFAULT_PAGE_ROWS, () => {
            this.busy = false;
        });
    }

    /** @internal Used by `PgQuery`. */
    readMessage(): Promise<{ type: string; body: Buffer }> {
        return this.read();
    }

    /** @internal */
    nextMessageBuffered(): boolean {
        return this.nextIsBuffered();
    }

    /** @internal */
    send(type: string, body: Buffer): void {
        this.pump.write(message(type, body));
    }

    /** @internal */
    finishQuery(status: string): void {
        this.transactionStatus = status as 'I' | 'T' | 'E';
    }

    /** @internal */
    noteParameter(body: Buffer): void {
        this.setParameter(body);
    }

    /** Asks the server to stop whatever this connection is running, over a second connection. */
    async cancel(): Promise<void> {
        const pump = await SocketPump.open(this.options);
        try {
            await negotiateTls(pump, this.options);
            const packet = Buffer.alloc(12 + this.secretKey.length);
            packet.writeInt32BE(packet.length, 0);
            packet.writeInt32BE(CANCEL_REQUEST, 4);
            packet.writeInt32BE(this.backendPid, 8);
            this.secretKey.copy(packet, 12);
            pump.write(packet);
            // The server closes the connection once it has acted on the request.
            await pump.read(1).catch(() => undefined);
        } finally {
            pump.destroy();
        }
    }

    async ping(): Promise<void> {
        for await (const event of this.query('SELECT 1')) void event;
    }

    async close(): Promise<void> {
        if (!this.pump.closed && !this.busy) {
            try {
                this.pump.write(message('X', Buffer.alloc(0)));
            } catch {
                // Already gone.
            }
        }
        this.destroy();
    }

    destroy(): void {
        this.pump?.destroy();
    }
}

/** A statement in flight. */
export class PgQuery implements AsyncIterable<PgEvent> {
    private started = false;

    constructor(
        private readonly connection: PgConnection,
        private readonly sql: string,
        private readonly pageRows: number,
        private readonly release: () => void,
    ) {}

    [Symbol.asyncIterator](): AsyncIterator<PgEvent> {
        if (this.started) throw new DbError('INTERNAL', 'A statement can only be read once.');
        this.started = true;
        return this.events();
    }

    private async *events(): AsyncGenerator<PgEvent> {
        const connection = this.connection;
        let finished = false;
        try {
            connection.send('Q', cstring(this.sql));
            let columns: PgColumn[] | null = null;
            let page: DbValue[][] = [];
            let failure: DbError | null = null;
            let copyRefused = false;
            const flush = function* (): Generator<PgEvent> {
                if (page.length > 0) {
                    const rows = page;
                    page = [];
                    yield { kind: 'rows', rows };
                }
            };
            for (;;) {
                const { type, body } = await connection.readMessage();
                switch (type) {
                    case 'T': {
                        yield* flush();
                        columns = parseRowDescription(body);
                        yield { kind: 'columns', columns };
                        break;
                    }
                    case 'D': {
                        if (!columns)
                            throw new DbError(
                                'CONNECTION_FAILED',
                                'The server sent a row without saying what its columns are.',
                            );
                        page.push(parseDataRow(body, columns));
                        if (page.length >= this.pageRows || !connection.nextMessageBuffered())
                            yield* flush();
                        break;
                    }
                    case 'C': {
                        yield* flush();
                        const tag = body.toString('utf8', 0, body.length - 1);
                        columns = null;
                        yield { kind: 'end', tag, ...parseTag(tag) };
                        break;
                    }
                    case 'I':
                        yield { kind: 'end', tag: '' };
                        break;
                    case 'E':
                        failure ??= serverError(parseFields(body));
                        columns = null;
                        page = [];
                        break;
                    case 'N': {
                        const fields = parseFields(body);
                        yield {
                            kind: 'notice',
                            notice: {
                                severity: fields.S ?? 'NOTICE',
                                message: fields.M ?? '',
                                ...(fields.C ? { code: fields.C } : {}),
                            },
                        };
                        break;
                    }
                    case 'S':
                        connection.noteParameter(body);
                        break;
                    case 'G':
                        // The server wants data for COPY ... FROM STDIN, which this client cannot give.
                        copyRefused = true;
                        connection.send('f', cstring('COPY FROM STDIN is not supported here'));
                        break;
                    case 'H':
                        copyRefused = true;
                        break;
                    case 'W':
                        throw new DbError(
                            'UNSUPPORTED',
                            'Replication connections are not supported.',
                        );
                    case 'd':
                    case 'c':
                    case 'A':
                        break;
                    case 'Z':
                        connection.finishQuery(String.fromCharCode(body[0]!));
                        finished = true;
                        if (failure) throw failure;
                        if (copyRefused)
                            throw new DbError(
                                'UNSUPPORTED',
                                'COPY to and from the client is not supported; use a query instead.',
                            );
                        return;
                    default:
                        // Messages this client does not use (parameter descriptions, notifications) are skipped.
                        break;
                }
            }
        } finally {
            if (!finished) await this.abandon();
            this.release();
        }
    }

    /**
     * The consumer stopped before the statement finished. The server is still sending, so ask it to
     * stop and read what is left until it is ready again; when that does not work, drop the
     * connection rather than leave it out of step.
     */
    private async abandon(): Promise<void> {
        const connection = this.connection;
        if (connection.closed) return;
        const drain = (async () => {
            await connection.cancel().catch(() => undefined);
            for (;;) {
                const { type, body } = await connection.readMessage();
                if (type === 'G') connection.send('f', cstring('cancelled'));
                if (type === 'Z') {
                    connection.finishQuery(String.fromCharCode(body[0]!));
                    return;
                }
            }
        })();
        const timeout = new Promise<'timeout'>((resolve) =>
            setTimeout(() => resolve('timeout'), 5000).unref(),
        );
        const outcome = await Promise.race([
            drain.then(
                () => 'drained' as const,
                () => 'failed' as const,
            ),
            timeout,
        ]);
        if (outcome !== 'drained') connection.destroy();
    }
}

const parseRowDescription = (body: Buffer): PgColumn[] => {
    const count = body.readInt16BE(0);
    const columns: PgColumn[] = [];
    let offset = 2;
    for (let i = 0; i < count; i++) {
        const end = body.indexOf(0, offset);
        if (end < 0 || end + 19 > body.length)
            throw new DbError(
                'CONNECTION_FAILED',
                'The server sent a malformed column description.',
            );
        columns.push({
            name: body.toString('utf8', offset, end),
            tableOid: body.readUInt32BE(end + 1),
            typeOid: body.readUInt32BE(end + 7),
            modifier: body.readInt32BE(end + 13),
        });
        offset = end + 19;
    }
    return columns;
};

const parseDataRow = (body: Buffer, columns: PgColumn[]): DbValue[] => {
    const count = body.readInt16BE(0);
    if (count !== columns.length)
        throw new DbError(
            'CONNECTION_FAILED',
            'The server sent a row with the wrong number of columns.',
        );
    const row: DbValue[] = new Array<DbValue>(count);
    let offset = 2;
    for (let i = 0; i < count; i++) {
        const length = body.readInt32BE(offset);
        offset += 4;
        if (length < 0) {
            row[i] = null;
            continue;
        }
        if (offset + length > body.length)
            throw new DbError(
                'CONNECTION_FAILED',
                'The server sent a value that runs past its row.',
            );
        row[i] = decodeText(columns[i]!.typeOid, body.toString('utf8', offset, offset + length));
        offset += length;
    }
    return row;
};
