/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

/**
 * Structural equality for plain JSON-like data (objects, arrays, primitives).
 *
 * Used where the app used to compare `JSON.stringify` output. Serializing both sides allocates a
 * copy of every string, which for a request with a multi-megabyte body meant megabytes of garbage
 * on each keystroke; this walk stops at the first difference and skips shared references, so an
 * edit to one field of a request costs about as much as that field.
 */
export const deepEqual = (a: unknown, b: unknown): boolean => {
    if (a === b) return true;
    if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
        // NaN is the only value not equal to itself; JSON cannot hold it, but be exact anyway.
        return a !== a && b !== b;
    }
    if (Array.isArray(a)) {
        if (!Array.isArray(b) || a.length !== b.length) return false;
        for (let index = 0; index < a.length; index += 1) {
            if (!deepEqual(a[index], b[index])) return false;
        }
        return true;
    }
    if (Array.isArray(b)) return false;
    const left = a as Record<string, unknown>;
    const right = b as Record<string, unknown>;
    // Keys holding `undefined` are ignored, as they are by JSON.
    const leftKeys = Object.keys(left).filter((key) => left[key] !== undefined);
    const rightKeys = Object.keys(right).filter((key) => right[key] !== undefined);
    if (leftKeys.length !== rightKeys.length) return false;
    for (const key of leftKeys) {
        if (!deepEqual(left[key], right[key])) return false;
    }
    return true;
};
