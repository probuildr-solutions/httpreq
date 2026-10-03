/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { randomBytes } from 'node:crypto';
import { open, rename, rm, stat, statfs, type FileHandle } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { DbError, throwIfAborted } from '@httpreq/db-core';
import { assertSafeLocalPath } from './pathPolicy';

/**
 * Turns the ways a write fails into messages a person can act on, naming no path. Used for every
 * write the exports make, so a full disk, a missing folder or a refused write each read the same
 * wherever they happen.
 */
export const describeWriteError = (error: unknown): DbError => {
    if (error instanceof DbError) return error;
    const code = (error as NodeJS.ErrnoException | null)?.code;
    switch (code) {
        case 'ENOSPC':
            return new DbError('IO_ERROR', 'The disk is full. Free some space and try again.', {
                cause: error,
            });
        case 'EDQUOT':
            return new DbError(
                'IO_ERROR',
                'Your disk quota is used up. Free some space and try again.',
                { cause: error },
            );
        case 'EACCES':
        case 'EPERM':
            return new DbError(
                'PERMISSION_DENIED',
                'Permission denied: the destination cannot be written. Choose another folder.',
                { cause: error },
            );
        case 'EROFS':
            return new DbError('PERMISSION_DENIED', 'The destination is on a read-only disk.', {
                cause: error,
            });
        case 'ENOENT':
        case 'ENOTDIR':
            return new DbError('NOT_FOUND', 'The destination folder is no longer available.', {
                cause: error,
            });
        case 'EBUSY':
            return new DbError('IO_ERROR', 'The destination file is in use by another program.', {
                cause: error,
            });
        default:
            return new DbError(
                'IO_ERROR',
                `The file could not be written${code ? ` (${code})` : ''}.`,
                { cause: error },
            );
    }
};

/** Free bytes for the current user on the disk that holds `directory`, or null if it cannot be read. */
export const freeSpace = async (directory: string): Promise<number | null> => {
    try {
        const info = await statfs(directory);
        return Number(info.bavail) * Number(info.bsize);
    } catch {
        return null;
    }
};

const MIB = 1024 * 1024;
/** Space that must remain free after the file, so the machine is not left with a full disk. */
const RESERVE_BYTES = 64 * MIB;
/** The free space is looked at again after this many bytes of a long write. */
const RECHECK_BYTES = 256 * MIB;

export interface SinkOptions {
    signal?: AbortSignal;
    /** Bytes buffered before they are written; memory use is about this much. */
    highWaterBytes?: number;
    /** What the file is expected to need, for the free-space check before anything is written. */
    estimatedBytes?: number;
    /** Reserve to keep free; tests lower it. */
    reserveBytes?: number;
}

/**
 * A file written as a stream: the writer waits for each write to reach the file before it accepts
 * more (backpressure), only `highWaterBytes` are ever buffered, and the data goes to a temporary
 * file beside the destination that replaces it only on `commit()`. A cancelled, failed or crashed
 * export therefore leaves no half-written destination, and any file that was there stays whole.
 *
 * Before writing it checks the destination folder and the free space, so "disk nearly full",
 * "no permission" and "folder gone" fail at the start with a plain message instead of after an hour.
 */
export class FileSink {
    private chunks: Buffer[] = [];
    private buffered = 0;
    private written = 0;
    private sinceCheck = 0;
    private closed = false;

    private constructor(
        private readonly handle: FileHandle,
        private readonly temporary: string,
        private readonly target: string,
        private readonly options: Required<Pick<SinkOptions, 'highWaterBytes' | 'reserveBytes'>> &
            Pick<SinkOptions, 'signal'>,
    ) {}

    static async create(target: unknown, options: SinkOptions = {}): Promise<FileSink> {
        const path = assertSafeLocalPath(target);
        const directory = dirname(path);
        try {
            const info = await stat(directory);
            if (!info.isDirectory())
                throw new DbError('INVALID_REQUEST', 'The destination folder is not a folder.');
        } catch (error) {
            throw describeWriteError(error);
        }
        const reserve = options.reserveBytes ?? RESERVE_BYTES;
        const free = await freeSpace(directory);
        if (
            free !== null &&
            options.estimatedBytes !== undefined &&
            free < options.estimatedBytes + reserve
        ) {
            throw new DbError(
                'IO_ERROR',
                `There is not enough free space at the destination: about ${Math.ceil(options.estimatedBytes / MIB)} MB are needed and ${Math.floor(free / MIB)} MB are free.`,
            );
        }
        const temporary = join(
            directory,
            `.${basename(path)}.${randomBytes(4).toString('hex')}.part`,
        );
        let handle: FileHandle;
        try {
            // `wx`: never opens something that already exists.
            handle = await open(temporary, 'wx', 0o600);
        } catch (error) {
            throw describeWriteError(error);
        }
        return new FileSink(handle, temporary, path, {
            highWaterBytes: options.highWaterBytes ?? MIB,
            reserveBytes: reserve,
            signal: options.signal,
        });
    }

    get bytesWritten(): number {
        return this.written + this.buffered;
    }

    /** Accepts data, and returns when it is safe to send more. */
    async write(data: string | Uint8Array): Promise<void> {
        throwIfAborted(this.options.signal);
        const buffer =
            typeof data === 'string'
                ? Buffer.from(data, 'utf8')
                : Buffer.from(data.buffer, data.byteOffset, data.length);
        this.chunks.push(buffer);
        this.buffered += buffer.length;
        if (this.buffered >= this.options.highWaterBytes) await this.flush();
    }

    private async flush(): Promise<void> {
        if (this.buffered === 0) return;
        const data =
            this.chunks.length === 1 ? this.chunks[0]! : Buffer.concat(this.chunks, this.buffered);
        this.chunks = [];
        const length = this.buffered;
        this.buffered = 0;
        try {
            let offset = 0;
            while (offset < data.length) {
                throwIfAborted(this.options.signal);
                const { bytesWritten } = await this.handle.write(
                    data,
                    offset,
                    data.length - offset,
                );
                offset += bytesWritten;
            }
        } catch (error) {
            throw describeWriteError(error);
        }
        this.written += length;
        this.sinceCheck += length;
        if (this.sinceCheck >= RECHECK_BYTES) {
            this.sinceCheck = 0;
            const free = await freeSpace(dirname(this.target));
            if (free !== null && free < this.options.reserveBytes) {
                throw new DbError(
                    'IO_ERROR',
                    'The disk is almost full, so the export was stopped before it filled the disk.',
                );
            }
        }
    }

    /** Writes what is buffered, flushes it to the disk and moves the file to its destination. */
    async commit(): Promise<number> {
        if (this.closed) throw new DbError('INTERNAL', 'The file was already closed.');
        try {
            await this.flush();
            await this.handle.sync().catch(() => undefined);
            await this.handle.close();
            this.closed = true;
            await rename(this.temporary, this.target);
        } catch (error) {
            await this.abort();
            throw describeWriteError(error);
        }
        return this.written;
    }

    /** Drops everything written so far. Safe to call more than once. */
    async abort(): Promise<void> {
        if (!this.closed) {
            this.closed = true;
            await this.handle.close().catch(() => undefined);
        }
        await rm(this.temporary, { force: true }).catch(() => undefined);
    }
}
