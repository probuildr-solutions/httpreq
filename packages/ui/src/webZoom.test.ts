/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { describe, expect, it } from 'vitest';
import { applyWebZoom, MAX_ZOOM_LEVEL, MIN_ZOOM_LEVEL, nextZoomLevel, zoomFactor } from './webZoom';

describe('web zoom', () => {
    it('steps by half a level, like the desktop app, and stays within its limits', () => {
        expect(nextZoomLevel(0, 'in')).toBe(0.5);
        expect(nextZoomLevel(0, 'out')).toBe(-0.5);
        expect(nextZoomLevel(MAX_ZOOM_LEVEL, 'in')).toBe(MAX_ZOOM_LEVEL);
        expect(nextZoomLevel(MIN_ZOOM_LEVEL, 'out')).toBe(MIN_ZOOM_LEVEL);
        expect(nextZoomLevel(3, 'reset')).toBe(0);
    });

    it('uses the same 1.2 factor per level as Electron', () => {
        expect(zoomFactor(0)).toBe(1);
        expect(zoomFactor(1)).toBeCloseTo(1.2);
    });

    it('applies the factor and clears it again at 100%', () => {
        const root = document.createElement('div');
        applyWebZoom(1, root);
        expect(root.style.getPropertyValue('--hr-zoom')).toBe(String(zoomFactor(1)));
        applyWebZoom(0, root);
        expect(root.style.getPropertyValue('--hr-zoom')).toBe('');
    });
});
