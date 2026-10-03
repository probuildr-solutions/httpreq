/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { DbError, throwIfAborted } from '@httpreq/db-core';

interface Entry<T> {
    item: T;
    weight: number;
}

interface Producer {
    wake: () => void;
    fail: (error: unknown) => void;
}

/**
 * An async queue with a weight limit. `push` does not resolve until the item has been accepted,
 * so a producer that awaits it is slowed to the consumer's pace: that is the backpressure which
 * keeps a fast reader from piling a 3 GB file into memory ahead of a slow consumer.
 *
 * Weight is whatever the caller counts (items, rows, bytes). An item heavier than the whole
 * capacity is still accepted when the queue is empty, so a single large item cannot deadlock it.
 */
export class BoundedQueue<T> implements AsyncIterable<T> {
    private readonly entries: Entry<T>[] = [];
    private used = 0;
    private readonly producers: Producer[] = [];
    private consumer: {
        resolve: (result: IteratorResult<T>) => void;
        reject: (e: unknown) => void;
    } | null = null;
    private closed = false;
    private failure: { error: unknown } | null = null;

    constructor(private readonly capacity: number) {
        if (!(capacity > 0))
            throw new DbError('INVALID_REQUEST', 'Queue capacity must be positive.');
    }

    /** Weight currently buffered. */
    get size(): number {
        return this.used;
    }

    /**
     * Adds an item, waiting while the queue is full. Rejects if the queue is closed or failed, or
     * if `signal` fires while waiting.
     */
    async push(item: T, weight = 1, signal?: AbortSignal): Promise<void> {
        for (;;) {
            this.assertOpen();
            throwIfAborted(signal);
            const fits = this.used === 0 || this.used + weight <= this.capacity;
            if (fits) break;
            await this.waitForSpace(signal);
        }
        this.assertOpen();
        if (this.consumer) {
            const { resolve } = this.consumer;
            this.consumer = null;
            resolve({ value: item, done: false });
            return;
        }
        this.entries.push({ item, weight });
        this.used += weight;
    }

    /** No more items will be pushed; the consumer drains what is buffered, then finishes. */
    close(): void {
        if (this.closed) return;
        this.closed = true;
        this.releaseProducers(new DbError('CANCELLED', 'The stream was closed.'));
        if (this.consumer && this.entries.length === 0) {
            const { resolve } = this.consumer;
            this.consumer = null;
            resolve({ value: undefined, done: true });
        }
    }

    /** Ends the stream with an error: buffered items are dropped and the consumer rethrows. */
    fail(error: unknown): void {
        if (this.failure || this.closed) return;
        this.failure = { error };
        this.entries.length = 0;
        this.used = 0;
        this.releaseProducers(error);
        if (this.consumer) {
            const { reject } = this.consumer;
            this.consumer = null;
            reject(error);
        }
    }

    [Symbol.asyncIterator](): AsyncIterator<T> {
        return {
            next: () => this.next(),
            // Leaving the loop early (break/throw) closes the queue so the producer stops too.
            return: async () => {
                this.close();
                this.entries.length = 0;
                this.used = 0;
                return { value: undefined, done: true };
            },
        };
    }

    private next(): Promise<IteratorResult<T>> {
        if (this.failure) return Promise.reject(this.failure.error);
        const entry = this.entries.shift();
        if (entry) {
            this.used -= entry.weight;
            this.producers.shift()?.wake();
            return Promise.resolve({ value: entry.item, done: false });
        }
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        if (this.consumer) {
            return Promise.reject(new DbError('INTERNAL', 'Only one consumer may read a queue.'));
        }
        return new Promise((resolve, reject) => {
            this.consumer = { resolve, reject };
            // A producer parked on a full queue may now proceed: the consumer is waiting.
            this.producers.shift()?.wake();
        });
    }

    private waitForSpace(signal: AbortSignal | undefined): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const producer: Producer = {
                wake: () => {
                    signal?.removeEventListener('abort', onAbort);
                    resolve();
                },
                fail: (error) => {
                    signal?.removeEventListener('abort', onAbort);
                    reject(error);
                },
            };
            const onAbort = () => {
                const index = this.producers.indexOf(producer);
                if (index >= 0) this.producers.splice(index, 1);
                try {
                    throwIfAborted(signal);
                } catch (error) {
                    reject(error);
                }
            };
            signal?.addEventListener('abort', onAbort, { once: true });
            this.producers.push(producer);
        });
    }

    private assertOpen(): void {
        if (this.failure) throw this.failure.error;
        if (this.closed) throw new DbError('CANCELLED', 'The stream was closed.');
    }

    private releaseProducers(error: unknown): void {
        for (const producer of this.producers.splice(0)) producer.fail(error);
    }
}
