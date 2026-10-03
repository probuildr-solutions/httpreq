/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { describe, expect, it } from 'vitest';
import { BoundedQueue, ByteBudgetLru, CreditGate } from './index';

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

describe('BoundedQueue', () => {
    it('delivers items in order and ends when closed', async () => {
        const queue = new BoundedQueue<number>(10);
        const producer = (async () => {
            for (let i = 0; i < 5; i++) await queue.push(i);
            queue.close();
        })();
        const seen: number[] = [];
        for await (const item of queue) seen.push(item);
        await producer;
        expect(seen).toEqual([0, 1, 2, 3, 4]);
    });

    it('holds a producer back until the consumer catches up', async () => {
        const queue = new BoundedQueue<number>(2);
        await queue.push(1);
        await queue.push(2);
        let accepted = false;
        const third = queue.push(3).then(() => (accepted = true));
        await tick();
        expect(accepted).toBe(false);
        expect(queue.size).toBe(2);

        const iterator = queue[Symbol.asyncIterator]();
        expect((await iterator.next()).value).toBe(1);
        await third;
        expect(accepted).toBe(true);
    });

    it('never buffers more than its capacity however fast the producer runs', async () => {
        const queue = new BoundedQueue<number>(4);
        let peak = 0;
        const producer = (async () => {
            for (let i = 0; i < 200; i++) {
                await queue.push(i);
                peak = Math.max(peak, queue.size);
            }
            queue.close();
        })();
        let count = 0;
        for await (const item of queue) {
            expect(item).toBe(count++);
            if (count % 20 === 0) await tick();
        }
        await producer;
        expect(count).toBe(200);
        expect(peak).toBeLessThanOrEqual(4);
    });

    it('accepts an item heavier than the whole capacity when empty', async () => {
        const queue = new BoundedQueue<string>(10);
        await queue.push('big', 1_000);
        queue.close();
        const seen: string[] = [];
        for await (const item of queue) seen.push(item);
        expect(seen).toEqual(['big']);
    });

    it('rethrows a failure in the consumer and unblocks a waiting producer', async () => {
        const queue = new BoundedQueue<number>(1);
        await queue.push(1);
        const blocked = queue.push(2);
        const rejected = expect(blocked).rejects.toThrow('disk gone');
        queue.fail(new Error('disk gone'));
        await rejected;
        await expect(queue[Symbol.asyncIterator]().next()).rejects.toThrow('disk gone');
    });

    it('stops the producer when the consumer leaves the loop early', async () => {
        const queue = new BoundedQueue<number>(1);
        const producer = (async () => {
            for (let i = 0; i < 1_000; i++) await queue.push(i);
        })();
        const rejected = expect(producer).rejects.toMatchObject({ code: 'CANCELLED' });
        for await (const item of queue) {
            expect(item).toBe(0);
            break;
        }
        await rejected;
    });

    it('abandons a waiting push when its signal fires', async () => {
        const queue = new BoundedQueue<number>(1);
        await queue.push(1);
        const controller = new AbortController();
        const waiting = queue.push(2, 1, controller.signal);
        const rejected = expect(waiting).rejects.toMatchObject({ code: 'CANCELLED' });
        controller.abort();
        await rejected;
        // The abandoned producer left no stale waiter behind: the queue still works.
        const iterator = queue[Symbol.asyncIterator]();
        expect((await iterator.next()).value).toBe(1);
        await queue.push(3);
        expect((await iterator.next()).value).toBe(3);
    });
});

describe('CreditGate', () => {
    it('spends available credit immediately and waits when it runs out', async () => {
        const gate = new CreditGate(2);
        await gate.acquire();
        await gate.acquire();
        expect(gate.available).toBe(0);
        let done = false;
        const pending = gate.acquire().then(() => (done = true));
        await tick();
        expect(done).toBe(false);
        gate.grant(1);
        await pending;
        expect(done).toBe(true);
    });

    it('serves waiters in order', async () => {
        const gate = new CreditGate(0);
        const order: string[] = [];
        const big = gate.acquire(3).then(() => order.push('big'));
        const small = gate.acquire(1).then(() => order.push('small'));
        gate.grant(1);
        await tick();
        expect(order).toEqual([]);
        gate.grant(3);
        await Promise.all([big, small]);
        expect(order).toEqual(['big', 'small']);
    });

    it('fails waiters when closed or aborted', async () => {
        const gate = new CreditGate(0);
        const controller = new AbortController();
        const aborted = expect(gate.acquire(1, controller.signal)).rejects.toMatchObject({
            code: 'CANCELLED',
        });
        controller.abort();
        await aborted;
        const waiting = expect(gate.acquire(1)).rejects.toMatchObject({ code: 'CANCELLED' });
        gate.close();
        await waiting;
        await expect(gate.acquire()).rejects.toMatchObject({ code: 'CANCELLED' });
    });
});

describe('ByteBudgetLru', () => {
    it('evicts the least recently used entries to stay under the byte budget', () => {
        const cache = new ByteBudgetLru<string, string>(10);
        cache.set('a', 'A', 4);
        cache.set('b', 'B', 4);
        expect(cache.get('a')).toBe('A'); // a is now the most recent
        cache.set('c', 'C', 4);
        expect(cache.has('b')).toBe(false);
        expect(cache.has('a')).toBe(true);
        expect(cache.bytes).toBe(8);
    });

    it('does not cache a value larger than the whole budget', () => {
        const cache = new ByteBudgetLru<string, string>(10);
        cache.set('huge', 'x', 11);
        expect(cache.size).toBe(0);
        expect(cache.bytes).toBe(0);
    });

    it('replaces an entry without double counting its bytes', () => {
        const cache = new ByteBudgetLru<string, string>(10);
        cache.set('a', '1', 6);
        cache.set('a', '2', 3);
        expect(cache.bytes).toBe(3);
        expect(cache.get('a')).toBe('2');
        cache.clear();
        expect(cache.bytes).toBe(0);
    });
});
