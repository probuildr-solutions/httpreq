/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    MAX_JOURNAL_CHARS,
    clearJournal,
    readJournal,
    writeJournal,
    type Journal,
} from './journal';

const file = { size: 100, mtimeMs: 5 };
const pieces: Journal = {
    version: 1,
    kind: 'pieces',
    size: 100,
    mtimeMs: 5,
    eol: '\n',
    pieces: [
        { kind: 'original', from: 0, count: 3 },
        { kind: 'added', lines: ['x'] },
    ],
};

beforeEach(() => localStorage.clear());

describe('journal', () => {
    it('round-trips unsaved work for the same file', () => {
        expect(writeJournal('abc', pieces)).toBe(true);
        expect(readJournal('abc', file)).toEqual(pieces);
        clearJournal('abc');
        expect(readJournal('abc', file)).toBeNull();
    });

    it('is not offered when the file changed, and is dropped', () => {
        writeJournal('abc', pieces);
        expect(readJournal('abc', { size: 101, mtimeMs: 5 })).toBeNull();
        expect(localStorage.length).toBe(0);
        writeJournal('abc', pieces);
        expect(readJournal('abc', { size: 100, mtimeMs: 6 })).toBeNull();
    });

    it('refuses to write a journal over the limit and removes the old one', () => {
        writeJournal('abc', pieces);
        const big: Journal = {
            ...pieces,
            pieces: [{ kind: 'added', lines: ['x'.repeat(MAX_JOURNAL_CHARS)] }],
        };
        expect(writeJournal('abc', big)).toBe(false);
        expect(readJournal('abc', file)).toBeNull();
    });

    it('ignores damaged or foreign data', () => {
        for (const raw of [
            'not json',
            '{"version":2}',
            JSON.stringify({ ...pieces, pieces: [{ kind: 'original' }] }),
            JSON.stringify({ ...pieces, eol: 'x' }),
        ]) {
            localStorage.setItem('httpreq.dbstudio.journal.abc', raw);
            expect(readJournal('abc', file), raw).toBeNull();
        }
    });

    it('survives storage that throws', () => {
        const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new Error('quota');
        });
        expect(writeJournal('abc', pieces)).toBe(false);
        spy.mockRestore();
    });

    it('keeps text journals', () => {
        const text: Journal = {
            version: 1,
            kind: 'text',
            size: 100,
            mtimeMs: 5,
            eol: '\r\n',
            text: 'select 1;',
        };
        writeJournal('t', text);
        expect(readJournal('t', file)).toEqual(text);
    });
});
