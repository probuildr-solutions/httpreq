/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */
import type { StateCreator } from 'zustand';
import type { WorkbenchState } from '../store';
import { nearestOpen } from './helpers';

/**
 * Environment editor tabs, in tab order after the request tabs. Like terminals they are not
 * persisted; unlike requests there is nothing unsaved to restore, as every edit is committed.
 * Opening one deactivates the other kinds of tab, so exactly one tab is ever active.
 */
export interface EnvironmentTabsSlice {
    openEnvironmentTab: (id: string, options?: { naming?: boolean }) => void;
    closeEnvironmentTabs: (ids: Iterable<string>) => void;
    setActiveEnvironmentTab: (id: string | null) => void;
    moveEnvironmentTab: (id: string, toIndex: number) => void;
    clearNamingEnvironment: () => void;
}

export const createEnvironmentTabsSlice: StateCreator<
    WorkbenchState,
    [],
    [],
    EnvironmentTabsSlice
> = (set) => ({
    openEnvironmentTab: (id, options) =>
        set((state) => {
            if (!state.workspace.environments.some((environment) => environment.id === id))
                return state;
            const open = state.openEnvironmentTabIds;
            return {
                openEnvironmentTabIds: open.includes(id) ? open : [...open, id],
                activeEnvironmentTabId: id,
                activeRequestId: null,
                activeSshSessionId: null,
                namingEnvironmentId: options?.naming ? id : state.namingEnvironmentId,
            };
        }),

    closeEnvironmentTabs: (ids) =>
        set((state) => {
            const open = state.openEnvironmentTabIds;
            const closing = new Set([...ids].filter((id) => open.includes(id)));
            if (!closing.size) return state;
            const remaining = open.filter((id) => !closing.has(id));
            const active = state.activeEnvironmentTabId;
            if (active === null || !closing.has(active))
                return { openEnvironmentTabIds: remaining };
            const next = nearestOpen(open, closing, active);
            return {
                openEnvironmentTabIds: remaining,
                activeEnvironmentTabId: next,
                // With no environment tab left, focus returns to a request tab, or else a terminal.
                ...(next === null
                    ? state.workspace.openRequestIds.length
                        ? { activeRequestId: state.workspace.openRequestIds[0]! }
                        : { activeSshSessionId: state.openSshSessionIds[0] ?? null }
                    : {}),
            };
        }),

    setActiveEnvironmentTab: (activeEnvironmentTabId) =>
        set({
            activeEnvironmentTabId,
            ...(activeEnvironmentTabId ? { activeRequestId: null, activeSshSessionId: null } : {}),
        }),

    moveEnvironmentTab: (id, toIndex) =>
        set((state) => {
            const order = [...state.openEnvironmentTabIds];
            const from = order.indexOf(id);
            const target = Math.max(0, Math.min(toIndex, order.length - 1));
            if (from < 0 || from === target) return state;
            order.splice(from, 1);
            order.splice(target, 0, id);
            return { openEnvironmentTabIds: order };
        }),

    clearNamingEnvironment: () => set({ namingEnvironmentId: null }),
});
