/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { useCallback, useRef } from 'react';
import { patchAdmin, useAdmin } from '../adminStore';

/** The tab state that opens an editor on an existing object: the model and its baseline. */
export const seedEditorState = (key: string, model: unknown): Record<string, unknown> => ({
    [key]: model,
    [`${key}:baseline`]: JSON.stringify(model),
});

/**
 * A form model kept in the admin tab's own state, so switching tabs keeps the draft, and the tab
 * shows its unsaved dot while the model differs from the one it started with. The model the tab
 * is opened with (`seed`, or `initial()` for a new object) is the baseline for "unsaved".
 */
export function useAdminTabState<T>(
    id: string,
    key: string,
    initial: () => T,
): [T, (next: T | ((previous: T) => T)) => void] {
    const fallback = useRef<T | null>(null);
    if (fallback.current === null) fallback.current = initial();
    const stored = useAdmin((state) => state.tabs[id]?.state[key]) as T | undefined;
    const value = stored ?? fallback.current;

    const set = useCallback(
        (next: T | ((previous: T) => T)) =>
            patchAdmin(id, (tab) => {
                const previous = (tab.state[key] as T | undefined) ?? fallback.current!;
                const model = typeof next === 'function' ? (next as (p: T) => T)(previous) : next;
                const baseline =
                    (tab.state[`${key}:baseline`] as string | undefined) ??
                    JSON.stringify(fallback.current);
                return {
                    state: { ...tab.state, [key]: model, [`${key}:baseline`]: baseline },
                    dirty: JSON.stringify(model) !== baseline,
                };
            }),
        [id, key],
    );
    return [value, set];
}
