/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { describe, expect, it } from 'vitest';
import { clampRatio, defaultPreferences, parsePreferences } from './preferences';

describe('parsePreferences', () => {
    it('returns defaults for missing or corrupt data', () => {
        expect(parsePreferences(null)).toEqual(defaultPreferences());
        expect(parsePreferences('{not json')).toEqual(defaultPreferences());
        expect(parsePreferences('42')).toEqual(defaultPreferences());
    });

    it('restores stored values and clamps ratios', () => {
        const stored = JSON.stringify({
            responsePosition: 'bottom',
            splitRatio: { right: 0.3, bottom: 5 },
            sidebarVisible: false,
            sidebarWidth: 9999,
            statusBarVisible: false,
            generatedHeadersVisible: false,
        });
        expect(parsePreferences(stored)).toEqual({
            responsePosition: 'bottom',
            splitRatio: { right: 0.3, bottom: 0.9 },
            sidebarVisible: false,
            sidebarWidth: 560,
            statusBarVisible: false,
            generatedHeadersVisible: false,
            zoomLevel: 0,
            codeLanguage: 'curl',
        });
    });

    it('remembers the code generation target, and ignores a malformed one', () => {
        expect(
            parsePreferences(JSON.stringify({ codeLanguage: 'python-requests' })).codeLanguage,
        ).toBe('python-requests');
        expect(parsePreferences(JSON.stringify({ codeLanguage: '<script>' })).codeLanguage).toBe(
            'curl',
        );
        expect(parsePreferences(JSON.stringify({ codeLanguage: 7 })).codeLanguage).toBe('curl');
    });

    it('keeps valid fields and replaces invalid ones', () => {
        const stored = JSON.stringify({ responsePosition: 'left', splitRatio: { right: 'wide' } });
        const parsed = parsePreferences(stored);
        expect(parsed.responsePosition).toBe('right');
        expect(parsed.splitRatio.right).toBe(0.5);
    });
});

describe('clampRatio', () => {
    it('keeps both panes usable', () => {
        expect(clampRatio(0)).toBe(0.1);
        expect(clampRatio(1)).toBe(0.9);
        expect(clampRatio(0.42)).toBe(0.42);
    });
});
