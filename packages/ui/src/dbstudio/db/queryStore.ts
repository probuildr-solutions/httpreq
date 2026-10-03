/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { create } from 'zustand';
import type {
    DbConnectionStatus,
    DbExplainPlan,
    DbQuerySnapshot,
    DbScriptProgress,
} from '@httpreq/shared';
import type { MetaEntry } from './explorerRows';

/** Live state of the connections: what the host reports, and the schema objects loaded so far. */
interface LiveState {
    status: Record<string, DbConnectionStatus>;
    meta: Record<string, MetaEntry>;
    expanded: ReadonlySet<string>;
    /** Connections currently being opened or closed by the user, for the busy indicator. */
    busy: Record<string, boolean>;
}

export const useLive = create<LiveState>(() => ({
    status: {},
    meta: {},
    expanded: new Set(),
    busy: {},
}));

export const resetLive = () =>
    useLive.setState({ status: {}, meta: {}, expanded: new Set(), busy: {} });

/** One line of the message log of a run. */
export interface StatementLog {
    index: number;
    /** The beginning of the statement. */
    sql: string;
    state: 'running' | 'done' | 'failed' | 'cancelled';
    rows?: number;
    affectedRows?: number;
    elapsedMs?: number;
    message?: string;
}

export type BottomTab = 'results' | 'messages' | 'history' | 'explain';

export interface QueryTab {
    /** `q` followed by 16 hex characters; shares the tab strip with file tabs. */
    id: string;
    title: string;
    profileId: string | null;
    /** The database and schema this tab's statements run in, when it has chosen one. */
    database: string | null;
    schema: string | null;
    text: string;
    /** The text as last saved to `source` (or empty for a tab that was never saved). */
    savedText: string;
    /** The file this tab was opened from or saved to: an opaque token and its name, never a path. */
    source: { token: string; name: string } | null;
    /** The host's id for the statement whose result is shown. */
    runId: string | null;
    snapshot: DbQuerySnapshot | null;
    log: StatementLog[];
    /** Which result set of the statement is shown. */
    resultIndex: number;
    bottom: BottomTab;
    explain: DbExplainPlan | null;
    explainError: string | null;
    /** A transaction was started here and not yet ended. */
    inTransaction: boolean;
    /** A script run from this tab's connection (file scripts show their progress here). */
    script: DbScriptProgress | null;
    scriptId: string | null;
    /** Set while a multi-statement run is going on. */
    running: boolean;
}

interface QueryState {
    tabs: Record<string, QueryTab>;
}

export const useQueries = create<QueryState>(() => ({ tabs: {} }));

export const resetQueries = () => useQueries.setState({ tabs: {} });

/** Whether a query tab holds text that is not in its file (or, for a new tab, any text at all). */
export const isQueryDirty = (tab: QueryTab): boolean => tab.text !== tab.savedText;

export const isQueryTabId = (id: string): boolean => /^q[0-9a-f]{16}$/.test(id);

export const newQueryTabId = (): string =>
    `q${Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('')}`;

export const patchQuery = (
    id: string,
    patch: Partial<QueryTab> | ((tab: QueryTab) => Partial<QueryTab>),
) =>
    useQueries.setState((state) => {
        const tab = state.tabs[id];
        if (!tab) return state;
        const changes = typeof patch === 'function' ? patch(tab) : patch;
        return { tabs: { ...state.tabs, [id]: { ...tab, ...changes } } };
    });

/** The result set of a tab's last statement that is shown. */
export const currentResult = (tab: QueryTab) => tab.snapshot?.results[tab.resultIndex] ?? null;

/* ---------- History ---------- */

export interface HistoryEntry {
    id: string;
    profileId: string;
    sql: string;
    at: number;
    elapsedMs: number;
    state: 'done' | 'failed' | 'cancelled';
    rows?: number;
    affectedRows?: number;
    error?: string;
}

export const HISTORY_KEY = 'httpreq.dbstudio.history';
export const MAX_HISTORY = 500;
const MAX_STATEMENT_CHARS = 10_000;

/** Statements that carry a secret are kept out of the history rather than stored in clear text. */
const SENSITIVE =
    /\b(identified\s+(by|with)|password\s*(=|\()|set\s+password|alter\s+user\b.*\bpassword|create\s+user\b.*\bidentified|encrypted\s+password|secret\s*=)/i;

export const redactForHistory = (sql: string): string =>
    SENSITIVE.test(sql)
        ? '-- (statement hidden: it contains a password)'
        : sql.slice(0, MAX_STATEMENT_CHARS);

const readHistory = (): HistoryEntry[] => {
    try {
        const raw = globalThis.localStorage?.getItem(HISTORY_KEY);
        const value: unknown = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(value)) return [];
        return value.filter(
            (e): e is HistoryEntry =>
                !!e &&
                typeof e === 'object' &&
                typeof e.id === 'string' &&
                typeof e.sql === 'string' &&
                typeof e.profileId === 'string' &&
                typeof e.at === 'number',
        );
    } catch {
        return [];
    }
};

const writeHistory = (entries: HistoryEntry[]) => {
    try {
        globalThis.localStorage?.setItem(HISTORY_KEY, JSON.stringify(entries));
    } catch {
        // History is a convenience; losing it must not break running statements.
    }
};

interface HistoryState {
    entries: HistoryEntry[];
    /** Whether statements are recorded at all. */
    enabled: boolean;
    add: (entry: Omit<HistoryEntry, 'id'>) => void;
    clear: (profileId?: string) => void;
    setEnabled: (enabled: boolean) => void;
}

const ENABLED_KEY = 'httpreq.dbstudio.history.enabled';

export const useHistory = create<HistoryState>((set, get) => ({
    entries: readHistory(),
    enabled: (() => {
        try {
            return globalThis.localStorage?.getItem(ENABLED_KEY) !== 'false';
        } catch {
            return true;
        }
    })(),
    add: (entry) => {
        if (!get().enabled || !entry.sql.trim()) return;
        const next = [
            {
                ...entry,
                sql: redactForHistory(entry.sql),
                id: `${entry.at}-${Math.random().toString(16).slice(2, 8)}`,
            },
            ...get().entries,
        ].slice(0, MAX_HISTORY);
        writeHistory(next);
        set({ entries: next });
    },
    clear: (profileId) => {
        const next = profileId ? get().entries.filter((e) => e.profileId !== profileId) : [];
        writeHistory(next);
        set({ entries: next });
    },
    setEnabled: (enabled) => {
        try {
            globalThis.localStorage?.setItem(ENABLED_KEY, String(enabled));
        } catch {
            // Not persisted this time.
        }
        set({ enabled });
    },
}));

export const resetHistory = () => useHistory.setState({ entries: [], enabled: true });
