/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { createConnection, isIP, type Socket } from 'node:net';
import { connect as connectTls, type TLSSocket } from 'node:tls';
import { DbError, type TlsConfig } from '@httpreq/db-core';

/** Bytes buffered before the socket is paused, so a slow reader slows the server down. */
const HIGH_WATER_BYTES = 1024 * 1024;

export interface SocketTarget {
    host: string;
    port: number;
    tls: TlsConfig;
    connectTimeoutMs: number;
}

const tlsOptions = (target: SocketTarget) => {
    const { tls, host } = target;
    const verify = tls.mode === 'verify-ca' || tls.mode === 'verify-full';
    return {
        servername: tls.serverName ?? (isIP(host) ? undefined : host),
        rejectUnauthorized: verify,
        // verify-ca checks the chain but not the name; verify-full checks both.
        ...(tls.mode === 'verify-ca' ? { checkServerIdentity: () => undefined } : {}),
        ...(tls.ca ? { ca: tls.ca } : {}),
        ...(tls.cert ? { cert: tls.cert } : {}),
        ...(tls.key ? { key: tls.key } : {}),
        minVersion: 'TLSv1.2' as const,
    };
};

const describe = (error: unknown): string =>
    (error as NodeJS.ErrnoException).code ?? (error as Error).message ?? 'unknown error';

/**
 * A socket read through a buffer the protocol parsers consume from. It is pull-based: nothing is
 * parsed until a parser asks for bytes, and while the buffer is above its high-water mark the
 * socket is paused, so the operating system's receive window fills and the server waits. That is
 * the whole back-pressure story for the Redis, MongoDB and PostgreSQL drivers.
 */
export class SocketPump {
    private chunks: Buffer = Buffer.alloc(0);
    private socket!: Socket | TLSSocket;
    private waiter: { need: number; resolve: () => void; reject: (error: unknown) => void } | null =
        null;
    private paused = false;
    private failure: DbError | null = null;
    private ended = false;

    /** Whether the connection is encrypted. */
    secure = false;

    private constructor() {}

    /**
     * Connects. With `tlsFromStart` the connection is encrypted straight away (Redis and MongoDB);
     * without it the caller may call `upgradeTls` later (PostgreSQL's `SSLRequest`).
     */
    static async open(
        target: SocketTarget,
        options: { tlsFromStart?: boolean; signal?: AbortSignal } = {},
    ): Promise<SocketPump> {
        const pump = new SocketPump();
        const { signal } = options;
        if (signal?.aborted) throw new DbError('CANCELLED', 'The connection was cancelled.');
        const socket = await new Promise<Socket | TLSSocket>((resolve, reject) => {
            const fail = (error: unknown) => {
                clearTimeout(timer);
                signal?.removeEventListener('abort', onAbort);
                raw?.destroy();
                reject(
                    error instanceof DbError
                        ? error
                        : new DbError(
                              'CONNECTION_FAILED',
                              `Could not connect to ${target.host}:${target.port} (${describe(error)}).`,
                              { cause: error },
                          ),
                );
            };
            const onAbort = () => fail(new DbError('CANCELLED', 'The connection was cancelled.'));
            const timer = setTimeout(
                () =>
                    fail(
                        new DbError(
                            'CONNECTION_FAILED',
                            `Timed out connecting to ${target.host}:${target.port}.`,
                        ),
                    ),
                target.connectTimeoutMs,
            );
            signal?.addEventListener('abort', onAbort, { once: true });
            const done = (value: Socket | TLSSocket) => {
                clearTimeout(timer);
                signal?.removeEventListener('abort', onAbort);
                value.removeListener('error', fail);
                resolve(value);
            };
            let raw: Socket | undefined;
            if (options.tlsFromStart) {
                const secure = connectTls({
                    host: target.host,
                    port: target.port,
                    ...tlsOptions(target),
                });
                raw = secure;
                secure.once('secureConnect', () => done(secure));
                secure.once('error', fail);
            } else {
                raw = createConnection({ host: target.host, port: target.port });
                raw.once('connect', () => done(raw!));
                raw.once('error', fail);
            }
        });
        pump.attach(socket);
        pump.secure = !!options.tlsFromStart;
        return pump;
    }

    /** Encrypts the connection in place, after a protocol-level negotiation. */
    async upgradeTls(target: SocketTarget): Promise<void> {
        const raw = this.socket as Socket;
        raw.removeAllListeners('data');
        raw.removeAllListeners('error');
        raw.removeAllListeners('close');
        const secure = await new Promise<TLSSocket>((resolve, reject) => {
            const upgraded = connectTls({ socket: raw, ...tlsOptions(target) });
            upgraded.once('secureConnect', () => resolve(upgraded));
            upgraded.once('error', (error) =>
                reject(
                    new DbError('CONNECTION_FAILED', `TLS failed: ${describe(error)}`, {
                        cause: error,
                    }),
                ),
            );
        });
        this.attach(secure);
        this.secure = true;
    }

    private attach(socket: Socket | TLSSocket): void {
        this.socket = socket;
        socket.setNoDelay(true);
        socket.on('data', (chunk: Buffer) => {
            this.chunks = this.chunks.length === 0 ? chunk : Buffer.concat([this.chunks, chunk]);
            if (this.waiter && this.chunks.length >= this.waiter.need) {
                const { resolve } = this.waiter;
                this.waiter = null;
                resolve();
            }
            if (!this.waiter && !this.paused && this.chunks.length >= HIGH_WATER_BYTES) {
                this.paused = true;
                socket.pause();
            }
        });
        socket.on('error', (error) =>
            this.fail(
                new DbError('CONNECTION_FAILED', `The connection failed (${describe(error)}).`, {
                    cause: error,
                }),
            ),
        );
        socket.on('close', () =>
            this.fail(new DbError('CONNECTION_FAILED', 'The server closed the connection.')),
        );
    }

    private fail(error: DbError): void {
        this.failure ??= error;
        this.ended = true;
        if (this.waiter) {
            const { reject } = this.waiter;
            this.waiter = null;
            reject(this.failure);
        }
    }

    get closed(): boolean {
        return this.ended;
    }

    /** What has been received and not yet consumed. Valid until the next `consume` or `fill`. */
    get buffered(): Buffer {
        return this.chunks;
    }

    /** Waits until at least `size` bytes are buffered. */
    async fill(size: number): Promise<void> {
        while (this.chunks.length < size) {
            if (this.failure) throw this.failure;
            if (this.waiter) throw new DbError('INTERNAL', 'Two reads are waiting on one socket.');
            await new Promise<void>((resolve, reject) => {
                this.waiter = { need: size, resolve, reject };
                if (this.paused) {
                    this.paused = false;
                    this.socket.resume();
                }
            });
        }
    }

    /** Removes and returns the first `size` buffered bytes. */
    consume(size: number): Buffer {
        const head = this.chunks.subarray(0, size);
        this.chunks = this.chunks.subarray(size);
        if (this.paused && this.chunks.length < HIGH_WATER_BYTES / 2) {
            this.paused = false;
            this.socket.resume();
        }
        return head;
    }

    /** Reads exactly `size` bytes. */
    async read(size: number): Promise<Buffer> {
        await this.fill(size);
        // A copy: the buffer may be a view into a chunk that is released as reading continues.
        return Buffer.from(this.consume(size));
    }

    write(data: Buffer | Uint8Array): void {
        if (this.ended)
            throw this.failure ?? new DbError('CONNECTION_FAILED', 'The connection is closed.');
        this.socket.write(data);
    }

    /** Closes the connection; reads that are waiting fail. */
    destroy(): void {
        this.fail(new DbError('CONNECTION_FAILED', 'The connection was closed.'));
        this.socket?.destroy();
    }

    /** Pauses delivery without a reader waiting, for a consumer that has stopped iterating. */
    pause(): void {
        if (!this.paused && !this.ended) {
            this.paused = true;
            this.socket.pause();
        }
    }
}
