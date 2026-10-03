/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { DbError, throwIfAborted } from '@httpreq/db-core';

interface Waiter {
    amount: number;
    resolve: () => void;
    reject: (error: unknown) => void;
}

/**
 * Credit-based flow control across a process boundary. The receiver grants credit (it has room
 * for N more pages); the sender spends it before sending and waits when it runs out. A database
 * cursor that is only read while credit is available cannot outrun a slow grid.
 */
export class CreditGate {
    private credit: number;
    private readonly waiters: Waiter[] = [];
    private closedWith: unknown;

    constructor(initial = 0) {
        this.credit = initial;
    }

    get available(): number {
        return this.credit;
    }

    grant(amount: number): void {
        if (!(amount > 0)) return;
        this.credit += amount;
        this.drain();
    }

    /** Takes `amount` credit, waiting until that much is available. */
    acquire(amount = 1, signal?: AbortSignal): Promise<void> {
        if (this.closedWith) return Promise.reject(this.closedWith);
        try {
            throwIfAborted(signal);
        } catch (error) {
            return Promise.reject(error);
        }
        if (this.waiters.length === 0 && this.credit >= amount) {
            this.credit -= amount;
            return Promise.resolve();
        }
        return new Promise<void>((resolve, reject) => {
            const waiter: Waiter = {
                amount,
                resolve: () => {
                    signal?.removeEventListener('abort', onAbort);
                    resolve();
                },
                reject: (error) => {
                    signal?.removeEventListener('abort', onAbort);
                    reject(error);
                },
            };
            const onAbort = () => {
                const index = this.waiters.indexOf(waiter);
                if (index >= 0) this.waiters.splice(index, 1);
                reject(new DbError('CANCELLED', 'The operation was cancelled.'));
            };
            signal?.addEventListener('abort', onAbort, { once: true });
            this.waiters.push(waiter);
        });
    }

    /** Fails every waiter and every later `acquire`; used when the receiver goes away. */
    close(error: unknown = new DbError('CANCELLED', 'The receiver went away.')): void {
        this.closedWith = error;
        for (const waiter of this.waiters.splice(0)) waiter.reject(error);
    }

    private drain(): void {
        // First come, first served: a large request at the head is not starved by small ones.
        while (this.waiters[0] && this.credit >= this.waiters[0].amount) {
            const waiter = this.waiters.shift()!;
            this.credit -= waiter.amount;
            waiter.resolve();
        }
    }
}
