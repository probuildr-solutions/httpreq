/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { randomBytes } from 'node:crypto';
import { mkdir, open, rm, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { DbError, toDbError } from '@httpreq/db-core';

/** Where a block was written. */
export interface SpoolEntry {
    offset: number;
    length: number;
}

/**
 * An append-only temporary file for data that is too big to keep in memory but is read back at
 * random: the pages of a large query result. Writes only ever go to the end; reads are by the
 * offset and length that `append` returned.
 *
 * The file is created in a private folder, named at random, and removed by `dispose`. It is
 * capped: past `maxBytes` an append is refused, so a runaway result cannot fill a disk.
 */
export class SpoolFile {
    private size = 0;
    private writing: Promise<unknown> = Promise.resolve();
    private disposed = false;

    private constructor(
        private readonly handle: FileHandle,
        private readonly path: string,
        readonly maxBytes: number,
    ) {}

    static async create(directory: string, maxBytes: number): Promise<SpoolFile> {
        try {
            await mkdir(directory, { recursive: true });
            const path = join(directory, `${randomBytes(8).toString('hex')}.spool`);
            const handle = await open(path, 'wx+');
            return new SpoolFile(handle, path, maxBytes);
        } catch (error) {
            throw toDbError(error);
        }
    }

    get bytes(): number {
        return this.size;
    }

    /** Whether `length` more bytes would still fit. */
    fits(length: number): boolean {
        return this.size + length <= this.maxBytes;
    }

    /** Appends a block. Appends are queued, so concurrent callers cannot interleave. */
    append(data: Uint8Array): Promise<SpoolEntry> {
        const run = async (): Promise<SpoolEntry> => {
            if (this.disposed) throw new DbError('CANCELLED', 'The result was closed.');
            if (!this.fits(data.length)) {
                throw new DbError(
                    'LIMIT_EXCEEDED',
                    'The result is larger than the space set aside for it.',
                );
            }
            const offset = this.size;
            let written = 0;
            while (written < data.length) {
                const { bytesWritten } = await this.handle.write(
                    data,
                    written,
                    data.length - written,
                    offset + written,
                );
                written += bytesWritten;
            }
            this.size += data.length;
            return { offset, length: data.length };
        };
        const result = this.writing.then(run, run);
        this.writing = result.catch(() => undefined);
        return result;
    }

    async read(entry: SpoolEntry): Promise<Buffer> {
        if (this.disposed) throw new DbError('CANCELLED', 'The result was closed.');
        const buffer = Buffer.allocUnsafe(entry.length);
        let read = 0;
        while (read < entry.length) {
            const { bytesRead } = await this.handle.read(
                buffer,
                read,
                entry.length - read,
                entry.offset + read,
            );
            if (bytesRead === 0)
                throw new DbError('IO_ERROR', 'The result file is shorter than expected.');
            read += bytesRead;
        }
        return buffer;
    }

    /** Closes and deletes the file. Safe to call more than once. */
    async dispose(): Promise<void> {
        if (this.disposed) return;
        this.disposed = true;
        await this.writing;
        await this.handle.close().catch(() => undefined);
        await rm(this.path, { force: true }).catch(() => undefined);
    }
}
