/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { readFileSync, writeFileSync } from 'node:fs';

/**
 * The window's geometry between launches. `bounds` is the restored (non-maximized) rectangle, so a
 * window closed while maximized still comes back to its previous normal size when un-maximized.
 */
export interface SavedWindowState {
    width: number;
    height: number;
    x?: number;
    y?: number;
    maximized: boolean;
}

export interface Rectangle {
    x: number;
    y: number;
    width: number;
    height: number;
}

const isFiniteNumber = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value);

/** Validates untrusted file contents; anything malformed is treated as "nothing saved". */
export const parseWindowState = (value: unknown): SavedWindowState | null => {
    if (!value || typeof value !== 'object') return null;
    const state = value as Record<string, unknown>;
    if (!isFiniteNumber(state.width) || !isFiniteNumber(state.height)) return null;
    if (state.width < 100 || state.height < 100) return null;
    const positioned = isFiniteNumber(state.x) && isFiniteNumber(state.y);
    return {
        width: Math.round(state.width),
        height: Math.round(state.height),
        ...(positioned
            ? { x: Math.round(state.x as number), y: Math.round(state.y as number) }
            : {}),
        maximized: state.maximized === true,
    };
};

/** Reads the saved window geometry, returning null when there is none or the file cannot be
 * trusted.
 */
export const loadWindowState = (file: string): SavedWindowState | null => {
    try {
        return parseWindowState(JSON.parse(readFileSync(file, 'utf8')));
    } catch {
        return null;
    }
};

/** Persists the window geometry. A failure is swallowed: losing a window position is never worth
 * interrupting the app.
 */
export const saveWindowState = (file: string, state: SavedWindowState) => {
    try {
        writeFileSync(file, JSON.stringify(state));
    } catch {
        // Losing the window position is never worth interrupting the app.
    }
};

const intersection = (a: Rectangle, b: Rectangle) =>
    Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
    Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));

/**
 * The bounds to open the window with. A saved position is only used while enough of the window
 * would still be visible on a connected display (a monitor may have been unplugged since); the
 * size is always kept, clamped to the minimum, and the position left to the OS otherwise.
 */
export const resolveWindowBounds = (
    saved: SavedWindowState | null,
    workAreas: readonly Rectangle[],
    defaults: { width: number; height: number; minWidth: number; minHeight: number },
): { width: number; height: number; x?: number; y?: number } => {
    if (!saved) return { width: defaults.width, height: defaults.height };
    const width = Math.max(saved.width, defaults.minWidth);
    const height = Math.max(saved.height, defaults.minHeight);
    if (saved.x === undefined || saved.y === undefined) return { width, height };
    const window = { x: saved.x, y: saved.y, width, height };
    const visible = workAreas.some(
        (area) => intersection(window, area) >= Math.min(width * height * 0.25, 200 * 100),
    );
    return visible ? { width, height, x: saved.x, y: saved.y } : { width, height };
};
