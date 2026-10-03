/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { describe, expect, it } from 'vitest';
import {
    LinePieceTable,
    clampSelection,
    extendSelection,
    isLineSelected,
    linesPerViewport,
    maxTopLine,
    positionFromScroll,
    scrollFromLine,
    selectLine,
    selectionBounds,
    selectionSize,
    spacerHeight,
    visibleRange,
    type ScrollGeometry,
} from './index';

/** The "file": original line i is the text `orig i`. */
const original = (count: number) => Array.from({ length: count }, (_, i) => `orig ${i}`);
const readFrom = (lines: string[]) => async (from: number, count: number) =>
    lines.slice(from, from + count);

const materialize = async (table: LinePieceTable, file: string[]) =>
    table.read(0, table.lineCount, readFrom(file));

describe('LinePieceTable', () => {
    it('starts as the whole original file in one piece', async () => {
        const table = new LinePieceTable(1_000_000);
        expect(table.pieces).toEqual([{ kind: 'original', from: 0, count: 1_000_000 }]);
        expect(table.lineCount).toBe(1_000_000);
        expect(table.dirty).toBe(false);
        expect(table.originalLineAt(500_000)).toBe(500_000);
    });

    it('splits and merges pieces without copying the original text', () => {
        const table = new LinePieceTable(10);
        table.setLine(5, 'changed');
        expect(table.pieces).toEqual([
            { kind: 'original', from: 0, count: 5 },
            { kind: 'added', lines: ['changed'] },
            { kind: 'original', from: 6, count: 4 },
        ]);
        expect(table.originalLineAt(5)).toBeNull();
        expect(table.originalLineAt(6)).toBe(6);
        expect(table.dirty).toBe(true);

        // Deleting the edited line again leaves two original runs that are not contiguous.
        table.delete(5, 1);
        expect(table.pieces).toEqual([
            { kind: 'original', from: 0, count: 5 },
            { kind: 'original', from: 6, count: 4 },
        ]);
        expect(table.lineCount).toBe(9);
    });

    it('matches a plain array under a long random sequence of edits, undo and redo', async () => {
        const file = original(300);
        const table = new LinePieceTable(file.length);
        let model = [...file];
        let state = 99;
        const next = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0);
        const history: string[][] = [[...model]];
        let cursor = 0;

        for (let step = 0; step < 600; step++) {
            const choice = next() % 10;
            if (choice < 6) {
                const from = next() % (model.length + 1);
                const remove = next() % 5;
                const lines = Array.from({ length: next() % 4 }, (_, i) => `new ${step}.${i}`);
                const noop = Math.min(remove, model.length - from) === 0 && lines.length === 0;
                table.splice(from, remove, lines);
                model.splice(from, remove, ...lines);
                if (model.length === 0) model = [''];
                // A splice that changes nothing leaves no undo point.
                if (!noop) {
                    history.length = cursor + 1;
                    history.push([...model]);
                    cursor++;
                }
            } else if (choice < 8 && cursor > 0) {
                expect(table.undo()).toBe(true);
                cursor--;
                model = [...history[cursor]!];
            } else if (cursor < history.length - 1) {
                expect(table.redo()).toBe(true);
                cursor++;
                model = [...history[cursor]!];
            }
            expect(table.lineCount, `step ${step}`).toBe(model.length);
            if (step % 25 === 0)
                expect(await materialize(table, file), `step ${step}`).toEqual(model);
        }
        expect(await materialize(table, file)).toEqual(model);

        // Any window of the document reads back correctly, wherever it falls across pieces.
        for (const [from, count] of [
            [0, 1],
            [7, 50],
            [model.length - 3, 10],
            [model.length, 5],
            [3, 0],
        ] as const) {
            expect(await table.read(from, count, readFrom(file))).toEqual(
                model.slice(from, from + count),
            );
        }
    });

    it('reads each original run once, and never asks the file for added text', async () => {
        const table = new LinePieceTable(100);
        table.insert(50, ['a', 'b']);
        const calls: [number, number][] = [];
        const lines = await table.read(40, 20, async (from, count) => {
            calls.push([from, count]);
            return original(100).slice(from, from + count);
        });
        expect(calls).toEqual([
            [40, 10],
            [50, 8],
        ]);
        expect(lines.slice(10, 12)).toEqual(['a', 'b']);
    });

    it('tracks unsaved changes through save and undo', () => {
        const table = new LinePieceTable(5);
        table.setLine(0, 'x');
        table.markSaved();
        expect(table.dirty).toBe(false);
        table.setLine(1, 'y');
        expect(table.dirty).toBe(true);
        table.undo();
        expect(table.dirty).toBe(false); // back at the saved content
        table.undo();
        expect(table.dirty).toBe(true); // before the saved point
    });

    it('restores saved pieces as one undoable step and refuses ones that do not fit', async () => {
        const table = new LinePieceTable(10);
        table.restore([
            { kind: 'original', from: 0, count: 3 },
            { kind: 'added', lines: ['x'] },
            { kind: 'original', from: 5, count: 5 },
        ]);
        expect(table.lineCount).toBe(9);
        expect(table.dirty).toBe(true);
        expect(await materialize(table, original(10))).toEqual([
            'orig 0',
            'orig 1',
            'orig 2',
            'x',
            'orig 5',
            'orig 6',
            'orig 7',
            'orig 8',
            'orig 9',
        ]);
        table.undo();
        expect(table.lineCount).toBe(10);
        expect(table.dirty).toBe(false);
        expect(() => table.restore([{ kind: 'original', from: 8, count: 5 }])).toThrow(RangeError);
    });

    it('never has zero lines', async () => {
        const table = new LinePieceTable(3);
        table.delete(0, 3);
        expect(table.lineCount).toBe(1);
        expect(await materialize(table, original(3))).toEqual(['']);
        expect(table.undo()).toBe(true);
        expect(table.lineCount).toBe(3);
    });

    it('rejects an out-of-range edit and ignores a no-op', () => {
        const table = new LinePieceTable(3);
        expect(() => table.splice(4, 0, ['x'])).toThrow(RangeError);
        expect(() => table.setLine(3, 'x')).toThrow(RangeError);
        table.splice(1, 0, []);
        expect(table.canUndo).toBe(false);
    });

    it('keeps millions of lines cheap: an edit is a few pieces, not a copy', () => {
        const table = new LinePieceTable(50_000_000);
        table.setLine(25_000_000, 'edited');
        table.insert(10, ['first', 'second']);
        table.delete(40_000_000, 1_000_000);
        expect(table.pieces.length).toBeLessThan(10);
        expect(table.lineCount).toBe(50_000_000 + 2 - 1_000_000);
        const [segment] = table.segments(40_000_000, 3);
        expect(segment).toMatchObject({ kind: 'original' });
    });
});

describe('virtual scrolling', () => {
    const small: ScrollGeometry = { lineCount: 1_000, lineHeight: 20, viewportHeight: 600 };
    const huge: ScrollGeometry = { lineCount: 200_000_000, lineHeight: 20, viewportHeight: 600 };

    it('is exact for a document that fits the spacer', () => {
        expect(spacerHeight(small)).toBe(20_000);
        expect(linesPerViewport(small)).toBe(30);
        expect(positionFromScroll(small, 0)).toEqual({ line: 0, offset: 0 });
        expect(positionFromScroll(small, 105)).toEqual({ line: 5, offset: 5 });
        expect(scrollFromLine(small, 5)).toBe(100);
        // The last screen: scrolled to the very bottom, the first line shown is lineCount - 30.
        expect(positionFromScroll(small, 20_000 - 600).line).toBe(maxTopLine(small));
    });

    it('caps the spacer for a huge document and maps by ratio', () => {
        expect(spacerHeight(huge)).toBe(8_000_000);
        const bottom = spacerHeight(huge) - huge.viewportHeight;
        expect(positionFromScroll(huge, 0).line).toBe(0);
        expect(positionFromScroll(huge, bottom).line).toBe(maxTopLine(huge));
        expect(positionFromScroll(huge, bottom / 2).line).toBeCloseTo(maxTopLine(huge) / 2, -1);
    });

    it('round-trips a line through scroll position, to within a line, at any size', () => {
        for (const g of [small, huge, { ...huge, lineCount: 750_150 }]) {
            for (const line of [0, 1, 12_345, Math.floor(maxTopLine(g) / 2), maxTopLine(g)].filter(
                (line) => line <= maxTopLine(g),
            )) {
                const back = positionFromScroll(g, scrollFromLine(g, line)).line;
                // At 200 M lines an 8 M px bar gives ~25 lines per pixel, so a line is found within that.
                const tolerance = Math.ceil(g.lineCount / (spacerHeight(g) - g.viewportHeight)) + 1;
                expect(
                    Math.abs(back - line),
                    `${g.lineCount} lines, line ${line}`,
                ).toBeLessThanOrEqual(
                    spacerHeight(g) === g.lineCount * g.lineHeight ? 0 : tolerance,
                );
            }
        }
    });

    it('renders a few hundred lines at most, whatever the file size', () => {
        for (const g of [small, huge]) {
            const range = visibleRange(g, 750_000 % g.lineCount);
            expect(range.end - range.first).toBeLessThan(120);
        }
        expect(visibleRange(small, 0)).toEqual({ first: 0, end: 51 });
        expect(visibleRange(small, 995)).toEqual({ first: 975, end: 1000 });
    });

    it('handles a document shorter than the viewport', () => {
        const tiny: ScrollGeometry = { lineCount: 5, lineHeight: 20, viewportHeight: 600 };
        expect(spacerHeight(tiny)).toBe(600);
        expect(maxTopLine(tiny)).toBe(0);
        expect(positionFromScroll(tiny, 50).line).toBe(0);
        expect(scrollFromLine(tiny, 3)).toBe(0);
    });
});

describe('line selection', () => {
    it('extends in either direction and reports its bounds', () => {
        const selection = extendSelection(selectLine(100), 40);
        expect(selectionBounds(selection)).toEqual({ first: 40, last: 100 });
        expect(selectionSize(selection)).toBe(61);
        expect(isLineSelected(selection, 40)).toBe(true);
        expect(isLineSelected(selection, 101)).toBe(false);
        expect(isLineSelected(null, 1)).toBe(false);
    });

    it('is clamped after lines are removed', () => {
        expect(clampSelection({ anchor: 5, head: 90 }, 50)).toEqual({ anchor: 5, head: 49 });
        expect(clampSelection({ anchor: 5, head: 9 }, 0)).toBeNull();
    });
});
