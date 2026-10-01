/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { IconCheck } from '@tabler/icons-react';
import { cx } from './kit';
import {
    memo,
    useCallback,
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
    type KeyboardEvent,
} from 'react';
import type { CommandMap } from './commands';
import { formatChord } from './shortcuts';

export type MenuEntry = { command: string; role?: 'checkbox' | 'radio' } | { separator: true };

export interface MenuDefinition {
    label: string;
    /** Alt+<mnemonic> opens the menu on desktop. */
    mnemonic: string;
    entries: MenuEntry[];
}

interface Props {
    menus: MenuDefinition[];
    commands: CommandMap;
    mac: boolean;
    /** Enables Alt focus and Alt+letter mnemonics (desktop only; browsers own those keys). */
    altKeyNavigation: boolean;
}

type Focus = 'first' | 'last';

const enabledItems = (menu: HTMLElement | null) =>
    [...(menu?.querySelectorAll<HTMLElement>('[data-menu-item]') ?? [])].filter(
        (item) => item.dataset.disabled !== 'true',
    );

/** Drops commands that do not exist in this runtime, then leading/trailing/double separators. */
const availableEntries = (entries: MenuEntry[], commands: CommandMap) =>
    entries
        .filter((entry) => 'separator' in entry || commands[entry.command])
        .filter((entry, index, list) => {
            if (!('separator' in entry)) return true;
            const previous = list[index - 1];
            return index > 0 && index < list.length - 1 && !(previous && 'separator' in previous);
        });

/**
 * Application menubar following the WAI-ARIA menubar pattern: Left/Right move across menus,
 * Down/Up/Enter/Space open them, arrows, Home, End and type-ahead move within a menu, and Esc
 * closes the menu and then returns focus to where it was before the menubar was used.
 */
export const MenuBar = memo(function MenuBar({ menus, commands, mac, altKeyNavigation }: Props) {
    const [open, setOpenState] = useState<number | null>(null);
    const openRef = useRef<number | null>(null);
    const setOpen = (value: number | null) => {
        openRef.current = value;
        setOpenState(value);
    };
    const [roving, setRoving] = useState(0);
    // Bumped on every keyboard open so an already-open menu still moves focus into its items.
    const [focusRequest, setFocusRequest] = useState(0);
    const buttons = useRef<(HTMLButtonElement | null)[]>([]);
    const menuRef = useRef<HTMLDivElement>(null);
    const barRef = useRef<HTMLDivElement>(null);
    const pendingFocus = useRef<Focus | null>(null);
    const returnFocus = useRef<HTMLElement | null>(null);

    const visibleMenus = menus
        .map((menu) => ({ ...menu, entries: availableEntries(menu.entries, commands) }))
        .filter((menu) => menu.entries.length > 0);

    const rememberFocus = () => {
        const active = document.activeElement as HTMLElement | null;
        if (active && !barRef.current?.contains(active)) returnFocus.current = active;
    };

    const restoreFocus = useCallback(() => {
        const target = returnFocus.current;
        returnFocus.current = null;
        if (target?.isConnected) target.focus();
        else (document.activeElement as HTMLElement | null)?.blur();
    }, []);

    const openMenu = (index: number, focus: Focus | null) => {
        rememberFocus();
        setRoving(index);
        setOpen(index);
        pendingFocus.current = focus;
        if (focus) setFocusRequest((count) => count + 1);
        else buttons.current[index]?.focus();
    };

    const close = useCallback((focusButton: boolean) => {
        const current = openRef.current;
        openRef.current = null;
        setOpenState(null);
        if (focusButton && current !== null) buttons.current[current]?.focus();
    }, []);

    // Focus the first/last item once a keyboard-opened menu has rendered, and keep it on-screen.
    useLayoutEffect(() => {
        const menu = menuRef.current;
        if (open === null || !menu) return;
        menu.style.transform = '';
        const overflow = menu.getBoundingClientRect().right - window.innerWidth + 4;
        if (overflow > 0) menu.style.transform = `translateX(${-overflow}px)`;
        const focus = pendingFocus.current;
        pendingFocus.current = null;
        if (!focus) return;
        const items = enabledItems(menu);
        (focus === 'first' ? items[0] : items[items.length - 1])?.focus();
    }, [open, focusRequest]);

    // Close on outside pointer-down and when the window loses focus.
    useEffect(() => {
        if (open === null) return;
        const onPointerDown = (event: PointerEvent) => {
            if (!barRef.current?.contains(event.target as Node)) close(false);
        };
        const onBlur = () => close(false);
        document.addEventListener('pointerdown', onPointerDown, true);
        window.addEventListener('blur', onBlur);
        return () => {
            document.removeEventListener('pointerdown', onPointerDown, true);
            window.removeEventListener('blur', onBlur);
        };
    }, [open, close]);

    // Desktop convention: tapping Alt focuses the menubar, Alt+<letter> opens a menu.
    useEffect(() => {
        if (!altKeyNavigation) return;
        let altAlone = false;
        const onKeyDown = (event: globalThis.KeyboardEvent) => {
            if (event.key === 'Alt') {
                altAlone = !event.ctrlKey && !event.metaKey && !event.shiftKey;
                return;
            }
            altAlone = false;
            if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
            if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
            const index = visibleMenus.findIndex(
                (menu) => menu.mnemonic.toLowerCase() === event.key.toLowerCase(),
            );
            if (index < 0) return;
            event.preventDefault();
            openMenu(index, 'first');
        };
        const onKeyUp = (event: globalThis.KeyboardEvent) => {
            if (event.key !== 'Alt' || !altAlone) return;
            altAlone = false;
            event.preventDefault();
            if (barRef.current?.contains(document.activeElement)) {
                close(false);
                restoreFocus();
            } else {
                rememberFocus();
                buttons.current[0]?.focus();
                setRoving(0);
            }
        };
        const reset = () => (altAlone = false);
        window.addEventListener('keydown', onKeyDown, true);
        window.addEventListener('keyup', onKeyUp, true);
        window.addEventListener('pointerdown', reset, true);
        return () => {
            window.removeEventListener('keydown', onKeyDown, true);
            window.removeEventListener('keyup', onKeyUp, true);
            window.removeEventListener('pointerdown', reset, true);
        };
    });

    const activate = (command: string) => {
        const target = commands[command];
        if (!target || target.disabled) return;
        setOpen(null);
        // Edit actions (copy, paste…) apply to whatever had focus before the menu was opened.
        restoreFocus();
        target.run();
    };

    const onBarKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
        const count = visibleMenus.length;
        const move = (next: number) => {
            const target = (next + count) % count;
            setRoving(target);
            if (open !== null) openMenu(target, 'first');
            else buttons.current[target]?.focus();
        };
        switch (event.key) {
            case 'ArrowRight':
                return (event.preventDefault(), move(index + 1));
            case 'ArrowLeft':
                return (event.preventDefault(), move(index - 1));
            case 'Home':
                return (event.preventDefault(), move(0));
            case 'End':
                return (event.preventDefault(), move(count - 1));
            case 'ArrowDown':
            case 'Enter':
            case ' ':
                event.preventDefault();
                return openMenu(index, 'first');
            case 'ArrowUp':
                event.preventDefault();
                return openMenu(index, 'last');
            case 'Escape':
                event.preventDefault();
                if (open !== null) close(true);
                else restoreFocus();
                return;
        }
    };

    const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        if (open === null) return;
        const items = enabledItems(menuRef.current);
        const current = items.indexOf(document.activeElement as HTMLElement);
        const focusAt = (index: number) => items[(index + items.length) % items.length]?.focus();
        switch (event.key) {
            case 'ArrowDown':
                event.preventDefault();
                return focusAt(current + 1);
            case 'ArrowUp':
                event.preventDefault();
                return focusAt(current < 0 ? -1 : current - 1);
            case 'Home':
                event.preventDefault();
                return focusAt(0);
            case 'End':
                event.preventDefault();
                return focusAt(-1);
            case 'ArrowRight':
            case 'ArrowLeft': {
                event.preventDefault();
                const next =
                    (open + (event.key === 'ArrowRight' ? 1 : -1) + visibleMenus.length) %
                    visibleMenus.length;
                return openMenu(next, 'first');
            }
            case 'Escape':
                event.preventDefault();
                event.stopPropagation();
                return close(true);
            case 'Tab':
                return close(false);
            default:
                // Type-ahead: jump to the next item starting with the typed character.
                if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
                    const char = event.key.toLowerCase();
                    const ordered = [...items.slice(current + 1), ...items.slice(0, current + 1)];
                    ordered
                        .find((item) => item.textContent?.trim().toLowerCase().startsWith(char))
                        ?.focus();
                }
        }
    };

    return (
        <div
            ref={barRef}
            role="menubar"
            aria-label="Application menu"
            className="app-no-drag flex h-full flex-none items-stretch"
        >
            {visibleMenus.map((menu, index) => {
                const expanded = open === index;
                const menuId = `app-menu-${menu.label.toLowerCase()}`;
                return (
                    <div key={menu.label} className="relative flex">
                        <button
                            ref={(element) => {
                                buttons.current[index] = element;
                            }}
                            type="button"
                            role="menuitem"
                            className="flex h-full cursor-default items-center border-0 bg-transparent px-[9px] text-[12.5px] leading-none whitespace-nowrap text-titlebar-fg outline-none hover:bg-chrome-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary data-[open]:bg-chrome-pressed"
                            aria-haspopup="menu"
                            aria-expanded={expanded}
                            aria-controls={expanded ? menuId : undefined}
                            tabIndex={roving === index ? 0 : -1}
                            data-open={expanded || undefined}
                            onPointerDown={(event) => {
                                if (event.button !== 0) return;
                                // Toggle on press, like native menus; prevent focus flicker.
                                event.preventDefault();
                                if (expanded) close(false);
                                else openMenu(index, null);
                            }}
                            onPointerEnter={() => {
                                if (open !== null && open !== index) openMenu(index, null);
                            }}
                            onKeyDown={(event) => onBarKeyDown(event, index)}
                            onClick={(event) => {
                                // Keyboard/assistive-tech activation (pointer presses are handled above).
                                if (event.detail === 0) openMenu(index, 'first');
                            }}
                        >
                            {menu.label}
                        </button>
                        {expanded && (
                            <div
                                ref={menuRef}
                                id={menuId}
                                role="menu"
                                aria-label={menu.label}
                                className="absolute top-full left-0 z-[400] max-h-[calc(100vh-48px)] min-w-[240px] overflow-y-auto rounded-b-sm border border-line bg-surface py-1 shadow-popup outline-none"
                                onKeyDown={onMenuKeyDown}
                            >
                                {menu.entries.map((entry, entryIndex) => {
                                    if ('separator' in entry) {
                                        return (
                                            <div
                                                key={`sep-${entryIndex}`}
                                                role="separator"
                                                className="my-1 h-px bg-line"
                                            />
                                        );
                                    }
                                    const command = commands[entry.command];
                                    if (!command) return null;
                                    const shortcut = command.shortcut?.[0];
                                    const role = entry.role
                                        ? entry.role === 'radio'
                                            ? 'menuitemradio'
                                            : 'menuitemcheckbox'
                                        : 'menuitem';
                                    return (
                                        <div
                                            key={entry.command}
                                            role={role}
                                            tabIndex={-1}
                                            data-menu-item
                                            data-disabled={command.disabled || undefined}
                                            aria-disabled={command.disabled || undefined}
                                            aria-checked={
                                                entry.role ? !!command.checked : undefined
                                            }
                                            className={cx(
                                                'grid min-h-[26px] cursor-default grid-cols-[22px_1fr_auto] items-center gap-1.5 py-0 pr-3.5 pl-1.5 text-[12.5px] whitespace-nowrap text-fg outline-none select-none',
                                                'focus:bg-primary focus:text-primary-fg focus-visible:bg-primary focus-visible:text-primary-fg forced-colors:focus:outline-2 forced-colors:focus:-outline-offset-2 forced-colors:focus:outline-[Highlight]',
                                                'data-[disabled]:text-dimmed data-[disabled]:opacity-55 data-[disabled]:focus:bg-transparent data-[disabled]:focus:text-dimmed',
                                            )}
                                            onClick={() => activate(entry.command)}
                                            onKeyDown={(event) => {
                                                if (event.key === 'Enter' || event.key === ' ') {
                                                    event.preventDefault();
                                                    activate(entry.command);
                                                }
                                            }}
                                            onPointerMove={(event) => {
                                                if (
                                                    document.activeElement !==
                                                        event.currentTarget &&
                                                    !command.disabled
                                                )
                                                    event.currentTarget.focus({
                                                        preventScroll: true,
                                                    });
                                            }}
                                        >
                                            <span className="grid place-items-center" aria-hidden>
                                                {entry.role && command.checked ? (
                                                    <IconCheck size={14} />
                                                ) : null}
                                            </span>
                                            <span className="truncate">{command.label}</span>
                                            {shortcut && (
                                                <span className="pl-6 text-[11.5px] opacity-75">
                                                    {formatChord(shortcut, mac)}
                                                </span>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                );
            })}
        </div>
    );
});
