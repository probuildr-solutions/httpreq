/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

/**
 * Page zoom for the browser build, matching what the desktop app does with Electron's zoom levels:
 * level 0 is 100%, each step is half a level, and a level multiplies the size by 1.2. A web page
 * cannot change the browser's own zoom, so this scales the app itself with CSS `zoom`; it is
 * independent of (and combines with) the browser's Ctrl +/-.
 */
export const MIN_ZOOM_LEVEL = -3;
export const MAX_ZOOM_LEVEL = 5;
export const ZOOM_STEP = 0.5;

export const clampZoomLevel = (level: number) =>
    Math.min(MAX_ZOOM_LEVEL, Math.max(MIN_ZOOM_LEVEL, level));

export const nextZoomLevel = (current: number, direction: 'in' | 'out' | 'reset') =>
    direction === 'reset'
        ? 0
        : clampZoomLevel(current + (direction === 'in' ? ZOOM_STEP : -ZOOM_STEP));

/** The CSS zoom for a level: each level multiplies the size by 1.2. */
export const zoomFactor = (level: number) => 1.2 ** level;

/**
 * Applies a zoom level to the document. The factor is also published as `--hr-zoom`, because
 * viewport units are not scaled by CSS `zoom`: full-height layouts divide by it.
 */
export const applyWebZoom = (level: number, root: HTMLElement = document.documentElement) => {
    const factor = zoomFactor(level);
    if (level === 0) {
        root.style.removeProperty('zoom');
        root.style.removeProperty('--hr-zoom');
    } else {
        root.style.setProperty('zoom', String(factor));
        root.style.setProperty('--hr-zoom', String(factor));
    }
};
