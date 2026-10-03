/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { describe, expect, it } from 'vitest';
import { RangeIndex } from './rangeIndex';

describe('RangeIndex', () => {
    /** Entries with irregular gaps and lengths, past several checkpoints and one page. */
    const build = (count: number) => {
        const index = new RangeIndex();
        const expected: { start: number; end: number; flags: number }[] = [];
        let at = 5;
        for (let i = 0; i < count; i++) {
            const start = at + (i % 7 === 0 ? 3 : 0);
            const end = start + 1 + ((i * 31) % 90);
            index.add(start, end, i % 5);
            expected.push({ start, end, flags: i % 5 });
            at = end;
        }
        return { index, expected };
    };

    it('returns every entry exactly as it was added', () => {
        const { index, expected } = build(70_000);
        expect(index.count).toBe(70_000);
        for (const i of [0, 1, 1_023, 1_024, 1_025, 5_000, 65_535, 65_536, 69_999]) {
            expect(index.get(i), `entry ${i}`).toEqual(expected[i]);
        }
        expect(index.get(-1)).toBeUndefined();
        expect(index.get(70_000)).toBeUndefined();
        expect(index.coveredBytes).toBe(expected.at(-1)!.end);
    });

    it('finds the entry that contains an offset, or the next one when it falls in a gap', () => {
        const { index, expected } = build(5_000);
        for (const i of [0, 3, 1_023, 1_024, 2_500, 4_999]) {
            const entry = expected[i]!;
            expect(index.indexAt(entry.start), `start of ${i}`).toBe(i);
            expect(index.indexAt(entry.end - 1), `end of ${i}`).toBe(i);
        }
        // Offsets 0..4 precede the first entry.
        expect(index.indexAt(0)).toBe(0);
        // A gap (entry 7 starts 3 bytes after entry 6 ends).
        expect(index.indexAt(expected[6]!.end + 1)).toBe(7);
        expect(index.indexAt(index.coveredBytes)).toBe(-1);
        expect(new RangeIndex().indexAt(0)).toBe(-1);
    });

    it('rejects out-of-order and oversized entries', () => {
        const index = new RangeIndex();
        index.add(10, 20);
        expect(() => index.add(5, 8)).toThrow(/file order/);
        expect(() => index.add(20, 10)).toThrow(/file order/);
        expect(() => index.add(20, 20 + 2 ** 32)).toThrow(/4 GiB/);
    });

    it('stays small: about nine bytes an entry', () => {
        const { index } = build(262_144);
        expect(index.bytes / index.count).toBeLessThan(9.1);
    });
});
