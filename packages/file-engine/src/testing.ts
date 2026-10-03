/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import type { ByteSource } from './source';

/** An in-memory file for tests. */
export class MemorySource implements ByteSource {
    readonly size: number;
    reads: { length: number; position: number }[] = [];
    closed = false;

    constructor(
        private readonly bytes: Uint8Array,
        readonly mtimeMs = 1,
    ) {
        this.size = bytes.length;
    }

    static text(text: string, mtimeMs = 1): MemorySource {
        return new MemorySource(new TextEncoder().encode(text), mtimeMs);
    }

    async readInto(target: Uint8Array, length: number, position: number): Promise<number> {
        this.reads.push({ length, position });
        const slice = this.bytes.subarray(position, position + length);
        target.set(slice);
        return slice.length;
    }

    async close(): Promise<void> {
        this.closed = true;
    }
}

/**
 * A synthetic file of `size` bytes made of one repeating pattern, so tests can scan "3 GB" with no
 * disk and no allocation beyond the reader's own buffers. Every read is recorded (length only) so
 * a test can assert that no read was larger than a chunk.
 */
export class PatternSource implements ByteSource {
    readonly mtimeMs = 1;
    maxRead = 0;
    totalRead = 0;
    /** The pattern repeated to a few MiB, so one read is one copy rather than thousands. */
    private readonly block: Uint8Array;
    private readonly period: number;

    constructor(
        readonly size: number,
        pattern: Uint8Array,
    ) {
        this.period = pattern.length;
        const repeats = Math.ceil((4 * 1024 * 1024) / this.period) + 1;
        this.block = new Uint8Array(repeats * this.period);
        for (let i = 0; i < repeats; i++) this.block.set(pattern, i * this.period);
    }

    async readInto(target: Uint8Array, length: number, position: number): Promise<number> {
        const wanted = Math.max(0, Math.min(length, this.size - position));
        if (wanted > this.block.length - this.period)
            throw new Error('read larger than the test block');
        this.maxRead = Math.max(this.maxRead, wanted);
        this.totalRead += wanted;
        const phase = position % this.period;
        target.set(this.block.subarray(phase, phase + wanted));
        return wanted;
    }

    async close(): Promise<void> {}
}
