/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

/**
 * Browsers cannot scroll an element of unlimited height (Chromium stops near 33 million pixels),
 * and a 3 GB file has more lines than that. The editor therefore scrolls a spacer of limited
 * height and maps its scroll position to a line number by ratio. This module is that mapping, free
 * of the DOM so it can be tested exactly.
 */
export interface ScrollGeometry {
    lineCount: number;
    /** Pixels per line. */
    lineHeight: number;
    /** Height of the visible area in pixels. */
    viewportHeight: number;
    /** Tallest spacer to use; defaults to a value every browser supports. */
    maxSpacerHeight?: number;
}

export const DEFAULT_MAX_SPACER_HEIGHT = 8_000_000;

export interface TopPosition {
    /** The first line that is at least partly visible. */
    line: number;
    /** How many pixels of that line are scrolled out of view (0 when scaled). */
    offset: number;
}

const maxSpacer = (g: ScrollGeometry) => g.maxSpacerHeight ?? DEFAULT_MAX_SPACER_HEIGHT;

/** Whole lines that fit in the viewport. */
export const linesPerViewport = (g: ScrollGeometry): number =>
    Math.max(1, Math.floor(g.viewportHeight / g.lineHeight));

/** Height of the spacer that gives the scroll bar its range. */
export const spacerHeight = (g: ScrollGeometry): number =>
    Math.max(g.viewportHeight, Math.min(g.lineCount * g.lineHeight, maxSpacer(g)));

/** Whether one pixel of scrolling is more than one line's worth of movement. */
export const isScaled = (g: ScrollGeometry): boolean => g.lineCount * g.lineHeight > maxSpacer(g);

/** Largest value of the first visible line: the last line sits at the bottom. */
export const maxTopLine = (g: ScrollGeometry): number =>
    Math.max(0, g.lineCount - linesPerViewport(g));

/** The line at the top of the viewport for a scroll position. */
export const positionFromScroll = (g: ScrollGeometry, scrollTop: number): TopPosition => {
    const top = Math.max(0, scrollTop);
    if (!isScaled(g)) {
        const line = Math.min(maxTopLine(g), Math.floor(top / g.lineHeight));
        return {
            line,
            offset: line === Math.floor(top / g.lineHeight) ? top - line * g.lineHeight : 0,
        };
    }
    const scrollable = spacerHeight(g) - g.viewportHeight;
    const ratio = scrollable > 0 ? Math.min(1, top / scrollable) : 0;
    return { line: Math.round(ratio * maxTopLine(g)), offset: 0 };
};

/** The scroll position that puts `line` at the top of the viewport. */
export const scrollFromLine = (g: ScrollGeometry, line: number): number => {
    const clamped = Math.max(0, Math.min(maxTopLine(g), line));
    if (!isScaled(g)) return clamped * g.lineHeight;
    const top = maxTopLine(g);
    const scrollable = spacerHeight(g) - g.viewportHeight;
    return top > 0 ? (clamped / top) * scrollable : 0;
};

export interface VisibleRange {
    /** First line to render (inclusive), including the buffer above. */
    first: number;
    /** One past the last line to render, including the buffer below. */
    end: number;
}

/**
 * The lines to render for a viewport: those visible plus a small buffer either side, so scrolling
 * a little never shows an empty row. The result is a few hundred lines at most, whatever the
 * file's size.
 */
export const visibleRange = (g: ScrollGeometry, topLine: number, buffer = 20): VisibleRange => {
    const visible = Math.ceil(g.viewportHeight / g.lineHeight) + 1;
    return {
        first: Math.max(0, topLine - buffer),
        end: Math.min(g.lineCount, topLine + visible + buffer),
    };
};
