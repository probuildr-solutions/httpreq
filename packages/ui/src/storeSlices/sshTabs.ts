/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */
import type { StateCreator } from 'zustand';
import type { WorkbenchState } from '../store';

/**
 * SSH terminal tabs, in tab order. They are deliberately not persisted: a shell cannot survive a
 * restart, so reopening the app to a row of dead terminals would be a lie.
 */
export interface SshTabsSlice {
    openSshSession: (sessionId: string) => void;
    closeSshSession: (sessionId: string) => void;
    setActiveSshSession: (sessionId: string | null) => void;
    moveSshTab: (sessionId: string, toIndex: number) => void;
}

export const createSshTabsSlice: StateCreator<WorkbenchState, [], [], SshTabsSlice> = (set) => ({
    openSshSession: (sessionId) =>
        set((state) =>
            state.openSshSessionIds.includes(sessionId)
                ? {
                      activeSshSessionId: sessionId,
                      activeRequestId: null,
                      activeEnvironmentTabId: null,
                  }
                : {
                      openSshSessionIds: [...state.openSshSessionIds, sessionId],
                      activeSshSessionId: sessionId,
                      activeRequestId: null,
                      activeEnvironmentTabId: null,
                  },
        ),

    closeSshSession: (sessionId) =>
        set((state) => {
            const index = state.openSshSessionIds.indexOf(sessionId);
            if (index < 0) return state;
            const remaining = state.openSshSessionIds.filter((id) => id !== sessionId);
            const wasActive = state.activeSshSessionId === sessionId;
            return {
                openSshSessionIds: remaining,
                activeSshSessionId: wasActive
                    ? (remaining[Math.min(index, remaining.length - 1)] ?? null)
                    : state.activeSshSessionId,
                // With no terminal left, focus returns to whichever request tab was open.
                activeRequestId:
                    wasActive && remaining.length === 0
                        ? (state.workspace.openRequestIds[0] ?? null)
                        : state.activeRequestId,
            };
        }),

    setActiveSshSession: (activeSshSessionId) =>
        set({
            activeSshSessionId,
            ...(activeSshSessionId ? { activeRequestId: null, activeEnvironmentTabId: null } : {}),
        }),

    moveSshTab: (sessionId, toIndex) =>
        set((state) => {
            const order = [...state.openSshSessionIds];
            const from = order.indexOf(sessionId);
            const target = Math.max(0, Math.min(toIndex, order.length - 1));
            if (from < 0 || from === target) return state;
            order.splice(from, 1);
            order.splice(target, 0, sessionId);
            return { openSshSessionIds: order };
        }),
});
