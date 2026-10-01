/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { describe, expect, it } from 'vitest';
import { parseWindowState, resolveWindowBounds } from './windowState';

const defaults = { width: 1440, height: 920, minWidth: 900, minHeight: 600 };
const screen = { x: 0, y: 0, width: 1920, height: 1080 };

describe('parseWindowState', () => {
    it('accepts a saved state and rounds it', () => {
        expect(
            parseWindowState({ width: 1000.4, height: 700, x: 10, y: 20, maximized: true }),
        ).toEqual({
            width: 1000,
            height: 700,
            x: 10,
            y: 20,
            maximized: true,
        });
    });

    it('rejects malformed data', () => {
        expect(parseWindowState(null)).toBeNull();
        expect(parseWindowState({ width: 'a', height: 5 })).toBeNull();
        expect(parseWindowState({ width: 10, height: 10 })).toBeNull();
    });

    it('treats a missing maximized flag as a normal window', () => {
        expect(parseWindowState({ width: 1000, height: 700 })?.maximized).toBe(false);
    });
});

describe('resolveWindowBounds', () => {
    it('uses the defaults when nothing was saved', () => {
        expect(resolveWindowBounds(null, [screen], defaults)).toEqual({ width: 1440, height: 920 });
    });

    it('restores the saved size and position on a connected display', () => {
        const saved = { width: 1000, height: 700, x: 100, y: 50, maximized: false };
        expect(resolveWindowBounds(saved, [screen], defaults)).toEqual({
            width: 1000,
            height: 700,
            x: 100,
            y: 50,
        });
    });

    it('drops a position that is on a display that is gone, keeping the size', () => {
        const saved = { width: 1000, height: 700, x: 3000, y: 50, maximized: false };
        expect(resolveWindowBounds(saved, [screen], defaults)).toEqual({
            width: 1000,
            height: 700,
        });
    });

    it('never goes below the minimum size', () => {
        const saved = { width: 400, height: 300, x: 0, y: 0, maximized: false };
        expect(resolveWindowBounds(saved, [screen], defaults)).toMatchObject({
            width: 900,
            height: 600,
        });
    });
});
