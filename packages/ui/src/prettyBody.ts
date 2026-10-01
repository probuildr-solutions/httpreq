/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { prettyText, type PrettyKind, type PrettyResult } from './prettyText';

/**
 * Bodies from this size up are formatted in a worker. Parsing and re-serializing a 25 MB response
 * blocked the UI thread for about 190 ms; small bodies format in well under a frame, where posting
 * them to a worker would cost more than it saves.
 */
export const WORKER_FORMAT_THRESHOLD = 256 * 1024;

type Pending = { text: string; kind: PrettyKind; resolve: (result: PrettyResult) => void };

let worker: Worker | null | undefined;
let nextId = 0;
const pending = new Map<number, Pending>();

/** Settles everything still waiting on the main thread, when the worker cannot be used. */
const drain = () => {
    for (const job of pending.values()) job.resolve(prettyText(job.text, job.kind));
    pending.clear();
};

const formatter = (): Worker | null => {
    if (worker !== undefined) return worker;
    try {
        worker =
            typeof Worker === 'undefined'
                ? null
                : new Worker(new URL('./prettyText.worker.ts', import.meta.url), {
                      type: 'module',
                  });
    } catch {
        worker = null;
    }
    worker?.addEventListener(
        'message',
        (event: MessageEvent<{ id: number; result: PrettyResult }>) => {
            const job = pending.get(event.data.id);
            pending.delete(event.data.id);
            job?.resolve(event.data.result);
        },
    );
    worker?.addEventListener('error', () => {
        // A worker that fails to load (a strict CSP, an old runtime) is not retried.
        worker?.terminate();
        worker = null;
        drain();
    });
    return worker;
};

/** Indented JSON or XML, formatted off the UI thread when the body is large. */
export const prettyBody = (text: string, kind: PrettyKind): Promise<PrettyResult> => {
    if (text.length < WORKER_FORMAT_THRESHOLD) return Promise.resolve(prettyText(text, kind));
    const target = formatter();
    if (!target) return Promise.resolve(prettyText(text, kind));
    return new Promise((resolve) => {
        const id = nextId++;
        pending.set(id, { text, kind, resolve });
        target.postMessage({ id, text, kind });
    });
};
