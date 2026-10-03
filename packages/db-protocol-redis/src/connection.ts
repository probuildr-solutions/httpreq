/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { DbError, type TlsConfig } from '@httpreq/db-core';
import { SocketPump } from '@httpreq/streaming-engine';
import {
    encodeCommand,
    RespError,
    RespMap,
    RespReader,
    type RespHeader,
    type RespValue,
} from './resp';

export type RedisArg = string | Uint8Array | number;

export interface RedisConnectOptions {
    host: string;
    port: number;
    username?: string;
    password?: string;
    /** The logical database to select after connecting. */
    database?: number;
    tls: TlsConfig;
    connectTimeoutMs: number;
}

/** Commands that turn the connection into a stream the console cannot show. */
const UNSUPPORTED_COMMANDS = new Set([
    'SUBSCRIBE',
    'PSUBSCRIBE',
    'SSUBSCRIBE',
    'MONITOR',
    'SYNC',
    'PSYNC',
]);

/** Turns an error reply into the error the application reports. */
export const redisError = (error: RespError): DbError => {
    if (
        /^(WRONGPASS|NOAUTH)$/.test(error.code) ||
        /invalid (username-password|password)/i.test(error.message)
    ) {
        return new DbError('AUTH_FAILED', error.message);
    }
    if (error.code === 'NOPERM') return new DbError('PERMISSION_DENIED', error.message);
    return new DbError('QUERY_FAILED', error.message);
};

/** What the server said about itself in `HELLO`. */
export interface RedisServerHello {
    server: string;
    version: string;
    /** The protocol in use: 3 when the server accepted `HELLO 3`, otherwise 2. */
    protocol: 2 | 3;
    id?: number;
}

const mapGet = (value: RespValue, key: string): RespValue | undefined => {
    if (value instanceof RespMap) {
        return value.entries.find(([k]) => k === key)?.[1];
    }
    if (Array.isArray(value)) {
        for (let i = 0; i + 1 < value.length; i += 2) if (value[i] === key) return value[i + 1];
    }
    return undefined;
};

/**
 * One connection to a Redis or Valkey server. It runs one command at a time (replies come back in
 * order, so a second command would have to wait anyway); `pipeline` sends several and reads them
 * back together.
 */
export class RedisConnection {
    private reader!: RespReader;
    private pump!: SocketPump;
    private busyWith: string | null = null;
    hello: RedisServerHello = { server: 'redis', version: '', protocol: 2 };

    private constructor() {}

    static async connect(
        options: RedisConnectOptions,
        signal?: AbortSignal,
    ): Promise<RedisConnection> {
        const connection = new RedisConnection();
        const tlsFromStart = options.tls.mode !== 'disable' && options.tls.mode !== 'prefer';
        connection.pump = await SocketPump.open(options, { tlsFromStart, signal });
        connection.reader = new RespReader(connection.pump);
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

    get busy(): boolean {
        return this.busyWith !== null;
    }

    private async handshake(options: RedisConnectOptions): Promise<void> {
        const auth: RedisArg[] = options.password
            ? options.username
                ? ['AUTH', options.username, options.password]
                : ['AUTH', options.password]
            : [];
        // RESP3 first: it types replies (maps, doubles, booleans). Older servers do not know HELLO.
        // HELLO's AUTH always names a user; a password alone means the `default` user.
        const helloAuth: RedisArg[] = options.password
            ? ['AUTH', options.username || 'default', options.password]
            : [];
        this.pump.write(encodeCommand(['HELLO', '3', ...helloAuth]));
        const reply = await this.reader.readValue();
        if (reply instanceof RespError) {
            if (
                /unknown command|unknown subcommand|NOPROTO|unsupported protocol/i.test(
                    reply.message,
                )
            ) {
                await this.handshakeV2(options, auth);
            } else {
                throw redisError(reply);
            }
        } else {
            this.hello = {
                server: String(mapGet(reply, 'server') ?? 'redis'),
                version: String(mapGet(reply, 'version') ?? ''),
                protocol: Number(mapGet(reply, 'proto') ?? 3) === 3 ? 3 : 2,
                id: Number(mapGet(reply, 'id') ?? 0) || undefined,
            };
        }
        if (options.database !== undefined && options.database > 0) {
            await this.expectOk(['SELECT', options.database]);
        }
    }

    private async handshakeV2(options: RedisConnectOptions, auth: RedisArg[]): Promise<void> {
        if (auth.length > 0) await this.expectOk(auth);
        const info = await this.command(['INFO', 'server']);
        const text = typeof info === 'string' ? info : '';
        const field = (name: string) => new RegExp(`^${name}:(.*)$`, 'm').exec(text)?.[1]?.trim();
        this.hello = {
            server: field('valkey_version') ? 'valkey' : 'redis',
            version: field('valkey_version') ?? field('redis_version') ?? '',
            protocol: 2,
        };
    }

    private async expectOk(args: RedisArg[]): Promise<void> {
        const reply = await this.command(args);
        if (reply instanceof RespError) throw redisError(reply);
    }

    /** Sends a command and reads its whole reply. An error reply is returned, not thrown. */
    async command(args: RedisArg[]): Promise<RespValue> {
        this.begin(args);
        try {
            this.pump.write(encodeCommand(args));
            return await this.reader.readValue();
        } finally {
            this.busyWith = null;
        }
    }

    /** Sends several commands at once and reads their replies, in order. */
    async pipeline(commands: RedisArg[][]): Promise<RespValue[]> {
        this.begin(commands[0] ?? []);
        try {
            this.pump.write(Buffer.concat(commands.map((args) => encodeCommand(args))));
            const replies: RespValue[] = [];
            for (let i = 0; i < commands.length; i++) replies.push(await this.reader.readValue());
            return replies;
        } finally {
            this.busyWith = null;
        }
    }

    /**
     * Sends a command and returns a handle on its reply, for the caller to read the header and then
     * an aggregate's elements one at a time. The connection stays busy until `done` is called.
     */
    open(args: RedisArg[]): RedisReplyStream {
        this.begin(args);
        this.pump.write(encodeCommand(args));
        return new RedisReplyStream(this.reader, () => {
            this.busyWith = null;
        });
    }

    private begin(args: RedisArg[]): void {
        if (this.pump.closed) throw new DbError('CONNECTION_FAILED', 'The connection is closed.');
        if (this.busyWith !== null) {
            throw new DbError('INTERNAL', 'The connection is busy with another command.');
        }
        const name = typeof args[0] === 'string' ? args[0].toUpperCase() : '';
        if (UNSUPPORTED_COMMANDS.has(name)) {
            throw new DbError(
                'UNSUPPORTED',
                `${name} turns the connection into a stream, which the console cannot show.`,
            );
        }
        this.busyWith = name || 'COMMAND';
    }

    async ping(): Promise<void> {
        const reply = await this.command(['PING']);
        if (reply instanceof RespError) throw redisError(reply);
    }

    async close(): Promise<void> {
        if (!this.pump.closed && this.busyWith === null) {
            try {
                this.pump.write(encodeCommand(['QUIT']));
            } catch {
                // Already gone.
            }
        }
        this.destroy();
    }

    destroy(): void {
        this.pump.destroy();
    }
}

/** The reply to one command, read piece by piece. */
export class RedisReplyStream {
    private finished = false;

    constructor(
        private readonly reader: RespReader,
        private readonly release: () => void,
    ) {}

    header(): Promise<RespHeader> {
        return this.reader.readHeader();
    }

    /** One element of the aggregate whose header was read, or a whole reply. */
    value(): Promise<RespValue> {
        return this.reader.readValue();
    }

    /** Marks the reply as read, freeing the connection for the next command. */
    done(): void {
        if (this.finished) return;
        this.finished = true;
        this.release();
    }
}
