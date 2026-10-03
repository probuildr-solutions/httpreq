/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { DbError, type DbValue, type TlsConfig } from '@httpreq/db-core';
import { SocketPump } from '@httpreq/streaming-engine';
import { decodeDocument, encodeDocument, type BsonDocument } from './bson';
import { scramStart, type ScramMechanism } from './scram';

const OP_MSG = 2013;
const HEADER_BYTES = 16;
/** Larger than the server's own 48 MB message limit; anything bigger is a protocol error. */
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
const CHECKSUM_PRESENT = 1;

export interface MongoConnectOptions {
    host: string;
    port: number;
    username?: string;
    password?: string;
    /** Where the user is defined; `admin` unless told otherwise. */
    authSource?: string;
    /** Forces `SCRAM-SHA-1` or `SCRAM-SHA-256`; by default the server's preference is used. */
    authMechanism?: string;
    appName?: string;
    tls: TlsConfig;
    connectTimeoutMs: number;
}

/** What the server said about itself. */
export interface MongoServerHello {
    version: string;
    maxWireVersion: number;
    maxBsonObjectSize: number;
    maxMessageSizeBytes: number;
    /** The replica set name, when the server belongs to one. */
    setName?: string;
    /** Whether this member accepts writes (a primary or a standalone). */
    writable: boolean;
    /** `mongos` for a router, `mongod` otherwise. */
    process: string;
}

/** Turns a server error document into the application's error. */
export const serverError = (reply: BsonDocument): DbError => {
    const code = typeof reply.code === 'number' ? reply.code : undefined;
    const name = typeof reply.codeName === 'string' ? reply.codeName : '';
    const message =
        typeof reply.errmsg === 'string' ? reply.errmsg : 'The server reported an error.';
    const server = { number: code, state: name || undefined };
    if (code === 18 || name === 'AuthenticationFailed')
        return new DbError('AUTH_FAILED', message, { server });
    if (code === 13 || name === 'Unauthorized')
        return new DbError('PERMISSION_DENIED', message, { server });
    if (code === 50 || name === 'MaxTimeMSExpired') {
        return new DbError(
            'TIMEOUT',
            'The operation ran longer than the time limit and was stopped.',
            { server },
        );
    }
    if (
        [11601, 11600, 237, 43].includes(code ?? 0) ||
        ['Interrupted', 'CursorKilled', 'CursorNotFound'].includes(name)
    ) {
        return new DbError('CANCELLED', 'The operation was cancelled.', { server });
    }
    return new DbError('QUERY_FAILED', name ? `${message} (${name})` : message, { server });
};

/**
 * One connection to a MongoDB server (a standalone, a replica set member or a router). Commands are
 * `OP_MSG` messages; the connection runs one at a time. Everything above this (queries, cursors,
 * transactions) is a command or a sequence of them, so this file knows nothing of collections.
 */
export class MongoConnection {
    private pump!: SocketPump;
    private requestId = 1;
    private busy = false;
    hello: MongoServerHello = {
        version: '',
        maxWireVersion: 0,
        maxBsonObjectSize: 16 * 1024 * 1024,
        maxMessageSizeBytes: 48_000_000,
        writable: true,
        process: 'mongod',
    };
    /** The user the server authenticated, when a login was made. */
    authenticatedUser?: string;

    private constructor() {}

    static async connect(
        options: MongoConnectOptions,
        signal?: AbortSignal,
    ): Promise<MongoConnection> {
        const connection = new MongoConnection();
        const tlsFromStart = options.tls.mode !== 'disable' && options.tls.mode !== 'prefer';
        connection.pump = await SocketPump.open(options, { tlsFromStart, signal });
        try {
            await connection.handshake(options);
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

    private async handshake(options: MongoConnectOptions): Promise<void> {
        const authSource = options.authSource || 'admin';
        const forced = options.authMechanism?.toUpperCase();
        if (forced && forced !== 'SCRAM-SHA-1' && forced !== 'SCRAM-SHA-256') {
            throw new DbError(
                'INVALID_REQUEST',
                `The login method “${options.authMechanism}” is not supported (use SCRAM-SHA-256 or SCRAM-SHA-1).`,
            );
        }
        const hello = await this.command('admin', {
            hello: 1,
            helloOk: true,
            client: {
                driver: { name: 'httpreq-database-studio', version: '1' },
                os: {
                    type:
                        process.platform === 'win32'
                            ? 'Windows'
                            : process.platform === 'darwin'
                              ? 'Darwin'
                              : 'Linux',
                },
                application: { name: options.appName ?? 'HttpReq' },
            },
            ...(options.username
                ? { saslSupportedMechs: `${authSource}.${options.username}` }
                : {}),
        });
        this.hello = {
            version: '',
            maxWireVersion: Number(hello.maxWireVersion ?? 0),
            maxBsonObjectSize: Number(hello.maxBsonObjectSize ?? 16 * 1024 * 1024),
            maxMessageSizeBytes: Number(hello.maxMessageSizeBytes ?? 48_000_000),
            setName: typeof hello.setName === 'string' ? hello.setName : undefined,
            writable: hello.isWritablePrimary === true || hello.ismaster === true,
            process: hello.msg === 'isdbgrid' ? 'mongos' : 'mongod',
        };
        if (this.hello.maxWireVersion < 6) {
            throw new DbError(
                'UNSUPPORTED',
                'This MongoDB server is older than 3.6, which this client does not support.',
            );
        }
        if (options.username) {
            const offered = Array.isArray(hello.saslSupportedMechs)
                ? (hello.saslSupportedMechs as string[])
                : [];
            const mechanism = (forced ??
                (offered.includes('SCRAM-SHA-256')
                    ? 'SCRAM-SHA-256'
                    : 'SCRAM-SHA-1')) as ScramMechanism;
            await this.authenticate(
                authSource,
                options.username,
                options.password ?? '',
                mechanism,
            );
            this.authenticatedUser = options.username;
        }
        try {
            const build = await this.command('admin', { buildInfo: 1 });
            this.hello.version = String(build.version ?? '');
        } catch {
            // A user who may not run buildInfo still gets a working connection.
        }
    }

    private async authenticate(
        db: string,
        user: string,
        password: string,
        mechanism: ScramMechanism,
    ): Promise<void> {
        const scram = scramStart(mechanism, user, password);
        const first = await this.command(db, {
            saslStart: 1,
            mechanism,
            payload: scram.payload,
            options: { skipEmptyExchange: true },
        });
        const secondPayload = await scram.next(payloadOf(first));
        const second = await this.command(db, {
            saslContinue: 1,
            conversationId: first.conversationId as number,
            payload: secondPayload,
        });
        scram.finish(payloadOf(second));
        let reply = second;
        // Servers that do not honour `skipEmptyExchange` want one more, empty, round.
        while (reply.done !== true) {
            reply = await this.command(db, {
                saslContinue: 1,
                conversationId: first.conversationId as number,
                payload: Buffer.alloc(0),
            });
        }
    }

    /** Runs a command on a database and returns the reply document, or throws the server's error. */
    async command(db: string, command: BsonDocument): Promise<BsonDocument> {
        const reply = await this.send(db, command);
        if (reply.ok !== 1 && reply.ok !== true && reply.ok !== 1.0) throw serverError(reply);
        return reply;
    }

    /** Like `command`, but returns a failure reply instead of throwing it. */
    async send(db: string, command: BsonDocument): Promise<BsonDocument> {
        if (this.pump.closed) throw new DbError('CONNECTION_FAILED', 'The connection is closed.');
        if (this.busy)
            throw new DbError('INTERNAL', 'The connection is busy with another command.');
        this.busy = true;
        try {
            const body = encodeDocument({ ...command, $db: db });
            if (body.length > this.hello.maxBsonObjectSize + 16 * 1024) {
                throw new DbError(
                    'LIMIT_EXCEEDED',
                    'The command is larger than the server accepts.',
                );
            }
            const id = this.requestId++;
            const message = Buffer.alloc(HEADER_BYTES + 4 + 1 + body.length);
            message.writeInt32LE(message.length, 0);
            message.writeInt32LE(id, 4);
            message.writeInt32LE(0, 8);
            message.writeInt32LE(OP_MSG, 12);
            message.writeUInt32LE(0, 16);
            message[20] = 0;
            body.copy(message, 21);
            this.pump.write(message);
            return await this.readReply(id);
        } finally {
            this.busy = false;
        }
    }

    private async readReply(requestId: number): Promise<BsonDocument> {
        const head = await this.pump.read(HEADER_BYTES);
        const length = head.readInt32LE(0);
        const responseTo = head.readInt32LE(8);
        const opCode = head.readInt32LE(12);
        if (length < HEADER_BYTES + 5 || length > MAX_MESSAGE_BYTES) {
            throw new DbError(
                'CONNECTION_FAILED',
                'The server sent a message of an impossible size.',
            );
        }
        const rest = await this.pump.read(length - HEADER_BYTES);
        if (opCode !== OP_MSG) {
            throw new DbError(
                'CONNECTION_FAILED',
                `The server answered with an unsupported message type (${opCode}).`,
            );
        }
        if (responseTo !== requestId) {
            throw new DbError('CONNECTION_FAILED', 'The server answered a different request.');
        }
        const flags = rest.readUInt32LE(0);
        const end = rest.length - ((flags & CHECKSUM_PRESENT) !== 0 ? 4 : 0);
        let offset = 4;
        let body: BsonDocument | null = null;
        while (offset < end) {
            const kind = rest[offset++];
            if (kind === 0) {
                const decoded = decodeDocument(rest, offset, end);
                body = decoded.value;
                offset = decoded.next;
            } else if (kind === 1) {
                // A document sequence: size, identifier, documents. Replies do not use them; skip.
                const size = rest.readInt32LE(offset);
                if (size < 4 || offset + size > end) {
                    throw new DbError(
                        'CONNECTION_FAILED',
                        'The server sent a malformed message section.',
                    );
                }
                offset += size;
            } else {
                throw new DbError(
                    'CONNECTION_FAILED',
                    'The server sent a message section of an unknown kind.',
                );
            }
        }
        if (!body)
            throw new DbError('CONNECTION_FAILED', 'The server sent a message with no body.');
        return body;
    }

    async ping(): Promise<void> {
        await this.command('admin', { ping: 1 });
    }

    async close(): Promise<void> {
        this.destroy();
    }

    destroy(): void {
        this.pump?.destroy();
    }
}

const payloadOf = (reply: BsonDocument): Buffer => {
    const payload = reply.payload as DbValue;
    if (payload instanceof Uint8Array) return Buffer.from(payload);
    throw new DbError('AUTH_FAILED', 'The server sent a login message without a payload.');
};
