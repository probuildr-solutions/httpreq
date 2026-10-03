/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { DbError, toDbError } from '@httpreq/db-core';
import {
    isFromWorker,
    WORKER_PROTOCOL_VERSION,
    type FromWorker,
    type ToWorker,
    type TransportFactory,
    type WorkerTransport,
} from './protocol';

export type WorkerState = 'idle' | 'starting' | 'running' | 'crashed' | 'failed' | 'stopped';

export interface WorkerStatus {
    state: WorkerState;
    /** Times the worker has been started again after a crash. */
    restarts: number;
    message?: string;
}

export interface SupervisorOptions {
    /** For messages and diagnostics. */
    name: string;
    factory: TransportFactory;
    /** How long a new worker has to say it is ready. */
    readyTimeoutMs?: number;
    /** More crashes than this within `crashWindowMs` stops restarting until `reset()`. */
    maxCrashes?: number;
    crashWindowMs?: number;
    /** Wait before restarting; multiplied by the recent crash count, capped at 5 s. */
    restartDelayMs?: number;
    /** After a cancel, how long a worker may keep working before it is killed. */
    cancelGraceMs?: number;
    onStatus?: (status: WorkerStatus) => void;
}

export interface RequestOptions {
    signal?: AbortSignal;
    timeoutMs?: number;
}

interface Pending {
    resolve: (value: unknown) => void;
    reject: (error: unknown) => void;
    /** The caller has already been answered (cancelled or timed out); only cleanup remains. */
    settled: boolean;
    cleanup: () => void;
    graceTimer?: ReturnType<typeof setTimeout>;
}

interface Running {
    transport: WorkerTransport;
    ready: Promise<void>;
    pending: Map<number, Pending>;
    exited: boolean;
}

/**
 * Owns one worker process: starts it on demand, correlates requests with answers, and keeps the
 * rest of the application alive when it dies.
 *
 * The failure policy is the point of this class. When the worker exits unexpectedly every request
 * in flight is rejected with `WORKER_CRASHED` (never left hanging), the next request starts a
 * fresh worker after a short back-off, and a worker that keeps crashing is marked `failed` and
 * stops being restarted, so a corrupt file that kills the process on every open cannot spin
 * forever. A cancelled request that the worker ignores gets the process killed after a grace
 * period, since cooperative cancellation cannot be trusted with hostile input.
 */
export class WorkerSupervisor {
    private running: Running | undefined;
    private starting: Promise<Running> | undefined;
    private nextId = 1;
    private restarts = 0;
    private crashTimes: number[] = [];
    private state: WorkerState = 'idle';
    private message: string | undefined;
    private everStarted = false;
    private readonly listeners = new Set<(topic: string, payload: unknown) => void>();

    constructor(private readonly options: SupervisorOptions) {}

    get status(): WorkerStatus {
        return {
            state: this.state,
            restarts: this.restarts,
            ...(this.message ? { message: this.message } : {}),
        };
    }

    /** Receives every event the worker emits. Returns the unsubscribe function. */
    subscribe(listener: (topic: string, payload: unknown) => void): () => void {
        this.listeners.add(listener);
        return () => void this.listeners.delete(listener);
    }

    async request<T = unknown>(
        op: string,
        payload: unknown,
        options: RequestOptions = {},
    ): Promise<T> {
        const running = await this.ensure();
        if (options.signal?.aborted) throw new DbError('CANCELLED', 'The operation was cancelled.');
        const id = this.nextId++;
        return new Promise<T>((resolve, reject) => {
            const timers: ReturnType<typeof setTimeout>[] = [];
            const entry: Pending = {
                resolve: resolve as (value: unknown) => void,
                reject,
                settled: false,
                cleanup: () => {
                    for (const timer of timers) clearTimeout(timer);
                    options.signal?.removeEventListener('abort', onAbort);
                },
            };
            const abandon = (error: DbError) => {
                if (entry.settled) return;
                entry.settled = true;
                entry.cleanup();
                reject(error);
                this.send(running, { t: 'cancel', id });
                // The entry stays until the worker answers or exits, so a late answer is dropped
                // and the process is killed if it never reacts to the cancel.
                entry.graceTimer = setTimeout(() => {
                    if (running.pending.has(id))
                        this.kill(running, 'did not stop after being cancelled');
                }, this.options.cancelGraceMs ?? 5_000);
            };
            const onAbort = () => abandon(new DbError('CANCELLED', 'The operation was cancelled.'));
            options.signal?.addEventListener('abort', onAbort, { once: true });
            if (options.timeoutMs) {
                timers.push(
                    setTimeout(
                        () => abandon(new DbError('TIMEOUT', 'The operation timed out.')),
                        options.timeoutMs,
                    ),
                );
            }
            running.pending.set(id, entry);
            this.send(running, { t: 'req', id, op, payload });
        });
    }

    /** Allows restarting after the worker was marked `failed`. */
    reset(): void {
        this.crashTimes = [];
        if (this.state === 'failed' || this.state === 'crashed') this.setState('idle');
    }

    /** Ends the worker for good: used at application quit and when a window goes away. */
    async stop(): Promise<void> {
        this.setState('stopped');
        const running = this.running ?? (await this.starting?.catch(() => undefined));
        if (running && !running.exited) {
            this.failPending(running, new DbError('CANCELLED', 'The worker was stopped.'));
            running.transport.kill();
        }
    }

    private async ensure(): Promise<Running> {
        if (this.state === 'stopped') {
            throw new DbError('WORKER_UNAVAILABLE', `The ${this.options.name} worker is stopped.`);
        }
        if (this.state === 'failed') {
            throw new DbError(
                'WORKER_UNAVAILABLE',
                `The ${this.options.name} worker keeps crashing and was not restarted.`,
            );
        }
        if (this.running && !this.running.exited) {
            await this.running.ready;
            return this.running;
        }
        this.starting ??= this.start().finally(() => (this.starting = undefined));
        return this.starting;
    }

    private async start(): Promise<Running> {
        const recent = this.recentCrashes();
        const delay = Math.min(5_000, (this.options.restartDelayMs ?? 200) * recent);
        if (recent > 0 && delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
        if (this.state === 'stopped') {
            throw new DbError('WORKER_UNAVAILABLE', `The ${this.options.name} worker is stopped.`);
        }

        this.setState('starting');
        if (this.everStarted) this.restarts++;
        this.everStarted = true;

        let transport: WorkerTransport;
        try {
            transport = this.options.factory();
        } catch (error) {
            this.recordCrash(`could not start: ${toDbError(error).message}`);
            throw new DbError(
                'WORKER_UNAVAILABLE',
                `The ${this.options.name} worker could not be started.`,
            );
        }

        const running: Running = {
            transport,
            ready: undefined as unknown as Promise<void>,
            pending: new Map(),
            exited: false,
        };
        running.ready = new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
                reject(
                    new DbError(
                        'WORKER_UNAVAILABLE',
                        `The ${this.options.name} worker did not start in time.`,
                    ),
                );
                this.kill(running, 'did not become ready');
            }, this.options.readyTimeoutMs ?? 10_000);

            transport.onMessage((message) => {
                if (!isFromWorker(message)) return;
                switch (message.t) {
                    case 'ready':
                        clearTimeout(timer);
                        if (message.version !== WORKER_PROTOCOL_VERSION) {
                            reject(
                                new DbError(
                                    'WORKER_UNAVAILABLE',
                                    'The worker speaks a different protocol version.',
                                ),
                            );
                            this.kill(running, 'protocol version mismatch');
                            return;
                        }
                        this.running = running;
                        this.setState('running');
                        resolve();
                        return;
                    case 'res':
                        this.settle(running, message);
                        return;
                    case 'evt':
                        for (const listener of this.listeners)
                            listener(message.topic, message.payload);
                        return;
                }
            });
            transport.onExit((code) => {
                clearTimeout(timer);
                running.exited = true;
                if (this.running === running) this.running = undefined;
                const crashed = this.state !== 'stopped';
                this.failPending(
                    running,
                    new DbError(
                        'WORKER_CRASHED',
                        `The ${this.options.name} worker stopped unexpectedly (exit code ${code ?? 'unknown'}).`,
                    ),
                );
                reject(
                    new DbError(
                        'WORKER_UNAVAILABLE',
                        `The ${this.options.name} worker exited while starting.`,
                    ),
                );
                if (crashed) this.recordCrash(`exited with code ${code ?? 'unknown'}`);
            });
        });
        // Avoid an unhandled rejection when nobody is awaiting `ready` any more.
        running.ready.catch(() => undefined);

        await running.ready;
        return running;
    }

    private settle(running: Running, message: Extract<FromWorker, { t: 'res' }>): void {
        const entry = running.pending.get(message.id);
        if (!entry) return;
        running.pending.delete(message.id);
        clearTimeout(entry.graceTimer);
        if (entry.settled) return;
        entry.settled = true;
        entry.cleanup();
        if (message.ok) entry.resolve(message.value);
        else entry.reject(toDbError(message.error));
    }

    private failPending(running: Running, error: DbError): void {
        for (const entry of running.pending.values()) {
            clearTimeout(entry.graceTimer);
            if (entry.settled) continue;
            entry.settled = true;
            entry.cleanup();
            entry.reject(error);
        }
        running.pending.clear();
    }

    private send(running: Running, message: ToWorker): void {
        try {
            running.transport.postMessage(message);
        } catch {
            // The process is gone; the exit handler fails whatever is pending.
        }
    }

    private kill(running: Running, reason: string): void {
        this.message = reason;
        running.transport.kill();
    }

    private recentCrashes(): number {
        const cutoff = Date.now() - (this.options.crashWindowMs ?? 60_000);
        this.crashTimes = this.crashTimes.filter((time) => time >= cutoff);
        return this.crashTimes.length;
    }

    private recordCrash(message: string): void {
        this.crashTimes.push(Date.now());
        this.message = message;
        this.setState(this.recentCrashes() > (this.options.maxCrashes ?? 5) ? 'failed' : 'crashed');
    }

    private setState(state: WorkerState): void {
        if (this.state === 'stopped' && state !== 'stopped') return;
        this.state = state;
        if (state === 'running') this.message = undefined;
        this.options.onStatus?.(this.status);
    }
}
