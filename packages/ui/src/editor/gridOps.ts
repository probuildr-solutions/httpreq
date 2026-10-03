/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

/** Pure list operations behind the editable grid's row actions. None mutates its input. */

/** Moves the row at `from` to `to` (clamped), shifting the rows between. */
export const moveRow = <T>(rows: readonly T[], from: number, to: number): T[] => {
    if (from < 0 || from >= rows.length) return [...rows];
    const target = Math.max(0, Math.min(rows.length - 1, to));
    if (target === from) return [...rows];
    const next = [...rows];
    const [row] = next.splice(from, 1);
    next.splice(target, 0, row!);
    return next;
};

/** Inserts `copy` right after the row at `index`. */
export const insertAfter = <T>(rows: readonly T[], index: number, copy: T): T[] => {
    const next = [...rows];
    next.splice(index + 1, 0, copy);
    return next;
};

export const removeAt = <T>(rows: readonly T[], index: number): T[] =>
    rows.filter((_, position) => position !== index);

export const replaceAt = <T>(rows: readonly T[], index: number, patch: Partial<T>): T[] =>
    rows.map((row, position) => (position === index ? { ...row, ...patch } : row));

/** The least width a grid track needs, in pixels: `minmax(120px, 1fr)` is 120, `84px` is 84. */
export const minTrack = (width: string): number => {
    const match = /^(?:minmax\(\s*)?(\d+(?:\.\d+)?)px/.exec(width.trim());
    return match ? Number(match[1]) : 0;
};
