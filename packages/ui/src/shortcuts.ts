/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

/**
 * A key combination. `mod` is Cmd on macOS and Ctrl elsewhere; `ctrl` is the literal Control key
 * on every platform (used where macOS reserves Cmd, e.g. Ctrl+Tab since Cmd+Tab switches apps).
 */
export interface KeyChord {
    /** `KeyboardEvent.key` value, compared case-insensitively. */
    key: string;
    /** Optional `KeyboardEvent.code` alternative, for layouts where digits need Shift. */
    code?: string;
    mod?: boolean;
    ctrl?: boolean;
    shift?: boolean;
    alt?: boolean;
}

type ModifierEvent = Pick<
    KeyboardEvent,
    'key' | 'code' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'
>;

export const matchesChord = (event: ModifierEvent, chord: KeyChord, mac: boolean): boolean => {
    const wantCtrl = !!chord.ctrl || (!mac && !!chord.mod);
    const wantMeta = mac && !!chord.mod;
    if (event.ctrlKey !== wantCtrl || event.metaKey !== wantMeta) return false;
    if (event.shiftKey !== !!chord.shift || event.altKey !== !!chord.alt) return false;
    return (
        event.key.toLowerCase() === chord.key.toLowerCase() ||
        (!!chord.code && event.code === chord.code)
    );
};

const keyLabels: Record<string, [mac: string, other: string]> = {
    enter: ['↩', 'Enter'],
    tab: ['⇥', 'Tab'],
    escape: ['Esc', 'Esc'],
    arrowleft: ['←', 'Left'],
    arrowright: ['→', 'Right'],
    pageup: ['PgUp', 'PgUp'],
    pagedown: ['PgDn', 'PgDn'],
    delete: ['⌦', 'Delete'],
    '=': ['=', '='],
    ',': [',', ','],
};

/** Human-readable chord, e.g. `Ctrl+Shift+Enter` or `⇧⌘↩` on macOS. */
export const formatChord = (chord: KeyChord, mac: boolean): string => {
    const known = keyLabels[chord.key.toLowerCase()];
    const key = known
        ? known[mac ? 0 : 1]
        : chord.key.length === 1
          ? chord.key.toUpperCase()
          : chord.key;
    if (mac) {
        return [
            chord.ctrl ? '⌃' : '',
            chord.alt ? '⌥' : '',
            chord.shift ? '⇧' : '',
            chord.mod ? '⌘' : '',
            key,
        ].join('');
    }
    return [
        chord.ctrl || chord.mod ? 'Ctrl' : '',
        chord.alt ? 'Alt' : '',
        chord.shift ? 'Shift' : '',
        key,
    ]
        .filter(Boolean)
        .join('+');
};

/** True when the event comes from a text field, content-editable region, or code editor. */
export const isEditableTarget = (target: EventTarget | null): boolean => {
    if (!(target instanceof HTMLElement)) return false;
    if (target.isContentEditable) return true;
    if (target.closest('.monaco-editor')) return true;
    const tag = target.tagName;
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (tag !== 'INPUT') return false;
    const type = (target as HTMLInputElement).type;
    return !['button', 'checkbox', 'radio', 'submit', 'reset', 'range', 'color'].includes(type);
};

/** Chords that cannot be ordinary typing: modifier combinations and function keys. */
export const hasCommandModifier = (chord: KeyChord) =>
    !!(chord.mod || chord.ctrl || chord.alt) || /^F\d{1,2}$/.test(chord.key);
