/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { useCallback, useMemo, useRef, useState } from 'react';

export interface Selection {
    /** Whether the panel is in selection mode (checkboxes instead of its usual row actions). */
    selecting: boolean;
    start: () => void;
    stop: () => void;
    /** Selected ids that still exist, in the order of the list. */
    ids: string[];
    count: number;
    total: number;
    allSelected: boolean;
    isSelected: (id: string) => boolean;
    toggle: (id: string) => void;
    toggleAll: () => void;
}

/** Relations between ids, for lists that are trees: checking a container checks what is inside. */
export interface SelectionRelations {
    /** Every id nested under `id`, at any depth, including ones that are not listed (collapsed). */
    descendants?: (id: string) => Iterable<string>;
    /** The ids of the containers above `id`. */
    ancestors?: (id: string) => Iterable<string>;
}

/**
 * Multi-selection over a list of ids. Ids that disappear from the list (deleted elsewhere, or
 * filtered out) drop out of the selection, so a bulk action only ever sees live, visible items.
 */
export const useSelection = (allIds: string[], relations: SelectionRelations = {}): Selection => {
    // Read through a ref so the callbacks below stay stable while the workspace changes.
    const relationsRef = useRef(relations);
    relationsRef.current = relations;
    const [selecting, setSelecting] = useState(false);
    const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
    const ids = useMemo(() => allIds.filter((id) => picked.has(id)), [allIds, picked]);
    const allSelected = allIds.length > 0 && ids.length === allIds.length;

    const stop = useCallback(() => {
        setSelecting(false);
        setPicked(new Set());
    }, []);
    /**
     * Checking an item checks everything inside it. Unchecking one clears it and everything
     * inside, and the containers above it, which are no longer wholly selected.
     */
    const toggle = useCallback(
        (id: string) =>
            setPicked((current) => {
                const { descendants, ancestors } = relationsRef.current;
                const inside = [id, ...(descendants?.(id) ?? [])];
                const next = new Set(current);
                if (next.has(id)) {
                    for (const item of [...inside, ...(ancestors?.(id) ?? [])]) next.delete(item);
                } else {
                    for (const item of inside) next.add(item);
                }
                return next;
            }),
        [],
    );

    return {
        selecting,
        start: () => setSelecting(true),
        stop,
        ids,
        count: ids.length,
        total: allIds.length,
        allSelected,
        isSelected: (id) => picked.has(id),
        toggle,
        toggleAll: () =>
            setPicked(() => {
                if (allSelected) return new Set();
                const { descendants } = relationsRef.current;
                return new Set(allIds.flatMap((id) => [id, ...(descendants?.(id) ?? [])]));
            }),
    };
};
