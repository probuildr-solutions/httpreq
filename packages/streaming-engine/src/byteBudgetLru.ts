/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

interface Slot<V> {
    value: V;
    bytes: number;
}

/**
 * A least-recently-used cache limited by the bytes its values occupy, not by entry count: a page
 * of ten wide rows and a page of a thousand narrow ones cost very different amounts of memory.
 * A value larger than the whole budget is not cached at all.
 */
export class ByteBudgetLru<K, V> {
    // A Map iterates in insertion order, so re-inserting on access keeps the oldest entry first.
    private readonly slots = new Map<K, Slot<V>>();
    private used = 0;

    constructor(private readonly maxBytes: number) {}

    get bytes(): number {
        return this.used;
    }

    get size(): number {
        return this.slots.size;
    }

    get(key: K): V | undefined {
        const slot = this.slots.get(key);
        if (!slot) return undefined;
        this.slots.delete(key);
        this.slots.set(key, slot);
        return slot.value;
    }

    has(key: K): boolean {
        return this.slots.has(key);
    }

    set(key: K, value: V, bytes: number): void {
        this.delete(key);
        if (bytes > this.maxBytes) return;
        this.slots.set(key, { value, bytes });
        this.used += bytes;
        for (const [oldest, slot] of this.slots) {
            if (this.used <= this.maxBytes) break;
            this.slots.delete(oldest);
            this.used -= slot.bytes;
        }
    }

    delete(key: K): void {
        const slot = this.slots.get(key);
        if (!slot) return;
        this.slots.delete(key);
        this.used -= slot.bytes;
    }

    clear(): void {
        this.slots.clear();
        this.used = 0;
    }
}
