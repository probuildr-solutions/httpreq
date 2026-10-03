/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

/**
 * A selection of whole lines, stored as two line numbers. It can span millions of lines, which a
 * browser text selection over rendered rows cannot, so copying it reads the text from the
 * document (in batches), not from the screen.
 */
export interface LineSelection {
    /** Where the selection started (where the user first clicked). */
    anchor: number;
    /** Where it was last extended to. */
    head: number;
}

export const selectLine = (line: number): LineSelection => ({ anchor: line, head: line });

export const extendSelection = (selection: LineSelection, line: number): LineSelection => ({
    anchor: selection.anchor,
    head: line,
});

/** First and last selected line, whichever way the selection was dragged. */
export const selectionBounds = (selection: LineSelection): { first: number; last: number } => ({
    first: Math.min(selection.anchor, selection.head),
    last: Math.max(selection.anchor, selection.head),
});

export const selectionSize = (selection: LineSelection): number => {
    const { first, last } = selectionBounds(selection);
    return last - first + 1;
};

export const isLineSelected = (selection: LineSelection | null, line: number): boolean => {
    if (!selection) return false;
    const { first, last } = selectionBounds(selection);
    return line >= first && line <= last;
};

/** Keeps a selection inside a document of `lineCount` lines (after lines were deleted). */
export const clampSelection = (
    selection: LineSelection,
    lineCount: number,
): LineSelection | null => {
    if (lineCount <= 0) return null;
    const max = lineCount - 1;
    return { anchor: Math.min(selection.anchor, max), head: Math.min(selection.head, max) };
};
