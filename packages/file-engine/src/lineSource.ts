/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { STUDIO_BUDGETS, throwIfAborted } from '@httpreq/db-core';
import { ByteBudgetLru } from '@httpreq/streaming-engine';
import type { IndexView } from './lineIndex';
import type { ChunkReader } from './reader';

/** One line of the file as the viewer shows it. */
export interface LineSlice {
    /** Zero-based line number. */
    line: number;
    text: string;
    /** The line was longer than the display limit and was cut. */
    truncated: boolean;
}

export interface LineSourceOptions {
    maxLineBytes?: number;
    pageSize?: number;
    cacheBytes?: number;
}

const LF = 10;
/** Rough per-line overhead of a cached string and its wrapper object. */
const LINE_OVERHEAD = 64;

/**
 * The virtual document: "give me lines 750,000 to 750,150" answered by reading only the bytes
 * those lines occupy. Memory is a few chunk buffers plus a byte-budgeted cache of decoded pages,
 * so it does not depend on the file's size.
 *
 * The index is read through a getter, so a file can be browsed while its index is still being
 * built; only lines the scan has already passed are available.
 */
export class LineSource {
    private readonly maxLineBytes: number;
    private readonly pageSize: number;
    private readonly cache: ByteBudgetLru<number, LineSlice[]>;
    private readonly decoder = new TextDecoder('utf-8');

    constructor(
        private readonly reader: ChunkReader,
        private readonly index: () => IndexView,
        options: LineSourceOptions = {},
    ) {
        this.maxLineBytes = options.maxLineBytes ?? STUDIO_BUDGETS.maxLineBytes;
        this.pageSize = options.pageSize ?? STUDIO_BUDGETS.linePageSize;
        this.cache = new ByteBudgetLru(options.cacheBytes ?? STUDIO_BUDGETS.linePageCacheBytes);
    }

    get lineCount(): number {
        return this.index().lineCount;
    }

    /** Lines `[from, from + count)`, clamped to what is currently readable. */
    async readLines(from: number, count: number, signal?: AbortSignal): Promise<LineSlice[]> {
        const view = this.index();
        const first = Math.max(0, Math.floor(from));
        const last = Math.min(view.lineCount, first + Math.max(0, Math.floor(count)));
        if (first >= last) return [];
        const firstPage = Math.floor(first / this.pageSize);
        const lastPage = Math.floor((last - 1) / this.pageSize);

        const pages = new Map<number, LineSlice[]>();
        for (let page = firstPage; page <= lastPage;) {
            const cached = this.cache.get(page);
            if (cached) {
                pages.set(page, cached);
                page++;
                continue;
            }
            // Read the whole run of missing pages in one pass over the file.
            let runEnd = page;
            while (runEnd + 1 <= lastPage && !this.cache.has(runEnd + 1)) runEnd++;
            const lines = await this.scan(
                view,
                page * this.pageSize,
                (runEnd - page + 1) * this.pageSize,
                signal,
            );
            for (let p = page; p <= runEnd; p++) {
                const slice = lines.slice(
                    (p - page) * this.pageSize,
                    (p - page + 1) * this.pageSize,
                );
                pages.set(p, slice);
                // Keep a page only once every line on it is final; the line a running index is
                // in the middle of will grow.
                if (view.complete || (p + 1) * this.pageSize <= view.terminatedLines) {
                    this.cache.set(p, slice, this.sizeOf(slice));
                }
            }
            page = runEnd + 1;
        }

        const out: LineSlice[] = [];
        for (let page = firstPage; page <= lastPage; page++) {
            const lines = pages.get(page) ?? [];
            const base = page * this.pageSize;
            out.push(...lines.slice(Math.max(0, first - base), Math.max(0, last - base)));
        }
        return out;
    }

    private sizeOf(lines: LineSlice[]): number {
        let bytes = 0;
        for (const line of lines) bytes += line.text.length * 2 + LINE_OVERHEAD;
        return bytes;
    }

    /** Reads `count` lines starting at `from`, scanning forward from the nearest checkpoint. */
    private async scan(
        view: IndexView,
        from: number,
        count: number,
        signal?: AbortSignal,
    ): Promise<LineSlice[]> {
        const checkpoint = Math.floor(from / view.interval);
        const startOffset = view.checkpoints[checkpoint] ?? 0;
        // Lines are numbered relative to the checkpoint, which is where the scan begins.
        const base = checkpoint * view.interval;
        const wantFrom = from - base;
        const wantTo = wantFrom + count;
        const lastReadable = view.lineCount - base; // lines of a partial index stop here

        const out: LineSlice[] = [];
        let relative = 0;
        let parts: Buffer[] = [];
        let partBytes = 0;
        let truncated = false;

        const take = (bytes: Buffer, start: number, end: number) => {
            if (relative < wantFrom || end <= start) return;
            const room = this.maxLineBytes - partBytes;
            const length = Math.min(end - start, Math.max(0, room));
            if (length > 0) {
                // Copy: the chunk buffer is reused for the next read.
                parts.push(Buffer.from(bytes.subarray(start, start + length)));
                partBytes += length;
            }
            if (length < end - start) truncated = true;
        };
        const finish = () => {
            const joined = parts.length === 1 ? parts[0]! : Buffer.concat(parts);
            let text = this.decoder.decode(joined);
            if (!truncated && text.endsWith('\r')) text = text.slice(0, -1);
            out.push({ line: base + relative, text, truncated });
            parts = [];
            partBytes = 0;
            truncated = false;
        };

        // A running index has only scanned part of the file; never read past what it has seen.
        for await (const chunk of this.reader.chunks({
            start: startOffset,
            end: view.scannedBytes,
            signal,
        })) {
            const bytes = Buffer.from(chunk.data.buffer, chunk.data.byteOffset, chunk.data.length);
            let position = 0;
            while (position < bytes.length) {
                const found = bytes.indexOf(LF, position);
                const end = found === -1 ? bytes.length : found;
                take(bytes, position, end);
                if (found === -1) break;
                if (relative >= wantFrom) finish();
                relative++;
                position = found + 1;
                if (relative >= wantTo || relative >= lastReadable) return out;
            }
        }
        // The last line has no newline after it (or is the empty line after a final newline), or
        // is the line a running index has reached so far.
        if (relative >= wantFrom && relative < wantTo && relative < lastReadable) finish();
        throwIfAborted(signal);
        return out;
    }
}
