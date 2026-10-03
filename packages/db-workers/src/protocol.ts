/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import type { DbErrorInfo } from '@httpreq/db-core';

/** Bump when the message shapes change incompatibly; both sides refuse a mismatch. */
export const WORKER_PROTOCOL_VERSION = 1;

/** Supervisor → worker. */
export type ToWorker =
    { t: 'req'; id: number; op: string; payload: unknown } | { t: 'cancel'; id: number };

/** Worker → supervisor. */
export type FromWorker =
    | { t: 'ready'; version: number }
    | { t: 'res'; id: number; ok: true; value: unknown }
    | { t: 'res'; id: number; ok: false; error: DbErrorInfo }
    | { t: 'evt'; topic: string; payload: unknown };

const isRecord = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object';

export const isToWorker = (value: unknown): value is ToWorker => {
    if (!isRecord(value) || typeof value.id !== 'number') return false;
    if (value.t === 'cancel') return true;
    return value.t === 'req' && typeof value.op === 'string';
};

export const isFromWorker = (value: unknown): value is FromWorker => {
    if (!isRecord(value)) return false;
    switch (value.t) {
        case 'ready':
            return typeof value.version === 'number';
        case 'res':
            return typeof value.id === 'number' && typeof value.ok === 'boolean';
        case 'evt':
            return typeof value.topic === 'string';
        default:
            return false;
    }
};

/**
 * One end of a worker connection. Electron's `utilityProcess`, a Node `child_process` and a
 * `MessagePort` all fit this, which is what lets the supervisor be tested without Electron and
 * the transport be swapped without touching it.
 */
export interface WorkerTransport {
    postMessage(message: unknown): void;
    onMessage(listener: (message: unknown) => void): void;
    /** Fires once when the process ends for any reason. */
    onExit(listener: (code: number | null) => void): void;
    kill(): void;
}

export type TransportFactory = () => WorkerTransport;
