/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
    DEFAULT_LIMITS,
    HOST_TEXT_CEILING_BYTES,
    handlingFor,
    largeFileLimits,
    resetLargeFileLimits,
    setLargeFileLimits,
} from './largeFile';

afterEach(() => resetLargeFileLimits());
const MIB = 1024 * 1024;

describe('large file handling', () => {
    it('decides from the size alone', () => {
        expect(handlingFor(10)).toBe('editor');
        expect(handlingFor(DEFAULT_LIMITS.normalMaxBytes)).toBe('editor');
        expect(handlingFor(DEFAULT_LIMITS.normalMaxBytes + 1)).toBe('large-file-mode');
        expect(handlingFor(DEFAULT_LIMITS.monacoMaxBytes)).toBe('large-file-mode');
        expect(handlingFor(DEFAULT_LIMITS.monacoMaxBytes + 1)).toBe('stream');
        expect(handlingFor(2 * 1024 * MIB)).toBe('stream');
    });

    it('can be configured, and is remembered', () => {
        setLargeFileLimits({ normalMaxBytes: 512 * 1024, monacoMaxBytes: 4 * MIB });
        expect(largeFileLimits()).toEqual({ normalMaxBytes: 512 * 1024, monacoMaxBytes: 4 * MIB });
        expect(handlingFor(MIB)).toBe('large-file-mode');
        expect(JSON.parse(localStorage.getItem('httpreq.dbstudio.largeFileLimits')!)).toMatchObject(
            { monacoMaxBytes: 4 * MIB },
        );
    });

    it('never allows more than the host hands to a window, or an inverted pair', () => {
        setLargeFileLimits({ monacoMaxBytes: 2048 * MIB });
        expect(largeFileLimits().monacoMaxBytes).toBe(HOST_TEXT_CEILING_BYTES);
        setLargeFileLimits({ normalMaxBytes: 500 * MIB });
        expect(largeFileLimits().normalMaxBytes).toBeLessThanOrEqual(
            largeFileLimits().monacoMaxBytes,
        );
        setLargeFileLimits({ monacoMaxBytes: 1 });
        expect(largeFileLimits().monacoMaxBytes).toBe(MIB);
    });

    it('ignores saved values that are not numbers', () => {
        localStorage.setItem(
            'httpreq.dbstudio.largeFileLimits',
            '{"normalMaxBytes":"x","monacoMaxBytes":null}',
        );
        resetLargeFileLimits();
        localStorage.setItem('httpreq.dbstudio.largeFileLimits', 'not json');
        expect(largeFileLimits()).toEqual(DEFAULT_LIMITS);
    });
});
