/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { STUDIO_BUDGETS } from '@httpreq/db-core';

/** What a reader needs to find a line: possibly a prefix of the final index. */
export interface IndexView {
    /** Lines between consecutive checkpoints. */
    readonly interval: number;
    /** Byte offset where line `i * interval` starts; entry 0 is always 0. */
    readonly checkpoints: Float64Array;
    /**
     * Lines that can be read now. For a finished index this is every line. While indexing it also
     * counts the line the scan is in the middle of, which is readable up to `scannedBytes`: a
     * file whose first line is gigabytes long (minified JSON) still shows something at once.
     */
    readonly lineCount: number;
    /** Lines known to be complete. Only these may be cached; the one after them is still growing. */
    readonly terminatedLines: number;
    /** Bytes the scan has passed; reads never go beyond this. */
    readonly scannedBytes: number;
    /** Whether the whole file has been scanned. */
    readonly complete: boolean;
    readonly byteLength: number;
}

/**
 * The sparse line index of a finished scan.
 *
 * It stores one byte offset per `interval` lines instead of one per line, so its size is about
 * `lines / interval * 8` bytes: a 3 GB file of 30 million lines needs ~60 KB. Finding line N
 * seeks to the nearest checkpoint at or below it and scans forward through fewer than `interval`
 * lines.
 *
 * A "line" is what the text editor shows: lines are separated by `\n` and a file with `n`
 * newlines has `n + 1` lines, so a trailing newline yields a final empty line and an empty file
 * has one empty line. `\r` is part of the line's bytes (a CRLF file is stripped when displayed).
 */
export class LineIndex implements IndexView {
    readonly complete = true;

    constructor(
        readonly interval: number,
        readonly lineCount: number,
        readonly byteLength: number,
        readonly checkpoints: Float64Array,
        /** Length in bytes of the longest line; tells the viewer whether lines need truncating. */
        readonly longestLineBytes: number,
    ) {}

    get terminatedLines(): number {
        return this.lineCount;
    }

    get scannedBytes(): number {
        return this.byteLength;
    }
}

/**
 * Builds a {@link LineIndex} from chunks in file order. State carries across chunk boundaries, so
 * any chunking of the same bytes produces an identical index (a property the tests check with
 * chunks of a single byte).
 */
export class LineIndexBuilder {
    private checkpoints = new Float64Array(1024);
    private count = 1; // checkpoints[0] = 0 is implicit: line 0 starts at byte 0
    private newlines = 0;
    private scanned = 0;
    private lineStart = 0;
    private longest = 0;

    constructor(readonly interval: number = STUDIO_BUDGETS.lineCheckpointInterval) {}

    /** Bytes consumed so far. */
    get bytesScanned(): number {
        return this.scanned;
    }

    /** Lines terminated by a newline so far. */
    get completedLines(): number {
        return this.newlines;
    }

    feed(data: Uint8Array, offset: number): void {
        const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
        let position = 0;
        for (;;) {
            const found = bytes.indexOf(10, position);
            if (found === -1) break;
            const lineEnd = offset + found;
            this.longest = Math.max(this.longest, lineEnd - this.lineStart);
            this.newlines++;
            this.lineStart = lineEnd + 1;
            if (this.newlines % this.interval === 0) this.push(this.lineStart);
            position = found + 1;
        }
        this.scanned = offset + bytes.length;
    }

    /** A view of what has been scanned so far, readable while the scan continues. */
    snapshot(byteLength: number): IndexView {
        return {
            interval: this.interval,
            checkpoints: this.checkpoints.subarray(0, this.count),
            lineCount: this.scanned > 0 ? this.newlines + 1 : 0,
            terminatedLines: this.newlines,
            scannedBytes: this.scanned,
            complete: false,
            byteLength,
        };
    }

    finish(byteLength: number): LineIndex {
        this.longest = Math.max(this.longest, byteLength - this.lineStart);
        return new LineIndex(
            this.interval,
            this.newlines + 1,
            byteLength,
            this.checkpoints.slice(0, this.count),
            this.longest,
        );
    }

    private push(offset: number): void {
        if (this.count === this.checkpoints.length) {
            const grown = new Float64Array(this.checkpoints.length * 2);
            grown.set(this.checkpoints);
            this.checkpoints = grown;
        }
        this.checkpoints[this.count++] = offset;
    }
}
