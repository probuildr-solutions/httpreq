/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { create } from 'zustand';
import type { LineSelection, LinePieceTable } from '@httpreq/editor-core';
import type {
    DbFileOpened,
    DbFileProgress,
    DbFileRef,
    DbHostStatus,
    DbItemsAnalyzed,
    DbItemsProgress,
    DbItemSummary,
    DbSearchHit,
    DbSearchProgress,
    DbSearchQuery,
} from '@httpreq/shared';
import type { Journal } from './journal';

/** Search hits kept for display; the total is counted beyond it. */
export const MAX_DISPLAYED_HITS = 5_000;
/** Statements or documents fetched per page of the list. */
export const ITEMS_PAGE = 40;

export interface SearchState {
    searchId: string;
    query: DbSearchQuery;
    state: DbSearchProgress['state'] | 'starting';
    hits: DbSearchHit[];
    total: number;
    bytesRead: number;
    totalBytes: number;
    truncated: boolean;
    error: string | null;
    /** The hit the user last stepped to, for next/previous. */
    current: number;
}

export interface ItemsView {
    from: number;
    items: DbItemSummary[];
    count: number;
    complete: boolean;
}

/** How a tab edits its file. */
export type EditorMode =
    /** A virtualised view over any size of file, edited a line at a time. */
    | 'viewer'
    /** The full text editor, for files small enough to hold in memory. */
    | 'text';

export type BottomPanel = 'none' | 'results' | 'items';

export interface FileTab {
    id: string;
    file: DbFileOpened;
    /** Progress of the background line index. */
    progress: DbFileProgress | null;
    analyzed: DbItemsAnalyzed | null;
    itemsProgress: DbItemsProgress | null;
    itemsView: ItemsView | null;
    mode: EditorMode;
    /** Text editor state; present in `text` mode. */
    text: { current: string; saved: string } | null;
    /** The document as pieces over the file; present once the index is complete. */
    table: LinePieceTable | null;
    /** Bumped on every edit, so views re-read what changed. */
    version: number;
    /** Lines readable now (partial while indexing). */
    lineCount: number;
    topLine: number;
    selection: LineSelection | null;
    /** A request to scroll to a line; the nonce lets the same line be requested again. */
    reveal: { line: number; nonce: number } | null;
    findOpen: boolean;
    search: SearchState | null;
    panel: BottomPanel;
    /** A save, replace or reload in progress. */
    working: { op: 'save' | 'replace'; bytes: number; total: number } | null;
    error: string | null;
    notice: string | null;
    /** Unsaved work from an earlier session that can be restored. */
    journal: Journal | null;
}

export interface StudioState {
    host: DbHostStatus;
    tabs: Record<string, FileTab>;
    order: string[];
    activeId: string | null;
    /** Opening a file (the dialog and the open call). */
    opening: boolean;
    /** A file the user picked and has not yet decided what to do with (the Open file dialog). */
    pending: DbFileRef | null;
    error: string | null;
}

const INITIAL: StudioState = {
    host: { state: 'idle', restarts: 0 },
    tabs: {},
    order: [],
    activeId: null,
    opening: false,
    pending: null,
    error: null,
};

export const useStudioStore = create<StudioState>(() => INITIAL);

export const resetStudio = () => useStudioStore.setState(INITIAL);

/** Whether the tab has changes that are not on disk. */
export const isDirty = (tab: FileTab): boolean =>
    tab.mode === 'text'
        ? tab.text !== null && tab.text.current !== tab.text.saved
        : (tab.table?.dirty ?? false);

export const activeTab = (state: StudioState): FileTab | null =>
    state.activeId ? (state.tabs[state.activeId] ?? null) : null;

export const anyDirty = (state: StudioState): boolean => Object.values(state.tabs).some(isDirty);

/** The language a file is highlighted and edited as. */
export type FileLanguage = 'sql-mysql' | 'sql-postgresql' | 'json' | 'plain';

export const languageOf = (tab: FileTab): FileLanguage => {
    const format = tab.analyzed?.format;
    if (format === 'sql-mysql' || format === 'sql-postgresql') return format;
    if (format === 'jsonl' || format === 'json-array' || format === 'json-sequence') return 'json';
    const extension = tab.file.name.split('.').pop()?.toLowerCase();
    if (extension === 'sql') return 'sql-mysql';
    if (extension === 'json' || extension === 'jsonl' || extension === 'ndjson') return 'json';
    return 'plain';
};

/** Monaco's name for a language. */
export const monacoLanguage = (language: FileLanguage): string =>
    language === 'sql-mysql'
        ? 'mysql'
        : language === 'sql-postgresql'
          ? 'pgsql'
          : language === 'json'
            ? 'json'
            : 'plaintext';
