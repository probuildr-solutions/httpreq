/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { describe, expect, it } from 'vitest';
import { insertAfter, minTrack, moveRow, removeAt, replaceAt } from './gridOps';

describe('grid row operations', () => {
    const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

    it('moves a row without changing the input', () => {
        expect(moveRow(rows, 0, 1).map((r) => r.id)).toEqual(['b', 'a', 'c']);
        expect(moveRow(rows, 2, 0).map((r) => r.id)).toEqual(['c', 'a', 'b']);
        expect(rows.map((r) => r.id)).toEqual(['a', 'b', 'c']);
    });

    it('clamps a move and ignores a missing row', () => {
        expect(moveRow(rows, 0, -5).map((r) => r.id)).toEqual(['a', 'b', 'c']);
        expect(moveRow(rows, 1, 99).map((r) => r.id)).toEqual(['a', 'c', 'b']);
        expect(moveRow(rows, 7, 0)).toEqual(rows);
    });

    it('inserts after, removes and patches by position', () => {
        expect(insertAfter(rows, 0, { id: 'x' }).map((r) => r.id)).toEqual(['a', 'x', 'b', 'c']);
        expect(removeAt(rows, 1).map((r) => r.id)).toEqual(['a', 'c']);
        expect(
            replaceAt(
                [
                    { id: 'a', n: 1 },
                    { id: 'b', n: 2 },
                ],
                1,
                { n: 9 },
            ),
        ).toEqual([
            { id: 'a', n: 1 },
            { id: 'b', n: 9 },
        ]);
    });
});

describe('minTrack', () => {
    it('reads the least width of a grid track', () => {
        expect(minTrack('minmax(120px, 1fr)')).toBe(120);
        expect(minTrack('84px')).toBe(84);
        expect(minTrack('minmax(90px, 0.8fr)')).toBe(90);
        expect(minTrack('auto')).toBe(0);
        expect(minTrack('1fr')).toBe(0);
    });
});
