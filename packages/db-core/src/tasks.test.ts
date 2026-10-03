/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DbError } from './errors';
import { BackgroundTaskManager, type TaskSnapshot } from './tasks';

const info = { name: 'Export orders', type: 'export' as const };

beforeEach(() => {
    vi.useFakeTimers();
});
afterEach(() => {
    vi.useRealTimers();
});

const collect = (manager: BackgroundTaskManager) => {
    const snapshots: TaskSnapshot[] = [];
    manager.onChange((s) => snapshots.push(s));
    return snapshots;
};

describe('background task manager', () => {
    it('runs a task through its states and reports completion', async () => {
        const manager = new BackgroundTaskManager();
        const snapshots = collect(manager);
        const id = manager.submit(info, async (ctx) => {
            ctx.report({ stage: 'Reading', rowsProcessed: 5 });
            return { message: '5 rows written' };
        });
        const final = await manager.settled(id);
        expect(final).toMatchObject({
            state: 'COMPLETED',
            percent: 100,
            message: '5 rows written',
        });
        expect(snapshots.map((s) => s.state)).toEqual(['PENDING', 'RUNNING', 'COMPLETED']);
    });

    it('turns a failure into FAILED with the error, and cancellation into CANCELLED', async () => {
        const manager = new BackgroundTaskManager();
        const failed = manager.submit(info, async () => {
            throw new DbError('IO_ERROR', 'The disk is full.');
        });
        expect(await manager.settled(failed)).toMatchObject({
            state: 'FAILED',
            error: { code: 'IO_ERROR', message: 'The disk is full.' },
        });

        const running = manager.submit(
            info,
            (ctx) =>
                new Promise<void>((_, reject) =>
                    ctx.signal.addEventListener('abort', () =>
                        reject(new DbError('CANCELLED', 'stop')),
                    ),
                ),
        );
        await vi.advanceTimersByTimeAsync(0);
        expect(manager.get(running)?.state).toBe('RUNNING');
        manager.cancel(running);
        expect(manager.get(running)?.state).toBe('CANCELLING');
        expect(await manager.settled(running)).toMatchObject({ state: 'CANCELLED' });
    });

    it('cancels a waiting task without ever running it', async () => {
        const manager = new BackgroundTaskManager({ maxConcurrent: 1 });
        const ran = vi.fn();
        manager.submit(info, () => new Promise<void>(() => undefined));
        const waiting = manager.submit(info, async () => void ran());
        expect(manager.get(waiting)?.state).toBe('PENDING');
        manager.cancel(waiting);
        expect(manager.get(waiting)?.state).toBe('CANCELLED');
        expect(ran).not.toHaveBeenCalled();
    });

    it('starts the next waiting task when one finishes', async () => {
        const manager = new BackgroundTaskManager({ maxConcurrent: 1 });
        let release!: () => void;
        const first = manager.submit(
            info,
            () => new Promise<void>((resolve) => (release = resolve)),
        );
        const second = manager.submit(info, async () => undefined);
        await vi.advanceTimersByTimeAsync(0);
        expect(manager.get(second)?.state).toBe('PENDING');
        release();
        await manager.settled(first);
        expect(await manager.settled(second)).toMatchObject({ state: 'COMPLETED' });
    });

    it('reports a cancelled task as cancelled even when its runner ignores the signal', async () => {
        const manager = new BackgroundTaskManager({ cancelGraceMs: 1000 });
        const id = manager.submit(info, () => new Promise<void>(() => undefined));
        await vi.advanceTimersByTimeAsync(0);
        manager.cancel(id);
        expect(manager.get(id)?.state).toBe('CANCELLING');
        await vi.advanceTimersByTimeAsync(1001);
        expect(manager.get(id)).toMatchObject({ state: 'CANCELLED' });
    });

    it('pauses and resumes at the runner’s checkpoints', async () => {
        const manager = new BackgroundTaskManager();
        const steps: string[] = [];
        let advance!: () => void;
        const gate = new Promise<void>((resolve) => (advance = resolve));
        const id = manager.submit(info, async (ctx) => {
            steps.push('one');
            await gate;
            await ctx.waitIfPaused();
            steps.push('two');
        });
        await vi.advanceTimersByTimeAsync(0);
        manager.pause(id);
        expect(manager.get(id)?.state).toBe('PAUSED');
        advance();
        await vi.advanceTimersByTimeAsync(10);
        expect(steps).toEqual(['one']);
        manager.resume(id);
        await manager.settled(id);
        expect(steps).toEqual(['one', 'two']);
        expect(manager.get(id)?.state).toBe('COMPLETED');
    });

    it('limits progress snapshots to one per interval, and always delivers the latest numbers', async () => {
        const manager = new BackgroundTaskManager({ minIntervalMs: 250 });
        const snapshots = collect(manager);
        let finish!: () => void;
        const id = manager.submit(info, (ctx) => {
            for (let i = 1; i <= 100_000; i++) ctx.report({ rowsProcessed: i });
            return new Promise<void>((resolve) => (finish = resolve));
        });
        await vi.advanceTimersByTimeAsync(0);
        const quick = snapshots.filter((s) => s.state === 'RUNNING' && s.rowsProcessed > 0);
        expect(quick.length).toBeLessThanOrEqual(1);
        await vi.advanceTimersByTimeAsync(260);
        expect(snapshots.at(-1)!.rowsProcessed).toBe(100_000);
        expect(snapshots.length).toBeLessThan(6);
        finish();
        await manager.settled(id);
    });

    it('computes a percentage from bytes or rows, and keeps issues bounded', async () => {
        const manager = new BackgroundTaskManager({ maxIssues: 2 });
        const id = manager.submit({ ...info, totalBytes: 1000 }, async (ctx) => {
            ctx.report({ bytesProcessed: 250 });
            for (let i = 1; i <= 5; i++) ctx.issue({ record: i, message: `bad ${i}` });
            await new Promise<void>((resolve) => setTimeout(resolve, 1000));
        });
        await vi.advanceTimersByTimeAsync(10);
        const snapshot = manager.get(id)!;
        expect(snapshot.percent).toBe(25);
        expect(snapshot.errorCount).toBe(5);
        expect(snapshot.issues).toHaveLength(2);
        await vi.advanceTimersByTimeAsync(1000);
        expect(manager.get(id)?.percent).toBe(100);
    });

    it('keeps only a bounded number of finished tasks', async () => {
        const manager = new BackgroundTaskManager({ keepFinished: 2 });
        const ids = Array.from({ length: 4 }, () => manager.submit(info, async () => undefined));
        for (const id of ids) await manager.settled(id);
        expect(manager.list().filter((t) => t.state === 'COMPLETED')).toHaveLength(2);
    });

    it('removes only finished tasks', async () => {
        const manager = new BackgroundTaskManager();
        const running = manager.submit(info, () => new Promise<void>(() => undefined));
        await vi.advanceTimersByTimeAsync(0);
        expect(manager.remove(running)).toBe(false);
        const done = manager.submit(info, async () => undefined);
        await manager.settled(done);
        expect(manager.remove(done)).toBe(true);
    });
});
