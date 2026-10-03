/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { setFlagsFromString } from 'node:v8';
import { serveWorker } from '@httpreq/db-workers';
import { FileHostService, IndexStore } from '@httpreq/file-engine';

/**
 * Entry point of the File Host: an Electron utility process, separate from the app's main process,
 * that opens, indexes and reads user files. Hostile or corrupt input can exhaust its memory or
 * crash it, and the app only sees a failed job (see `WorkerSupervisor`): the main process and the
 * windows are untouched.
 *
 * It has no access to the renderer. The main process spawns it, sends it requests and relays the
 * answers; the only setting it is given is the folder for its index cache.
 */

// Let V8 fall back to its linear-time regular expression engine when a pattern backtracks
// excessively, so a pathological pattern such as (a+)+$ cannot stall a search. Patterns it cannot
// handle (back-references, look-around) are still backtracking, which a cancel ends by killing
// this process.
setFlagsFromString('--enable-experimental-regexp-engine-on-excessive-backtracks');

const port = process.parentPort;
if (!port) throw new Error('The file host must be started as an Electron utility process.');

const cacheDirectory = process.env.HTTPREQ_INDEX_DIR;
const host = new FileHostService({
    indexStore: cacheDirectory ? new IndexStore(cacheDirectory) : undefined,
});

serveWorker(
    {
        postMessage: (message) => port.postMessage(message),
        onMessage: (listener) => port.on('message', (event) => listener(event.data)),
    },
    (op, payload, context) => host.handle(op, payload, context),
);

// A failure nobody handled leaves the process in an unknown state: exit and let the supervisor
// start a clean one rather than limp on.
process.on('uncaughtException', () => process.exit(1));
process.on('unhandledRejection', () => process.exit(1));
