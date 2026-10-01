/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { useEffect, useRef } from 'react';
import { hasCommandModifier, isEditableTarget, matchesChord, type KeyChord } from './shortcuts';

export interface Command {
    label: string;
    /** Key bindings; the first one is shown in menus and the shortcuts dialog. */
    shortcut?: KeyChord[];
    run: () => void;
    disabled?: boolean;
    /** Renders as a checkable menu item. */
    checked?: boolean;
    /** Whether the shortcut may fire while focus is in a text field or editor. */
    allowInEditable?: boolean;
    /** Whether holding the keys down repeats the command (e.g. cycling through tabs). */
    repeatable?: boolean;
    /** The shortcut is only displayed; the platform or editor handles the keys natively. */
    passive?: boolean;
}

export type CommandMap = Record<string, Command>;

/**
 * The application's single keyboard-shortcut listener. It runs in the capture phase so global
 * shortcuts such as Ctrl/Cmd+Enter win over the code editor's own bindings, while plain keys
 * (and any command that opts out) are left alone whenever the user is typing.
 */
export function useShortcutManager(commands: CommandMap, mac: boolean) {
    const latest = useRef(commands);
    useEffect(() => {
        latest.current = commands;
    });

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.defaultPrevented || event.isComposing) return;
            // Modal dialogs own the keyboard while open (Esc, Tab trapping, their own buttons).
            if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
            const editable = isEditableTarget(event.target);
            for (const command of Object.values(latest.current)) {
                if (command.passive) continue;
                const chord = command.shortcut?.find((candidate) =>
                    matchesChord(event, candidate, mac),
                );
                if (!chord || command.disabled) continue;
                if (editable && (!hasCommandModifier(chord) || command.allowInEditable === false))
                    return;
                event.preventDefault();
                event.stopPropagation();
                if (!event.repeat || command.repeatable) command.run();
                return;
            }
        };
        window.addEventListener('keydown', onKeyDown, true);
        return () => window.removeEventListener('keydown', onKeyDown, true);
    }, [mac]);
}
