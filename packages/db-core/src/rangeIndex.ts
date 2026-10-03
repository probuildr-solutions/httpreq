/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { DbError } from './errors';

/** One entry of a {@link RangeIndex}: where an item sits in the file. */
export interface IndexedRange {
    /** First byte. */
    start: number;
    /** One past the last byte. */
    end: number;
    /** Scanner-defined bits (item kind, error markers). */
    flags: number;
}

const PAGE_SIZE = 65_536;
/** One absolute offset per this many entries, so a lookup sums at most this many gaps. */
const CHECKPOINT_EVERY = 1_024;
const MAX_U32 = 0xffff_ffff;

interface Page {
    gap: Uint32Array;
    length: Uint32Array;
    flags: Uint8Array;
}

/**
 * The offsets of millions of items (SQL statements, JSON documents) in a file, kept compact.
 *
 * Each entry costs 9 bytes: the gap since the previous item's end, its length (both 32-bit) and a
 * flags byte. Ten million statements therefore take about 90 MB, and the storage is paged, so it
 * grows without copying and never needs one huge allocation. Absolute offsets are rebuilt from a
 * checkpoint every 1,024 entries, which keeps random access cheap and offsets exact up to 2^53.
 *
 * Entries must be added in file order and must not overlap. The index can be read while it is
 * still being filled, which is what lets a file be navigated before its scan has finished.
 */
export class RangeIndex {
    private readonly pages: Page[] = [];
    private checkpoints: Float64Array = new Float64Array(64);
    private total = 0;
    private lastEnd = 0;

    get count(): number {
        return this.total;
    }

    /** End of the last entry (0 when empty). */
    get coveredBytes(): number {
        return this.lastEnd;
    }

    add(start: number, end: number, flags = 0): void {
        const gap = start - this.lastEnd;
        const length = end - start;
        if (gap < 0 || length < 0) {
            throw new DbError('INTERNAL', 'Index entries must be added in file order.');
        }
        if (gap > MAX_U32 || length > MAX_U32) {
            throw new DbError('LIMIT_EXCEEDED', 'An item is larger than 4 GiB.');
        }
        const slot = this.total % PAGE_SIZE;
        if (slot === 0) {
            this.pages.push({
                gap: new Uint32Array(PAGE_SIZE),
                length: new Uint32Array(PAGE_SIZE),
                flags: new Uint8Array(PAGE_SIZE),
            });
        }
        const page = this.pages[this.pages.length - 1]!;
        page.gap[slot] = gap;
        page.length[slot] = length;
        page.flags[slot] = flags;
        if (this.total % CHECKPOINT_EVERY === 0)
            this.setCheckpoint(this.total / CHECKPOINT_EVERY, start);
        this.total++;
        this.lastEnd = end;
    }

    /** The entry at `index`, or undefined past the end. */
    get(index: number): IndexedRange | undefined {
        if (!Number.isInteger(index) || index < 0 || index >= this.total) return undefined;
        const checkpoint = Math.floor(index / CHECKPOINT_EVERY);
        const first = checkpoint * CHECKPOINT_EVERY;
        let start = this.checkpoints[checkpoint]!;
        // The checkpoint is the start of `first`; walk forward to `index`.
        for (let i = first; i < index; i++) start += this.lengthAt(i) + this.gapAt(i + 1);
        const length = this.lengthAt(index);
        return { start, end: start + length, flags: this.flagsAt(index) };
    }

    /**
     * Index of the entry containing `offset`, or of the next entry after it when the offset falls
     * in a gap; -1 when `offset` is past the last entry.
     */
    indexAt(offset: number): number {
        if (this.total === 0 || offset >= this.lastEnd) return -1;
        // Binary search the checkpoints, then walk at most CHECKPOINT_EVERY entries.
        let low = 0;
        let high = Math.floor((this.total - 1) / CHECKPOINT_EVERY);
        while (low < high) {
            const middle = (low + high + 1) >> 1;
            if (this.checkpoints[middle]! <= offset) low = middle;
            else high = middle - 1;
        }
        let index = low * CHECKPOINT_EVERY;
        let start = this.checkpoints[low]!;
        while (index < this.total - 1 && start + this.lengthAt(index) <= offset) {
            start += this.lengthAt(index) + this.gapAt(index + 1);
            index++;
        }
        return index;
    }

    /** Approximate memory held by the index, for budgets and diagnostics. */
    get bytes(): number {
        return this.pages.length * PAGE_SIZE * 9 + this.checkpoints.byteLength;
    }

    private setCheckpoint(slot: number, value: number): void {
        if (slot >= this.checkpoints.length) {
            const grown = new Float64Array(this.checkpoints.length * 2);
            grown.set(this.checkpoints);
            this.checkpoints = grown;
        }
        this.checkpoints[slot] = value;
    }

    private gapAt(index: number): number {
        return this.pages[Math.floor(index / PAGE_SIZE)]!.gap[index % PAGE_SIZE]!;
    }

    private lengthAt(index: number): number {
        return this.pages[Math.floor(index / PAGE_SIZE)]!.length[index % PAGE_SIZE]!;
    }

    private flagsAt(index: number): number {
        return this.pages[Math.floor(index / PAGE_SIZE)]!.flags[index % PAGE_SIZE]!;
    }
}
