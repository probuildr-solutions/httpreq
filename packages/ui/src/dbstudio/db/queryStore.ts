/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { create } from 'zustand';
import type { DbConnectionStatus, DbExplainPlan, DbScriptProgress } from '@httpreq/shared';
import type { MetaEntry } from './explorerRows';
import { activeRunOf, resultOfRun, type StatementRun } from './resultSession';

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
    /**
     * Every statement of the last execution, in order, each with its own host query, metadata and
     * view state. "Run all" appends one per statement; none replaces another.
     */
    runs: StatementRun[];
    /** The statement number (`StatementRun.index`) whose result is shown. */
    activeRun: number | null;
    log: StatementLog[];
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

/** The statement whose result is shown. */
export const currentRun = (tab: QueryTab): StatementRun | null =>
    activeRunOf(tab.runs, tab.activeRun);

/** The result set of the shown statement that its grid shows. */
export const currentResult = (tab: QueryTab) => resultOfRun(currentRun(tab));

/** Changes one statement run of a tab, found by its host query id. */
export const patchRun = (
    tabId: string,
    runId: string,
    patch: Partial<StatementRun> | ((run: StatementRun) => Partial<StatementRun>),
) =>
    patchQuery(tabId, (tab) => ({
        runs: tab.runs.map((run) =>
            run.runId === runId
                ? { ...run, ...(typeof patch === 'function' ? patch(run) : patch) }
                : run,
        ),
    }));

/* ---------- Result limits ---------- */

interface QuerySettings {
    /**
     * When a script has more statements after one that returns rows, that result is read on to this
     * many rows before the next statement starts (the host holds them on disk, not in the window).
     */
    runAllRowLimit: number;
}

export const DEFAULT_RUN_ALL_ROW_LIMIT = 50_000;

export const useQuerySettings = create<QuerySettings>(() => ({
    runAllRowLimit: DEFAULT_RUN_ALL_ROW_LIMIT,
}));

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
