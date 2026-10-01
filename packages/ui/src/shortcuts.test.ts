/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { describe, expect, it } from 'vitest';
import { formatChord, isEditableTarget, matchesChord } from './shortcuts';

const event = (init: Partial<KeyboardEvent>) =>
    ({
        key: '',
        code: '',
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        altKey: false,
        ...init,
    }) as KeyboardEvent;

describe('matchesChord', () => {
    it('maps mod to Ctrl on Windows/Linux and Cmd on macOS', () => {
        const chord = { key: 's', mod: true };
        expect(matchesChord(event({ key: 's', ctrlKey: true }), chord, false)).toBe(true);
        expect(matchesChord(event({ key: 's', metaKey: true }), chord, false)).toBe(false);
        expect(matchesChord(event({ key: 's', metaKey: true }), chord, true)).toBe(true);
        expect(matchesChord(event({ key: 's', ctrlKey: true }), chord, true)).toBe(false);
    });

    it('requires an exact modifier set', () => {
        const chord = { key: 'Enter', mod: true };
        expect(
            matchesChord(event({ key: 'Enter', ctrlKey: true, shiftKey: true }), chord, false),
        ).toBe(false);
        expect(
            matchesChord(
                event({ key: 'Enter', ctrlKey: true, shiftKey: true }),
                { ...chord, shift: true },
                false,
            ),
        ).toBe(true);
    });

    it('uses literal Control for ctrl chords on every platform', () => {
        const chord = { key: 'Tab', ctrl: true };
        expect(matchesChord(event({ key: 'Tab', ctrlKey: true }), chord, true)).toBe(true);
        expect(matchesChord(event({ key: 'Tab', metaKey: true }), chord, true)).toBe(false);
    });

    it('falls back to the physical key code', () => {
        const chord = { key: '1', code: 'Digit1', mod: true };
        expect(matchesChord(event({ key: '&', code: 'Digit1', ctrlKey: true }), chord, false)).toBe(
            true,
        );
    });
});

describe('formatChord', () => {
    it('formats per platform', () => {
        expect(formatChord({ key: 'Enter', mod: true, shift: true }, false)).toBe(
            'Ctrl+Shift+Enter',
        );
        expect(formatChord({ key: 'Enter', mod: true, shift: true }, true)).toBe('⇧⌘↩');
        expect(formatChord({ key: 'w', mod: true }, false)).toBe('Ctrl+W');
    });
});

describe('isEditableTarget', () => {
    it('detects text fields but not buttons or checkboxes', () => {
        const input = document.createElement('input');
        const checkbox = Object.assign(document.createElement('input'), { type: 'checkbox' });
        expect(isEditableTarget(input)).toBe(true);
        expect(isEditableTarget(document.createElement('textarea'))).toBe(true);
        expect(isEditableTarget(checkbox)).toBe(false);
        expect(isEditableTarget(document.createElement('button'))).toBe(false);
    });
});
