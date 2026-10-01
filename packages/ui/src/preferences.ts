/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { create } from 'zustand';
import { clampZoomLevel } from './webZoom';

export type ResponsePosition = 'right' | 'bottom';

/**
 * Application-level workspace UI preferences. They apply to every open and future request and are
 * stored under their own key, separate from workspace/request data.
 */
export interface WorkspacePreferences {
    responsePosition: ResponsePosition;
    /** Request pane share of the workspace (0–1), remembered separately for each layout. */
    splitRatio: Record<ResponsePosition, number>;
    sidebarVisible: boolean;
    /** Sidebar width in pixels (activity rail plus explorer). */
    sidebarWidth: number;
    statusBarVisible: boolean;
    /** Whether the Headers tab lists the headers added automatically when a request is sent. */
    generatedHeadersVisible: boolean;
    /** Page zoom level of the browser build (0 = 100%); the desktop app zooms natively. */
    zoomLevel: number;
}

interface PreferencesState extends WorkspacePreferences {
    setResponsePosition: (position: ResponsePosition) => void;
    setSplitRatio: (position: ResponsePosition, ratio: number) => void;
    toggleSidebar: () => void;
    setSidebarWidth: (width: number) => void;
    toggleStatusBar: () => void;
    setGeneratedHeadersVisible: (visible: boolean) => void;
    setZoomLevel: (level: number) => void;
}

/** The localStorage key the preferences are saved under. */
export const PREFERENCES_KEY = 'httpreq.preferences';
export const DEFAULT_SPLIT_RATIO: Record<ResponsePosition, number> = { right: 0.5, bottom: 0.5 };
export const MIN_SPLIT_RATIO = 0.1;
export const MAX_SPLIT_RATIO = 0.9;
export const DEFAULT_SIDEBAR_WIDTH = 300;
export const MIN_SIDEBAR_WIDTH = 220;
export const MAX_SIDEBAR_WIDTH = 560;

/** Keeps a dragged or restored sidebar width inside the range the layout supports. */
export const clampSidebarWidth = (width: number) =>
    Math.round(Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, width)));

export const defaultPreferences = (): WorkspacePreferences => ({
    responsePosition: 'right',
    splitRatio: { ...DEFAULT_SPLIT_RATIO },
    sidebarVisible: true,
    sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
    statusBarVisible: true,
    generatedHeadersVisible: true,
    zoomLevel: 0,
});

/** Keeps a split position far enough from both edges that neither pane can be dragged out of
 * sight.
 */
export const clampRatio = (ratio: number) =>
    Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, ratio));

const isRatio = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value);

/** Parses stored preferences, keeping valid fields and falling back to defaults for the rest. */
export const parsePreferences = (raw: string | null): WorkspacePreferences => {
    const defaults = defaultPreferences();
    if (!raw) return defaults;
    let value: unknown;
    try {
        value = JSON.parse(raw);
    } catch {
        return defaults;
    }
    if (!value || typeof value !== 'object') return defaults;
    const stored = value as Partial<Record<keyof WorkspacePreferences, unknown>>;
    const ratios = (stored.splitRatio ?? {}) as Partial<Record<ResponsePosition, unknown>>;
    return {
        responsePosition:
            stored.responsePosition === 'right' || stored.responsePosition === 'bottom'
                ? stored.responsePosition
                : defaults.responsePosition,
        splitRatio: {
            right: isRatio(ratios.right) ? clampRatio(ratios.right) : defaults.splitRatio.right,
            bottom: isRatio(ratios.bottom) ? clampRatio(ratios.bottom) : defaults.splitRatio.bottom,
        },
        sidebarVisible:
            typeof stored.sidebarVisible === 'boolean'
                ? stored.sidebarVisible
                : defaults.sidebarVisible,
        sidebarWidth: isRatio(stored.sidebarWidth)
            ? clampSidebarWidth(stored.sidebarWidth)
            : defaults.sidebarWidth,
        statusBarVisible:
            typeof stored.statusBarVisible === 'boolean'
                ? stored.statusBarVisible
                : defaults.statusBarVisible,
        generatedHeadersVisible:
            typeof stored.generatedHeadersVisible === 'boolean'
                ? stored.generatedHeadersVisible
                : defaults.generatedHeadersVisible,
        zoomLevel: isRatio(stored.zoomLevel)
            ? clampZoomLevel(stored.zoomLevel)
            : defaults.zoomLevel,
    };
};

const storage = (): Storage | undefined => {
    try {
        return globalThis.localStorage;
    } catch {
        return undefined;
    }
};

const load = () => {
    try {
        return parsePreferences(storage()?.getItem(PREFERENCES_KEY) ?? null);
    } catch {
        return defaultPreferences();
    }
};

/** Layout and display preferences, persisted to localStorage on every change. */
export const usePreferences = create<PreferencesState>((set) => ({
    ...load(),
    setResponsePosition: (responsePosition) => set({ responsePosition }),
    setSplitRatio: (position, ratio) =>
        set((state) => ({ splitRatio: { ...state.splitRatio, [position]: clampRatio(ratio) } })),
    toggleSidebar: () => set((state) => ({ sidebarVisible: !state.sidebarVisible })),
    setSidebarWidth: (width) => set({ sidebarWidth: clampSidebarWidth(width) }),
    toggleStatusBar: () => set((state) => ({ statusBarVisible: !state.statusBarVisible })),
    setGeneratedHeadersVisible: (generatedHeadersVisible) => set({ generatedHeadersVisible }),
    setZoomLevel: (level) => set({ zoomLevel: clampZoomLevel(level) }),
}));

const snapshot = (state: WorkspacePreferences): WorkspacePreferences => ({
    responsePosition: state.responsePosition,
    splitRatio: state.splitRatio,
    sidebarVisible: state.sidebarVisible,
    sidebarWidth: state.sidebarWidth,
    statusBarVisible: state.statusBarVisible,
    generatedHeadersVisible: state.generatedHeadersVisible,
    zoomLevel: state.zoomLevel,
});

// Writes are debounced so bursts of changes (e.g. keyboard-resizing the splitter) cost one write.
let pendingWrite: ReturnType<typeof setTimeout> | undefined;
const persist = (state: WorkspacePreferences) => {
    clearTimeout(pendingWrite);
    pendingWrite = setTimeout(() => {
        try {
            storage()?.setItem(PREFERENCES_KEY, JSON.stringify(snapshot(state)));
        } catch {
            // Storage can be full or unavailable (private mode); preferences then last for the session.
        }
    }, 300);
};

usePreferences.subscribe((state, previous) => {
    if (
        state.responsePosition !== previous.responsePosition ||
        state.splitRatio !== previous.splitRatio ||
        state.sidebarVisible !== previous.sidebarVisible ||
        state.sidebarWidth !== previous.sidebarWidth ||
        state.statusBarVisible !== previous.statusBarVisible ||
        state.generatedHeadersVisible !== previous.generatedHeadersVisible ||
        state.zoomLevel !== previous.zoomLevel
    ) {
        persist(state);
    }
});

// Keep other windows/tabs of the app in sync when they change the shared preferences.
if (typeof window !== 'undefined') {
    window.addEventListener('storage', (event) => {
        if (event.key === PREFERENCES_KEY)
            usePreferences.setState(parsePreferences(event.newValue));
    });
}
