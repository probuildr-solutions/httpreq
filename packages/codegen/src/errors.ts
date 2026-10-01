/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

/**
 * Thrown by a generator that supports a protocol in general but not this particular request
 * (for example, a CLI client that cannot use WebSockets). The registry turns it into a clear
 * "unsupported" result instead of an error.
 */
export class UnsupportedCombination extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'UnsupportedCombination';
    }
}
