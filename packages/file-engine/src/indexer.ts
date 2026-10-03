/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { createHash } from 'node:crypto';
import { type IndexView, LineIndex, LineIndexBuilder } from './lineIndex';
import type { ChunkReader } from './reader';

export interface IndexProgress {
    bytesRead: number;
    totalBytes: number;
    /** Lines found so far. */
    lines: number;
}

export interface IndexOptions {
    signal?: AbortSignal;
    interval?: number;
    chunkSize?: number;
    /** Called at most every `progressIntervalMs` while scanning. */
    onProgress?: (progress: IndexProgress) => void;
    progressIntervalMs?: number;
    /** Receives the builder so a caller can read a partial view while the scan runs. */
    onStart?: (view: () => IndexView) => void;
}

/**
 * Scans a file once, in bounded chunks, and returns its sparse line index. Memory use is two
 * chunk buffers plus the index itself, independent of the file's size.
 */
export const buildLineIndex = async (
    reader: ChunkReader,
    options: IndexOptions = {},
): Promise<LineIndex> => {
    const builder = new LineIndexBuilder(options.interval);
    const total = reader.size;
    options.onStart?.(() => builder.snapshot(total));
    const every = options.progressIntervalMs ?? 100;
    let last = 0;
    for await (const chunk of reader.chunks({
        signal: options.signal,
        chunkSize: options.chunkSize,
    })) {
        builder.feed(chunk.data, chunk.offset);
        const now = Date.now();
        if (options.onProgress && now - last >= every) {
            last = now;
            options.onProgress({
                bytesRead: builder.bytesScanned,
                totalBytes: total,
                lines: builder.completedLines,
            });
        }
    }
    return builder.finish(total);
};

const SAMPLE_BYTES = 64 * 1024;

/**
 * Identifies a file's contents cheaply: size, modification time and the first and last 64 KiB.
 * Two files with the same fingerprint are treated as the same file by the index cache; a touched,
 * truncated or appended-to file gets a new one and is re-indexed.
 */
export const fingerprintFile = async (reader: ChunkReader): Promise<string> => {
    const hash = createHash('sha256');
    hash.update(`${reader.size}:${reader.mtimeMs}:`);
    hash.update(await reader.readRange(0, SAMPLE_BYTES));
    if (reader.size > SAMPLE_BYTES) {
        hash.update(
            await reader.readRange(
                Math.max(SAMPLE_BYTES, reader.size - SAMPLE_BYTES),
                SAMPLE_BYTES,
            ),
        );
    }
    return hash.digest('hex').slice(0, 32);
};
