/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { fork } from 'node:child_process';
import type { WorkerTransport } from './protocol';

export interface ForkOptions {
    /** V8 old-space limit for the worker, in MiB: a runaway parser dies instead of the machine. */
    maxOldSpaceMb?: number;
    /** Extra arguments for the Node runtime. */
    execArgv?: string[];
    env?: NodeJS.ProcessEnv;
}

/**
 * A worker as a separate Node process. Electron's `utilityProcess` offers the same shape and is
 * what the desktop app uses; this one runs anywhere Node does, which is how the supervisor's
 * crash handling is tested against a real process dying.
 *
 * Messages use structured clone ("advanced" serialization), so `Uint8Array` payloads cross
 * without being turned into JSON.
 */
export const forkTransport = (modulePath: string, options: ForkOptions = {}): WorkerTransport => {
    const execArgv = [...(options.execArgv ?? [])];
    if (options.maxOldSpaceMb) execArgv.push(`--max-old-space-size=${options.maxOldSpaceMb}`);
    const child = fork(modulePath, [], {
        serialization: 'advanced',
        execArgv,
        env: options.env ?? process.env,
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    let exited = false;
    const exitListeners: ((code: number | null) => void)[] = [];
    const notify = (code: number | null) => {
        if (exited) return;
        exited = true;
        for (const listener of exitListeners) listener(code);
    };
    child.on('exit', (code) => notify(code));
    // A process that could not be spawned never emits "exit".
    child.on('error', () => notify(null));
    return {
        postMessage: (message) => {
            if (child.connected) child.send(message as never);
        },
        onMessage: (listener) => void child.on('message', listener),
        onExit: (listener) => {
            if (exited) listener(null);
            else exitListeners.push(listener);
        },
        kill: () => void child.kill('SIGKILL'),
    };
};
