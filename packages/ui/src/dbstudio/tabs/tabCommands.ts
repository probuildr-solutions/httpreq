/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

/**
 * Which tabs a close command closes, and where a tab may be dropped. Pure functions of the strip's
 * order and which tabs are pinned, so every kind of tab (query, file, table, diagram) obeys the
 * same rules and the rules can be tested without a window.
 */
export type CloseMode = 'self' | 'left' | 'right' | 'others' | 'all';

export interface StripTab {
    id: string;
    pinned: boolean;
}

/**
 * The tabs to close. Pinned tabs stay open for the bulk commands unless `includePinned` is set;
 * closing a single tab by name always closes it, pinned or not (the user pointed at it).
 */
export const closeTargets = (
    tabs: StripTab[],
    id: string,
    mode: CloseMode,
    includePinned = false,
): string[] => {
    const index = tabs.findIndex((tab) => tab.id === id);
    if (index < 0) return [];
    if (mode === 'self') return [id];
    const candidates =
        mode === 'left'
            ? tabs.slice(0, index)
            : mode === 'right'
              ? tabs.slice(index + 1)
              : mode === 'others'
                ? tabs.filter((tab) => tab.id !== id)
                : tabs;
    return candidates.filter((tab) => includePinned || !tab.pinned).map((tab) => tab.id);
};

/** The order with pinned tabs first, each group keeping its own order. */
export const pinnedFirst = (order: string[], pinned: ReadonlySet<string>): string[] => [
    ...order.filter((id) => pinned.has(id)),
    ...order.filter((id) => !pinned.has(id)),
];

/**
 * Moves a tab to the position of another (dropping onto it). A pinned tab can only move among the
 * pinned ones and an unpinned tab among the unpinned, so the pinned group always stays at the left.
 */
export const moveTab = (
    order: string[],
    id: string,
    beforeId: string,
    pinned: ReadonlySet<string>,
): string[] => {
    if (id === beforeId || !order.includes(id) || !order.includes(beforeId)) return order;
    if (pinned.has(id) !== pinned.has(beforeId)) return order;
    const without = order.filter((item) => item !== id);
    const at = without.indexOf(beforeId);
    // Dropping on a tab to its right puts the dragged tab after it, as a drag in a strip feels.
    const from = order.indexOf(id);
    const target = order.indexOf(beforeId);
    without.splice(from < target ? at + 1 : at, 0, id);
    return without;
};

/** The tab to select after `closing` tabs go away from `order`, staying next to where it was. */
export const nextActive = (
    order: string[],
    closing: ReadonlySet<string>,
    activeId: string | null,
): string | null => {
    if (activeId === null || !closing.has(activeId)) return activeId;
    const index = order.indexOf(activeId);
    for (let offset = 1; offset < order.length; offset++) {
        const right = order[index + offset];
        if (right !== undefined && !closing.has(right)) return right;
        const left = order[index - offset];
        if (left !== undefined && !closing.has(left)) return left;
    }
    return null;
};
