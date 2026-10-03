/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { describe, expect, it } from 'vitest';
import { isDbFileProgress, isDbHostStatus } from './dbstudio';

describe('Database Studio event guards', () => {
    const progress = { fileId: 'a', state: 'indexing', bytesRead: 10, totalBytes: 100, lines: 3 };

    it('accepts well-formed progress and rejects anything else', () => {
        expect(isDbFileProgress(progress)).toBe(true);
        expect(isDbFileProgress({ ...progress, error: { code: 'IO_ERROR', message: 'x' } })).toBe(
            true,
        );
        for (const bad of [
            null,
            'x',
            { ...progress, state: 'done' },
            { ...progress, bytesRead: -1 },
            { ...progress, lines: '3' },
            { ...progress, fileId: 5 },
            { ...progress, error: { code: 1 } },
        ]) {
            expect(isDbFileProgress(bad)).toBe(false);
        }
    });

    it('accepts well-formed host status and rejects anything else', () => {
        expect(isDbHostStatus({ state: 'running', restarts: 0 })).toBe(true);
        expect(isDbHostStatus({ state: 'crashed', restarts: 2, message: 'exit 3' })).toBe(true);
        expect(isDbHostStatus({ state: 'booting', restarts: 0 })).toBe(false);
        expect(isDbHostStatus({ state: 'idle' })).toBe(false);
        expect(isDbHostStatus(undefined)).toBe(false);
    });
});
