/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { create } from 'zustand';

/** What the workspace remembers about a tab that is not part of the tab's own content. */
interface TabMeta {
    pinned: boolean;
    /** A name the user chose for a tab whose title comes from elsewhere (a file's name). */
    customTitle?: string;
}

/** A query tab that was closed, kept so it can be reopened. */
export interface ClosedTab {
    title: string;
    text: string;
    profileId: string | null;
    database: string | null;
    schema: string | null;
    source: { token: string; name: string } | null;
    pinned: boolean;
    closedAt: number;
}

interface TabMetaState {
    meta: Record<string, TabMeta>;
    closed: ClosedTab[];
}

export const MAX_RECENTLY_CLOSED = 15;

export const useTabMeta = create<TabMetaState>(() => ({ meta: {}, closed: [] }));

export const resetTabMeta = () => useTabMeta.setState({ meta: {}, closed: [] });

export const setPinned = (ids: string[], pinned: boolean) =>
    useTabMeta.setState((state) => {
        const meta = { ...state.meta };
        for (const id of ids) meta[id] = { ...meta[id], pinned };
        return { meta };
    });

export const setCustomTitle = (id: string, customTitle: string | undefined) =>
    useTabMeta.setState((state) => ({
        meta: { ...state.meta, [id]: { pinned: state.meta[id]?.pinned ?? false, customTitle } },
    }));

export const forgetTab = (id: string) =>
    useTabMeta.setState((state) => {
        const meta = { ...state.meta };
        delete meta[id];
        return { meta };
    });

export const rememberClosed = (tab: ClosedTab) =>
    useTabMeta.setState((state) => ({
        closed: [tab, ...state.closed].slice(0, MAX_RECENTLY_CLOSED),
    }));

export const takeClosed = (): ClosedTab | undefined => {
    const [first, ...rest] = useTabMeta.getState().closed;
    if (first) useTabMeta.setState({ closed: rest });
    return first;
};

export const isPinned = (id: string): boolean => useTabMeta.getState().meta[id]?.pinned === true;
