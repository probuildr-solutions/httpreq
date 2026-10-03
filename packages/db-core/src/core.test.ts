/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { describe, expect, it } from 'vitest';
import { DbError, isDbErrorInfo, isTerminalJobState, throwIfAborted, toDbError } from './index';

describe('toDbError', () => {
    it('keeps a DbError and revives a serialized one', () => {
        const original = new DbError('TIMEOUT', 'slow');
        expect(toDbError(original)).toBe(original);
        const revived = toDbError(original.toInfo());
        expect(revived).toBeInstanceOf(DbError);
        expect(revived.code).toBe('TIMEOUT');
    });

    it('maps system errors without leaking the path Node puts in the message', () => {
        const missing = Object.assign(
            new Error("ENOENT: no such file, open 'C:\\Users\\a\\x.sql'"),
            {
                code: 'ENOENT',
            },
        );
        const error = toDbError(missing);
        expect(error.code).toBe('NOT_FOUND');
        expect(error.message).not.toContain('Users');
        expect(toDbError(Object.assign(new Error('x'), { code: 'EACCES' })).code).toBe(
            'PERMISSION_DENIED',
        );
        expect(toDbError(Object.assign(new Error('x'), { code: 'EMFILE' })).code).toBe('IO_ERROR');
    });

    it('treats an abort as a cancellation and anything else as internal', () => {
        expect(toDbError(new DOMException('stop', 'AbortError')).code).toBe('CANCELLED');
        expect(toDbError(new Error('boom')).code).toBe('INTERNAL');
    });
});

describe('throwIfAborted', () => {
    it('is silent until the signal fires, then reports the reason it carries', () => {
        const controller = new AbortController();
        expect(() => throwIfAborted(controller.signal)).not.toThrow();
        controller.abort();
        expect(() => throwIfAborted(controller.signal)).toThrow(/cancelled/);
        const timed = new AbortController();
        timed.abort(new DbError('TIMEOUT', 'too slow'));
        expect(() => throwIfAborted(timed.signal)).toThrow(/too slow/);
        expect(() => throwIfAborted(undefined)).not.toThrow();
    });
});

describe('guards', () => {
    it('recognizes serialized errors and terminal job states', () => {
        expect(isDbErrorInfo({ code: 'IO_ERROR', message: 'x' })).toBe(true);
        expect(isDbErrorInfo({ code: 'NOPE', message: 'x' })).toBe(false);
        expect(isDbErrorInfo(null)).toBe(false);
        expect(isTerminalJobState('done')).toBe(true);
        expect(isTerminalJobState('running')).toBe(false);
    });
});
