/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { toDbError } from '@httpreq/db-core';
import { isToWorker, WORKER_PROTOCOL_VERSION, type FromWorker } from './protocol';

/** The worker's side of a connection: where it receives requests and sends answers. */
export interface WorkerPort {
    postMessage(message: unknown): void;
    onMessage(listener: (message: unknown) => void): void;
}

export interface RequestContext {
    /** Fires when the supervisor cancels this request. */
    signal: AbortSignal;
    /** Pushes an event (progress, a result page) to the supervisor's subscribers. */
    emit: (topic: string, payload: unknown) => void;
}

export type RequestHandler = (
    op: string,
    payload: unknown,
    context: RequestContext,
) => Promise<unknown>;

/**
 * Runs inside a worker: answers each request through `handler`, keeps one `AbortController` per
 * request so a cancel reaches the handler, and turns every thrown value into a serializable error
 * so a bug in a handler becomes a failed request, not a dead worker.
 */
export const serveWorker = (port: WorkerPort, handler: RequestHandler): void => {
    const send = (message: FromWorker) => port.postMessage(message);
    const running = new Map<number, AbortController>();
    const emit = (topic: string, payload: unknown) => send({ t: 'evt', topic, payload });

    port.onMessage((message) => {
        if (!isToWorker(message)) return;
        if (message.t === 'cancel') {
            running.get(message.id)?.abort();
            return;
        }
        const controller = new AbortController();
        running.set(message.id, controller);
        const { id, op, payload } = message;
        Promise.resolve()
            .then(() => handler(op, payload, { signal: controller.signal, emit }))
            .then(
                (value) => send({ t: 'res', id, ok: true, value }),
                (error: unknown) =>
                    send({ t: 'res', id, ok: false, error: toDbError(error).toInfo() }),
            )
            .finally(() => running.delete(id));
    });

    send({ t: 'ready', version: WORKER_PROTOCOL_VERSION });
};
