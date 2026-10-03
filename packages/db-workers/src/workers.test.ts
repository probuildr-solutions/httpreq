/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

// @vitest-environment node
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
    forkTransport,
    serveWorker,
    WorkerSupervisor,
    type SupervisorOptions,
    type WorkerStatus,
    type WorkerTransport,
} from './index';

const WORKER = fileURLToPath(new URL('./testWorker.mjs', import.meta.url));

const supervisors: WorkerSupervisor[] = [];
const make = (
    options: Partial<SupervisorOptions> = {},
    env: NodeJS.ProcessEnv = {},
): WorkerSupervisor => {
    const supervisor = new WorkerSupervisor({
        name: 'test',
        factory: () => forkTransport(WORKER, { env: { ...process.env, ...env } }),
        restartDelayMs: 10,
        cancelGraceMs: 100,
        readyTimeoutMs: 5_000,
        ...options,
    });
    supervisors.push(supervisor);
    return supervisor;
};

afterEach(async () => {
    await Promise.all(supervisors.splice(0).map((supervisor) => supervisor.stop()));
});

describe('WorkerSupervisor with a real process', () => {
    it('starts on the first request and answers requests', async () => {
        const worker = make();
        expect(worker.status.state).toBe('idle');
        expect(await worker.request('echo', { a: 1 })).toEqual({ a: 1 });
        expect(worker.status.state).toBe('running');
        expect(await worker.request('echo', new Uint8Array([1, 2, 3]))).toEqual(
            new Uint8Array([1, 2, 3]),
        );
    });

    it('delivers a worker error as a typed failure', async () => {
        const worker = make();
        await expect(worker.request('fail', null)).rejects.toMatchObject({ code: 'NOT_FOUND' });
        // The worker is still healthy afterwards.
        expect(await worker.request('echo', 7)).toBe(7);
    });

    it('forwards events to subscribers', async () => {
        const worker = make();
        const seen: unknown[] = [];
        const stop = worker.subscribe((topic, payload) => seen.push([topic, payload]));
        await worker.request('emit', 42);
        stop();
        await worker.request('emit', 43);
        expect(seen).toEqual([['tick', 42]]);
    });

    it('survives the worker dying: the in-flight request fails and the next one works', async () => {
        const statuses: WorkerStatus[] = [];
        const worker = make({ onStatus: (status) => statuses.push(status) });
        const firstPid = await worker.request<number>('pid', null);

        await expect(worker.request('crash', null)).rejects.toMatchObject({
            code: 'WORKER_CRASHED',
        });
        expect(worker.status.state).toBe('crashed');

        const secondPid = await worker.request<number>('pid', null);
        expect(secondPid).not.toBe(firstPid);
        expect(worker.status).toMatchObject({ state: 'running', restarts: 1 });
        expect(statuses.map((status) => status.state)).toEqual(
            expect.arrayContaining(['starting', 'running', 'crashed']),
        );
    });

    it('fails every request that was in flight when it died, not just one', async () => {
        const worker = make();
        await worker.request('echo', 1);
        const hanging = [worker.request('hang', null), worker.request('stubborn', null)];
        const results = hanging.map((request) =>
            expect(request).rejects.toMatchObject({ code: 'WORKER_CRASHED' }),
        );
        await expect(worker.request('crash', null)).rejects.toMatchObject({
            code: 'WORKER_CRASHED',
        });
        await Promise.all(results);
    });

    it('stops restarting a worker that keeps crashing, until reset', async () => {
        const worker = make({ maxCrashes: 2, crashWindowMs: 60_000 });
        for (let i = 0; i < 3; i++) {
            await expect(worker.request('crash', null)).rejects.toMatchObject({
                code: 'WORKER_CRASHED',
            });
        }
        expect(worker.status.state).toBe('failed');
        await expect(worker.request('echo', 1)).rejects.toMatchObject({
            code: 'WORKER_UNAVAILABLE',
        });
        worker.reset();
        expect(await worker.request('echo', 1)).toBe(1);
    }, 20_000);

    it('cancels a request without waiting for the worker', async () => {
        const worker = make();
        const controller = new AbortController();
        const request = worker.request('hang', null, { signal: controller.signal });
        const rejected = expect(request).rejects.toMatchObject({ code: 'CANCELLED' });
        await new Promise((resolve) => setTimeout(resolve, 50)); // let the request reach the worker
        controller.abort();
        await rejected;
        expect(await worker.request('echo', 'still alive')).toBe('still alive');
    });

    it('times a request out', async () => {
        const worker = make();
        await expect(worker.request('stubborn', null, { timeoutMs: 30 })).rejects.toMatchObject({
            code: 'TIMEOUT',
        });
    });

    it('kills a worker that ignores a cancel, then recovers on the next request', async () => {
        const worker = make({ cancelGraceMs: 50 });
        const before = await worker.request<number>('pid', null);
        const controller = new AbortController();
        const request = worker.request('stubborn', null, { signal: controller.signal });
        const rejected = expect(request).rejects.toMatchObject({ code: 'CANCELLED' });
        await new Promise((resolve) => setTimeout(resolve, 50)); // let the request reach the worker
        controller.abort();
        await rejected;
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(worker.status.state).toBe('crashed');
        expect(await worker.request<number>('pid', null)).not.toBe(before);
    });

    it('reports a worker that never becomes ready', async () => {
        const worker = make({ readyTimeoutMs: 100 }, { TEST_WORKER_NEVER_READY: '1' });
        await expect(worker.request('echo', 1)).rejects.toMatchObject({
            code: 'WORKER_UNAVAILABLE',
        });
    });

    it('refuses a worker that speaks another protocol version', async () => {
        const worker = make({}, { TEST_WORKER_VERSION: '99' });
        await expect(worker.request('echo', 1)).rejects.toMatchObject({
            code: 'WORKER_UNAVAILABLE',
        });
    });

    it('does not restart a worker after stop()', async () => {
        const worker = make();
        await worker.request('echo', 1);
        await worker.stop();
        expect(worker.status.state).toBe('stopped');
        await expect(worker.request('echo', 1)).rejects.toMatchObject({
            code: 'WORKER_UNAVAILABLE',
        });
    });

    it('turns a factory that throws into an unavailable worker, not an exception', async () => {
        const worker = make({
            factory: () => {
                throw new Error('spawn failed');
            },
        });
        await expect(worker.request('echo', 1)).rejects.toMatchObject({
            code: 'WORKER_UNAVAILABLE',
        });
    });
});

/** Two connected in-memory ports, to test the server side without a process. */
const pair = (): {
    supervisorSide: WorkerTransport;
    workerSide: Parameters<typeof serveWorker>[0];
} => {
    const toWorker: ((message: unknown) => void)[] = [];
    const toSupervisor: ((message: unknown) => void)[] = [];
    return {
        supervisorSide: {
            postMessage: (message) =>
                queueMicrotask(() => toWorker.forEach((listener) => listener(message))),
            onMessage: (listener) => void toSupervisor.push(listener),
            onExit: () => undefined,
            kill: () => undefined,
        },
        workerSide: {
            postMessage: (message) =>
                queueMicrotask(() => toSupervisor.forEach((listener) => listener(message))),
            onMessage: (listener) => void toWorker.push(listener),
        },
    };
};

describe('serveWorker', () => {
    it('answers requests, turns a throwing handler into a failed request and honors cancel', async () => {
        const { supervisorSide, workerSide } = pair();
        let sawAbort = false;
        serveWorker(workerSide, async (op, payload, { signal, emit }) => {
            if (op === 'add') return (payload as number[]).reduce((a, b) => a + b, 0);
            if (op === 'boom') throw new Error('handler bug with C:\\secret\\path');
            if (op === 'progress') {
                emit('p', 50);
                return 'done';
            }
            if (op === 'wait') {
                await new Promise<void>((resolve) =>
                    signal.addEventListener('abort', () => {
                        sawAbort = true;
                        resolve();
                    }),
                );
                return 'aborted';
            }
            return null;
        });
        const supervisor = new WorkerSupervisor({ name: 'memory', factory: () => supervisorSide });
        const events: unknown[] = [];
        supervisor.subscribe((topic, payload) => events.push([topic, payload]));

        expect(await supervisor.request('add', [1, 2, 3])).toBe(6);
        await expect(supervisor.request('boom', null)).rejects.toMatchObject({ code: 'INTERNAL' });
        expect(await supervisor.request('progress', null)).toBe('done');
        expect(events).toEqual([['p', 50]]);

        const controller = new AbortController();
        const waiting = supervisor.request('wait', null, { signal: controller.signal });
        const rejected = expect(waiting).rejects.toMatchObject({ code: 'CANCELLED' });
        await new Promise((resolve) => setTimeout(resolve, 5));
        controller.abort();
        await rejected;
        await new Promise((resolve) => setTimeout(resolve, 5));
        expect(sawAbort).toBe(true);
    });

    it('does not leak the message of an unexpected error', async () => {
        const { supervisorSide, workerSide } = pair();
        serveWorker(workerSide, async () => {
            throw new Error('password=hunter2 in C:\\Users\\me\\x');
        });
        const supervisor = new WorkerSupervisor({ name: 'memory', factory: () => supervisorSide });
        const error = (await supervisor.request('x', null).catch((e: unknown) => e)) as Error;
        expect(error.message).not.toContain('hunter2');
        expect(error.message).not.toContain('Users');
    });
});
