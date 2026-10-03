/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

// A tiny real worker process for the supervisor tests. It speaks the wire protocol directly (plain
// JavaScript, so Node can run it without a build) and misbehaves on request: `crash` exits the
// process, `hang` never answers, and `stubborn` ignores cancellation.

const send = (message) => process.send(message);
const aborted = new Set();

process.on('message', (message) => {
    if (message.t === 'cancel') {
        aborted.add(message.id);
        return;
    }
    const { id, op, payload } = message;
    switch (op) {
        case 'echo':
            send({ t: 'res', id, ok: true, value: payload });
            break;
        case 'pid':
            send({ t: 'res', id, ok: true, value: process.pid });
            break;
        case 'emit':
            send({ t: 'evt', topic: 'tick', payload });
            send({ t: 'res', id, ok: true, value: null });
            break;
        case 'fail':
            send({ t: 'res', id, ok: false, error: { code: 'NOT_FOUND', message: 'nope' } });
            break;
        case 'crash':
            process.exit(3);
            break;
        case 'hang':
            // Answers only once cancelled, like a cooperative handler.
            {
                const timer = setInterval(() => {
                    if (aborted.has(id)) {
                        clearInterval(timer);
                        send({
                            t: 'res',
                            id,
                            ok: false,
                            error: { code: 'CANCELLED', message: 'stopped' },
                        });
                    }
                }, 5);
            }
            break;
        case 'stubborn':
            // Never answers and ignores the cancel: the supervisor has to kill the process.
            break;
        default:
            send({ t: 'res', id, ok: false, error: { code: 'UNSUPPORTED', message: op } });
    }
});

if (process.env.TEST_WORKER_VERSION) {
    send({ t: 'ready', version: Number(process.env.TEST_WORKER_VERSION) });
} else if (process.env.TEST_WORKER_NEVER_READY !== '1') {
    send({ t: 'ready', version: 1 });
}
