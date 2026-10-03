/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { DbError, STUDIO_BUDGETS, throwIfAborted } from '@httpreq/db-core';
import type { ByteSource } from './source';

/** A run of bytes from the file. */
export interface Chunk {
    /** A view into a buffer the reader reuses: valid only until the next chunk is requested. */
    data: Uint8Array;
    /** Where `data` starts in the file. */
    offset: number;
}

export interface ChunkOptions {
    /** First byte to read; defaults to 0. */
    start?: number;
    /** One past the last byte; defaults to the end of the file. */
    end?: number;
    chunkSize?: number;
    signal?: AbortSignal;
}

/** Longest run `readRange` will return in one piece. */
const MAX_RANGE_BYTES = 8 * 1024 * 1024;

/**
 * Sequential, bounded reads over a {@link ByteSource}. There is no way to ask for "the whole
 * file": a scan is a stream of chunks, and a point read is capped.
 *
 * Reading is double-buffered: while the consumer scans one chunk the next is already being read
 * into the other buffer, so the disk and the scanner overlap and exactly two buffers of
 * `chunkSize` exist, however large the file is. That is why a chunk is valid only until the
 * next one is requested.
 */
export class ChunkReader {
    constructor(
        private readonly source: ByteSource,
        private readonly defaultChunkBytes: number = STUDIO_BUDGETS.chunkBytes,
    ) {}

    get size(): number {
        return this.source.size;
    }

    get mtimeMs(): number {
        return this.source.mtimeMs;
    }

    /** The underlying source, for callers that fingerprint it. */
    get bytes(): ByteSource {
        return this.source;
    }

    async *chunks(options: ChunkOptions = {}): AsyncGenerator<Chunk, void, void> {
        const { signal } = options;
        const chunkSize = options.chunkSize ?? this.defaultChunkBytes;
        if (!Number.isInteger(chunkSize) || chunkSize < 1) {
            throw new DbError('INVALID_REQUEST', 'The chunk size must be a positive integer.');
        }
        const start = Math.max(0, options.start ?? 0);
        const end = Math.min(this.source.size, options.end ?? this.source.size);
        const buffers = [new Uint8Array(chunkSize), new Uint8Array(chunkSize)];
        let position = start;
        let turn = 0;

        const readNext = (): Promise<Chunk | null> | undefined => {
            if (position >= end) return undefined;
            const buffer = buffers[turn]!;
            turn ^= 1;
            const offset = position;
            const length = Math.min(chunkSize, end - position);
            position += length;
            return this.source.readInto(buffer, length, offset).then((read) => {
                if (read < length) position = end; // the file shrank under us: stop at its end
                return read === 0 ? null : { data: buffer.subarray(0, read), offset };
            });
        };

        let pending = readNext();
        try {
            while (pending) {
                const chunk = await pending;
                pending = undefined;
                throwIfAborted(signal);
                if (!chunk) return;
                // Start the next read before handing this chunk out: the consumer has finished
                // with the previous chunk (it asked for this one), so its buffer is free.
                pending = readNext();
                yield chunk;
                throwIfAborted(signal);
            }
        } finally {
            // Leaving early must not leave a read running into a closed handle.
            await pending?.catch(() => undefined);
        }
    }

    /** A small point read, copied out of the reusable buffers. Capped, so it cannot become a slurp. */
    async readRange(start: number, length: number): Promise<Uint8Array> {
        if (!Number.isInteger(start) || !Number.isInteger(length) || start < 0 || length < 0) {
            throw new DbError('INVALID_REQUEST', 'Invalid byte range.');
        }
        if (length > MAX_RANGE_BYTES) {
            throw new DbError('LIMIT_EXCEEDED', 'That range is too large to read at once.');
        }
        const wanted = Math.max(0, Math.min(length, this.source.size - start));
        const target = new Uint8Array(wanted);
        const read = await this.source.readInto(target, wanted, start);
        return read === wanted ? target : target.subarray(0, read);
    }

    close(): Promise<void> {
        return this.source.close();
    }
}
