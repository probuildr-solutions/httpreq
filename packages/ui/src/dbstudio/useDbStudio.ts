/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef } from 'react';
import {
    LinePieceTable,
    extendSelection,
    selectLine,
    selectionBounds,
    type Piece,
} from '@httpreq/editor-core';
import type {
    DbItemText,
    DbLine,
    DbFileRef,
    DbLineEnding,
    DbSavePiece,
    DbSearchQuery,
    DbStudioBridge,
} from '@httpreq/shared';
import { copyText, readClipboardText } from '../clipboard';
import { isQueryTabId } from './db/queryStore';
import { confirmAction } from '../confirm';
import { notifications } from '../kit';
import { handlingFor, largeFileLimits } from './largeFile';
import { clearJournal, readJournal, writeJournal } from './journal';
import {
    ITEMS_PAGE,
    MAX_DISPLAYED_HITS,
    isDirty,
    useStudioStore,
    type BottomPanel,
    type EditorMode,
    type FileTab,
} from './studioStore';

/** One line of the document as the viewer draws it. */
export interface ViewRow {
    index: number;
    text: string;
    /** The line was cut for display (it is longer than the viewer holds); editing it is blocked. */
    truncated: boolean;
    /** The line differs from the file on disk. */
    edited: boolean;
}

export type SaveTextResult =
    | { kind: 'saved'; token: string; name: string }
    | { kind: 'cancelled' }
    | { kind: 'failed'; message: string };

export interface DbStudioApi {
    readonly available: boolean;

    /* Files and tabs */
    /** Shows the native file picker, then the Open file dialog for the chosen file. */
    openFile: () => Promise<void>;
    /** Opens the file the dialog is showing: in the file editor, or only in the line viewer. */
    openPending: (options?: { preview?: boolean }) => Promise<void>;
    /**
     * The whole text of the file the dialog is showing (small files only), with the token that
     * stands for it so the query tab it becomes can be saved back to the same file; `null` when
     * it cannot be read.
     */
    readPendingText: () => Promise<{ text: string; token: string; name: string } | null>;
    /** Saves query text to a file (to the one `token` stands for, else after a save dialog). */
    saveText: (
        token: string | null,
        suggestedName: string,
        text: string,
    ) => Promise<SaveTextResult>;
    cancelPending: () => void;
    /** Shows the file dialog and returns the chosen file (a token, never a path), or null. */
    pickFile: () => Promise<DbFileRef | null>;
    /** Closes a file tab. A tab with unsaved changes asks first, unless `discard` is set. */
    closeTab: (id: string, options?: { discard?: boolean }) => Promise<void>;
    activateTab: (id: string) => void;
    setMode: (id: string, mode: EditorMode) => Promise<void>;

    /* Viewing */
    readRows: (id: string, first: number, end: number) => Promise<ViewRow[]>;
    setTopLine: (id: string, line: number) => void;
    /** Scrolls to a one-based line number. */
    goToLine: (id: string, line: number) => void;
    select: (id: string, line: number, extend: boolean) => void;
    copySelection: (id: string) => Promise<void>;

    /* Editing the viewer's document */
    setLine: (id: string, index: number, text: string) => void;
    insertLines: (id: string, at: number, lines: string[]) => void;
    deleteSelection: (id: string) => void;
    pasteAfterSelection: (id: string) => Promise<void>;
    undo: (id: string) => void;
    redo: (id: string) => void;
    setText: (id: string, text: string) => void;

    /* Saving */
    save: (id: string) => Promise<boolean>;
    saveAs: (id: string) => Promise<boolean>;
    restoreJournal: (id: string) => void;
    discardJournal: (id: string) => void;

    /* Find */
    setFindOpen: (id: string, open: boolean) => void;
    search: (id: string, query: DbSearchQuery) => Promise<void>;
    cancelSearch: (id: string) => Promise<void>;
    stepHit: (id: string, direction: 1 | -1) => void;
    /** Makes one search hit the current one and shows it. */
    gotoHit: (id: string, index: number) => void;
    replaceAll: (id: string, query: DbSearchQuery, replacement: string) => Promise<void>;

    /* Statements and documents */
    setPanel: (id: string, panel: BottomPanel) => void;
    loadItems: (id: string, from: number) => Promise<void>;
    /** The text of one statement or document (cut at 1 MiB), or `null` if it cannot be read. */
    readItem: (id: string, index: number) => Promise<DbItemText | null>;
}

const UNAVAILABLE: DbStudioApi = {
    available: false,
    openFile: async () => undefined,
    openPending: async () => undefined,
    readPendingText: async () => null,
    saveText: async () => ({ kind: 'failed', message: 'Saving is part of the desktop app.' }),
    cancelPending: () => undefined,
    pickFile: async () => null,
    closeTab: async () => undefined,
    activateTab: () => undefined,
    setMode: async () => undefined,
    readRows: async () => [],
    setTopLine: () => undefined,
    goToLine: () => undefined,
    select: () => undefined,
    copySelection: async () => undefined,
    setLine: () => undefined,
    insertLines: () => undefined,
    deleteSelection: () => undefined,
    pasteAfterSelection: async () => undefined,
    undo: () => undefined,
    redo: () => undefined,
    setText: () => undefined,
    save: async () => false,
    saveAs: async () => false,
    restoreJournal: () => undefined,
    discardJournal: () => undefined,
    setFindOpen: () => undefined,
    search: async () => undefined,
    cancelSearch: async () => undefined,
    stepHit: () => undefined,
    gotoHit: () => undefined,
    replaceAll: async () => undefined,
    setPanel: () => undefined,
    loadItems: async () => undefined,
    readItem: async () => null,
};

export const DbStudioContext = createContext<DbStudioApi>(UNAVAILABLE);
export const useDbStudio = (): DbStudioApi => useContext(DbStudioContext);

/** Lines per cached page of the file. */
const PAGE = 100;
const MAX_CACHED_PAGES = 400;
/** Most lines or text one copy may gather. */
const MAX_COPY_CHARS = 16 * 1024 * 1024;

const store = useStudioStore;
const getTab = (id: string): FileTab | undefined => store.getState().tabs[id];

const patchTab = (id: string, patch: Partial<FileTab> | ((tab: FileTab) => Partial<FileTab>)) =>
    store.setState((state) => {
        const tab = state.tabs[id];
        if (!tab) return state;
        const changes = typeof patch === 'function' ? patch(tab) : patch;
        return { tabs: { ...state.tabs, [id]: { ...tab, ...changes } } };
    });

/** Marks the document changed so views re-read it. */
const touch = (id: string, extra: Partial<FileTab> = {}) =>
    patchTab(id, (tab) => ({
        version: tab.version + 1,
        lineCount: tab.table?.lineCount ?? tab.lineCount,
        ...extra,
    }));

/** 16 hex characters, chosen here so progress can be matched before the start call replies. */
const newSearchId = (): string =>
    Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) =>
        b.toString(16).padStart(2, '0'),
    ).join('');

const piecesOf = (table: LinePieceTable): DbSavePiece[] =>
    table.pieces.map((piece: Piece) =>
        piece.kind === 'original'
            ? { kind: 'original', from: piece.from, count: piece.count }
            : { kind: 'added', lines: [...piece.lines] },
    );

const splitLines = (text: string): string[] => text.split(/\r\n|\n/);

export function useDbStudioManager(bridge: DbStudioBridge | undefined): DbStudioApi {
    /** Decoded lines of each file by page, so scrolling back does not re-read them. */
    const caches = useRef(new Map<string, Map<number, DbLine[]>>());
    const journalTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

    const cacheOf = (id: string) => {
        let cache = caches.current.get(id);
        if (!cache) caches.current.set(id, (cache = new Map()));
        return cache;
    };

    /* ---------- Events from the file host ---------- */

    useEffect(() => {
        if (!bridge) return;
        const live = (fileId: string) => getTab(fileId) !== undefined;

        const offProgress = bridge.onFileProgress((progress) => {
            if (!live(progress.fileId)) return;
            patchTab(progress.fileId, (tab) => {
                const patch: Partial<FileTab> = {
                    progress,
                    lineCount: Math.max(tab.lineCount, progress.lines),
                };
                if (progress.state === 'ready') {
                    // The index is complete: the document can now be edited, over a fresh table.
                    cacheOf(progress.fileId).clear();
                    const table = new LinePieceTable(progress.lines);
                    patch.table = table;
                    patch.lineCount = table.lineCount;
                    patch.version = tab.version + 1;
                    patch.journal =
                        tab.mode === 'viewer'
                            ? readJournal(tab.file.fileKey, tab.file)
                            : tab.journal;
                }
                return patch;
            });
        });
        const offItems = bridge.onItemsProgress((progress) => {
            if (!live(progress.fileId)) return;
            patchTab(progress.fileId, { itemsProgress: progress });
            const tab = getTab(progress.fileId);
            if (
                tab &&
                tab.panel === 'items' &&
                (progress.state === 'ready' || !tab.itemsView?.items.length)
            ) {
                void loadItemsFor(progress.fileId, tab.itemsView?.from ?? 0);
            }
        });
        const offHits = bridge.onSearchHits((batch) => {
            const tab = getTab(batch.fileId);
            const search = tab?.search;
            if (!tab || !search || search.searchId !== batch.searchId) return;
            const room = MAX_DISPLAYED_HITS - search.hits.length;
            if (room > 0) {
                patchTab(tab.id, {
                    search: { ...search, hits: [...search.hits, ...batch.hits.slice(0, room)] },
                });
            }
        });
        const offSearch = bridge.onSearchProgress((progress) => {
            const tab = getTab(progress.fileId);
            const search = tab?.search;
            if (!tab || !search || search.searchId !== progress.searchId) return;
            patchTab(tab.id, {
                search: {
                    ...search,
                    state: progress.state,
                    total: progress.hits,
                    bytesRead: progress.bytesRead,
                    totalBytes: progress.totalBytes,
                    truncated: progress.truncated,
                    error: progress.error?.message ?? null,
                },
            });
        });
        const offEdit = bridge.onEditProgress((progress) => {
            if (!live(progress.fileId)) return;
            patchTab(progress.fileId, {
                working: { op: progress.op, bytes: progress.bytes, total: progress.totalBytes },
            });
        });
        const offHost = bridge.onHostStatus((host) => {
            store.setState({ host });
            // The reader process died with its files open; they are gone. Unsaved edits survive in
            // the journal, so say so rather than leave tabs that silently stop answering.
            if (host.state === 'crashed' || host.state === 'failed') {
                const { order, tabs, activeId } = store.getState();
                if (Object.keys(tabs).length > 0) {
                    // Query tabs belong to the database host, not the file reader, and stay.
                    const kept = order.filter((id) => !(id in tabs));
                    store.setState({
                        tabs: {},
                        order: kept,
                        activeId:
                            activeId && kept.includes(activeId) ? activeId : (kept[0] ?? null),
                        error: 'The file reader stopped unexpectedly. Open the files again; unsaved edits can be restored.',
                    });
                    caches.current.clear();
                }
            }
        });
        void bridge
            .getStatus()
            .then((host) => store.setState({ host }))
            .catch(() => undefined);
        return () => {
            offProgress();
            offItems();
            offHits();
            offSearch();
            offEdit();
            offHost();
        };
        // `loadItemsFor` is a stable closure over `bridge`; the listeners are bound once per bridge.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [bridge]);

    /* ---------- Reading the document ---------- */

    /** Reads lines of the file as it is on disk, through a page cache. */
    const readOriginal = useCallback(
        async (id: string, from: number, count: number): Promise<string[]> => {
            const tab = getTab(id);
            if (!bridge || !tab || count <= 0) return [];
            const cache = cacheOf(id);
            const firstPage = Math.floor(from / PAGE);
            const lastPage = Math.floor((from + count - 1) / PAGE);
            for (let page = firstPage; page <= lastPage;) {
                if (cache.has(page)) {
                    page++;
                    continue;
                }
                let run = page;
                while (run + 1 <= lastPage && !cache.has(run + 1)) run++;
                const start = page * PAGE;
                const stop = (run + 1) * PAGE;
                const fetched: DbLine[] = [];
                for (let at = start; at < stop;) {
                    const result = await bridge.readLines(
                        tab.file.fileId,
                        at,
                        Math.min(1000, stop - at),
                    );
                    if (!result.ok) throw new Error(result.error.message);
                    if (result.value.lines.length === 0) break;
                    fetched.push(...result.value.lines);
                    at += result.value.lines.length;
                }
                // Reading only happens once the index is complete, so a short page is the file's
                // last one and is kept like any other.
                for (let p = page; p <= run; p++) {
                    const slice = fetched.slice((p - page) * PAGE, (p - page + 1) * PAGE);
                    if (slice.length === 0) continue;
                    cache.set(p, slice);
                    if (cache.size > MAX_CACHED_PAGES)
                        cache.delete(cache.keys().next().value as number);
                }
                page = run + 1;
            }
            const lines: string[] = [];
            for (let line = from; line < from + count; line++) {
                lines.push(cache.get(Math.floor(line / PAGE))?.[line % PAGE]?.text ?? '');
            }
            return lines;
        },
        [bridge],
    );

    const truncatedAt = useCallback(
        (id: string, original: number): boolean =>
            cacheOf(id).get(Math.floor(original / PAGE))?.[original % PAGE]?.truncated ?? false,
        [],
    );

    const readRows = useCallback(
        async (id: string, first: number, end: number): Promise<ViewRow[]> => {
            const tab = getTab(id);
            if (!bridge || !tab || end <= first) return [];
            const table = tab.table;
            if (!table) {
                // The index is still running: show what it has reached, straight from the file.
                const result = await bridge.readLines(
                    tab.file.fileId,
                    first,
                    Math.min(1000, end - first),
                );
                if (!result.ok) throw new Error(result.error.message);
                return result.value.lines.map((line) => ({
                    index: line.line,
                    text: line.text,
                    truncated: line.truncated,
                    edited: false,
                }));
            }
            const last = Math.min(end, table.lineCount);
            const lines = await table.read(first, last - first, (from, count) =>
                readOriginal(id, from, count),
            );
            return lines.map((text, offset) => {
                const index = first + offset;
                const original = table.originalLineAt(index);
                return {
                    index,
                    text,
                    edited: original === null,
                    truncated: original !== null && truncatedAt(id, original),
                };
            });
        },
        [bridge, readOriginal, truncatedAt],
    );

    /* ---------- Journal ---------- */

    const scheduleJournal = useCallback((id: string) => {
        clearTimeout(journalTimers.current.get(id));
        journalTimers.current.set(
            id,
            setTimeout(() => {
                const tab = getTab(id);
                if (!tab) return;
                if (!isDirty(tab)) return clearJournal(tab.file.fileKey);
                const base = {
                    version: 1 as const,
                    size: tab.file.size,
                    mtimeMs: tab.file.mtimeMs,
                    eol: tab.file.eol,
                };
                const ok =
                    tab.mode === 'text' && tab.text
                        ? writeJournal(tab.file.fileKey, {
                              ...base,
                              kind: 'text',
                              text: tab.text.current,
                          })
                        : tab.table
                          ? writeJournal(tab.file.fileKey, {
                                ...base,
                                kind: 'pieces',
                                pieces: piecesOf(tab.table),
                            })
                          : true;
                if (!ok && !tab.notice) {
                    patchTab(id, {
                        notice: 'These changes are too large to keep as a recovery copy. Save to keep them.',
                    });
                }
            }, 600),
        );
    }, []);

    /* ---------- Items ---------- */

    const loadItemsFor = useCallback(
        async (id: string, from: number) => {
            const tab = getTab(id);
            if (!bridge || !tab?.analyzed?.format) return;
            const result = await bridge.listItems(tab.file.fileId, from, ITEMS_PAGE);
            if (!getTab(id)) return;
            if (result.ok) patchTab(id, { itemsView: { from, ...result.value } });
            else patchTab(id, { error: result.error.message });
        },
        [bridge],
    );

    /* ---------- Actions ---------- */

    const openFile = useCallback(async () => {
        if (!bridge || store.getState().opening) return;
        store.setState({ opening: true, error: null });
        try {
            const picked = await bridge.pickFile();
            if (!picked.ok) return void store.setState({ error: picked.error.message });
            if (!picked.value) return; // cancelled
            // Only its name and size are known now; what to do with it is asked next.
            store.setState({ pending: picked.value });
        } finally {
            store.setState({ opening: false });
        }
    }, [bridge]);

    const pickFile = useCallback(async (): Promise<DbFileRef | null> => {
        if (!bridge) return null;
        const picked = await bridge.pickFile();
        if (!picked.ok) {
            store.setState({ error: picked.error.message });
            return null;
        }
        return picked.value;
    }, [bridge]);

    const cancelPending = useCallback(() => store.setState({ pending: null }), []);

    const saveText = useCallback(
        async (
            token: string | null,
            suggestedName: string,
            text: string,
        ): Promise<SaveTextResult> => {
            if (!bridge) return { kind: 'failed', message: 'Saving is part of the desktop app.' };
            const result = await bridge.saveText(token, suggestedName, text);
            if (!result.ok) return { kind: 'failed', message: result.error.message };
            if (!result.value) return { kind: 'cancelled' };
            return { kind: 'saved', token: result.value.token, name: result.value.name };
        },
        [bridge],
    );

    const readPendingText = useCallback(async (): Promise<{
        text: string;
        token: string;
        name: string;
    } | null> => {
        const pending = store.getState().pending;
        if (!bridge || !pending || pending.size > largeFileLimits().monacoMaxBytes) return null;
        const opened = await bridge.openFile(pending.token);
        if (!opened.ok) {
            store.setState({ error: opened.error.message });
            return null;
        }
        try {
            const text = await bridge.readText(opened.value.fileId);
            if (!text.ok) {
                store.setState({ error: text.error.message });
                return null;
            }
            if (text.value.lossy) {
                store.setState({ error: 'The file is not valid text, so it cannot be edited.' });
                return null;
            }
            store.setState({ pending: null });
            return { text: text.value.text, token: pending.token, name: pending.name };
        } finally {
            void bridge.closeFile(opened.value.fileId);
        }
    }, [bridge]);

    const openPending = useCallback(
        async ({ preview = false }: { preview?: boolean } = {}) => {
            const pending = store.getState().pending;
            if (!bridge || !pending || store.getState().opening) return;
            store.setState({ opening: true, error: null });
            try {
                const opened = await bridge.openFile(pending.token);
                if (!opened.ok) return void store.setState({ error: opened.error.message });
                store.setState({ pending: null });
                const file = opened.value;
                const tab: FileTab = {
                    id: file.fileId,
                    file,
                    progress: null,
                    analyzed: null,
                    itemsProgress: null,
                    itemsView: null,
                    mode: 'viewer',
                    text: null,
                    table: null,
                    version: 0,
                    lineCount: 0,
                    topLine: 0,
                    selection: null,
                    reveal: null,
                    findOpen: false,
                    search: null,
                    panel: 'none',
                    working: null,
                    error: null,
                    notice: null,
                    journal: null,
                };
                store.setState((state) => ({
                    tabs: { ...state.tabs, [tab.id]: tab },
                    order: [...state.order, tab.id],
                    activeId: tab.id,
                }));

                // Small files open in the full text editor (when they are valid text).
                if (!preview && handlingFor(file.size) !== 'stream') {
                    const text = await bridge.readText(file.fileId);
                    if (text.ok && !text.value.lossy && getTab(file.fileId)) {
                        patchTab(file.fileId, {
                            mode: 'text',
                            text: { current: text.value.text, saved: text.value.text },
                            journal: readJournal(file.fileKey, file),
                        });
                    }
                }
                const analyzed = await bridge.analyzeFile(file.fileId, 'auto');
                if (analyzed.ok && getTab(file.fileId))
                    patchTab(file.fileId, { analyzed: analyzed.value });
            } finally {
                store.setState({ opening: false });
            }
        },
        [bridge],
    );

    const closeTab = useCallback(
        async (id: string, options: { discard?: boolean } = {}) => {
            const tab = getTab(id);
            if (!tab) return;
            if (isDirty(tab) && !options.discard) {
                const answer = await confirmAction({
                    title: `Close ${tab.file.name}?`,
                    message:
                        'It has changes that are not saved. A recovery copy is kept and offered the next time you open the file.',
                    confirmLabel: 'Close without saving',
                    danger: true,
                });
                if (answer !== 'confirm') return;
            } else if (!isDirty(tab)) {
                clearJournal(tab.file.fileKey);
            }
            clearTimeout(journalTimers.current.get(id));
            caches.current.delete(id);
            store.setState((state) => {
                const rest = { ...state.tabs };
                delete rest[id];
                const order = state.order.filter((item) => item !== id);
                const index = state.order.indexOf(id);
                return {
                    tabs: rest,
                    order,
                    activeId:
                        state.activeId === id
                            ? (order[Math.min(index, order.length - 1)] ?? null)
                            : state.activeId,
                };
            });
            if (bridge) {
                if (tab.search?.state === 'running') await bridge.cancelSearch(tab.search.searchId);
                await bridge.closeFile(id);
            }
        },
        [bridge],
    );

    const activateTab = useCallback((id: string) => {
        if (getTab(id) || isQueryTabId(id)) store.setState({ activeId: id });
    }, []);

    const setMode = useCallback(
        async (id: string, mode: EditorMode) => {
            const tab = getTab(id);
            if (!bridge || !tab || tab.mode === mode) return;
            if (isDirty(tab)) {
                notifications.show({
                    color: 'yellow',
                    message: 'Save your changes before switching the editor.',
                });
                return;
            }
            if (mode === 'text') {
                if (handlingFor(tab.file.size) === 'stream') return;
                const text = await bridge.readText(id);
                if (!text.ok) return void patchTab(id, { error: text.error.message });
                if (text.value.lossy) {
                    return void patchTab(id, {
                        error: 'This file is not valid UTF-8, so it cannot be edited as text.',
                    });
                }
                patchTab(id, {
                    mode,
                    text: { current: text.value.text, saved: text.value.text },
                    error: null,
                });
            } else {
                patchTab(id, { mode, text: null });
            }
        },
        [bridge],
    );

    const setTopLine = useCallback(
        (id: string, line: number) => patchTab(id, { topLine: line }),
        [],
    );

    const goToLine = useCallback((id: string, line: number) => {
        const tab = getTab(id);
        if (!tab || !Number.isFinite(line)) return;
        const target = Math.max(0, Math.min(Math.max(0, tab.lineCount - 1), Math.floor(line) - 1));
        patchTab(id, {
            reveal: { line: target, nonce: (tab.reveal?.nonce ?? 0) + 1 },
            selection: selectLine(target),
        });
    }, []);

    const select = useCallback((id: string, line: number, extend: boolean) => {
        patchTab(id, (tab) => ({
            selection:
                extend && tab.selection ? extendSelection(tab.selection, line) : selectLine(line),
        }));
    }, []);

    const copySelection = useCallback(
        async (id: string) => {
            const tab = getTab(id);
            if (!tab?.selection || !tab.table) return;
            const { first, last } = selectionBounds(tab.selection);
            const parts: string[] = [];
            let characters = 0;
            for (let at = first; at <= last; at += 1000) {
                const rows = await readRows(id, at, Math.min(last + 1, at + 1000));
                for (const row of rows) {
                    characters += row.text.length + 1;
                    parts.push(row.text);
                }
                if (characters > MAX_COPY_CHARS) {
                    notifications.show({
                        color: 'yellow',
                        message:
                            'The selection is too large to copy in one go; the first part was copied.',
                    });
                    break;
                }
            }
            await copyText(parts.join(tab.file.eol));
            notifications.show({
                color: 'teal',
                message: `Copied ${parts.length.toLocaleString('en-US')} line${parts.length === 1 ? '' : 's'}.`,
                autoClose: 2000,
            });
        },
        [readRows],
    );

    const edited = useCallback(
        (id: string, change: (table: LinePieceTable) => void) => {
            const tab = getTab(id);
            if (!tab?.table || tab.working) return;
            change(tab.table);
            touch(id);
            scheduleJournal(id);
        },
        [scheduleJournal],
    );

    const setLine = useCallback(
        (id: string, index: number, text: string) =>
            edited(id, (table) => table.setLine(index, text)),
        [edited],
    );

    const insertLines = useCallback(
        (id: string, at: number, lines: string[]) => {
            edited(id, (table) => table.insert(at, lines));
            patchTab(id, { selection: selectLine(at) });
        },
        [edited],
    );

    const deleteSelection = useCallback(
        (id: string) => {
            const tab = getTab(id);
            if (!tab?.selection || !tab.table) return;
            const { first, last } = selectionBounds(tab.selection);
            edited(id, (table) => table.delete(first, last - first + 1));
            patchTab(id, (current) => ({
                selection:
                    current.table && current.table.lineCount > 0
                        ? selectLine(Math.min(first, current.table.lineCount - 1))
                        : null,
            }));
        },
        [edited],
    );

    const pasteAfterSelection = useCallback(
        async (id: string) => {
            const tab = getTab(id);
            if (!tab?.table) return;
            const text = await readClipboardText().catch(() => '');
            if (!text) return;
            const at = tab.selection
                ? selectionBounds(tab.selection).last + 1
                : tab.table.lineCount;
            insertLines(id, at, splitLines(text.replace(/(\r?\n)$/, '')));
        },
        [insertLines],
    );

    const undo = useCallback((id: string) => edited(id, (table) => table.undo()), [edited]);
    const redo = useCallback((id: string) => edited(id, (table) => table.redo()), [edited]);

    const setText = useCallback(
        (id: string, text: string) => {
            patchTab(id, (tab) => (tab.text ? { text: { ...tab.text, current: text } } : {}));
            scheduleJournal(id);
        },
        [scheduleJournal],
    );

    /** After the file was rewritten on disk: its index is rebuilt, and unsaved state is reset. */
    const afterWrite = (
        id: string,
        saved: { name: string; size: number; eol: DbLineEnding; fileKey: string; mtimeMs: number },
    ) => {
        const previous = getTab(id);
        if (previous) clearJournal(previous.file.fileKey);
        clearTimeout(journalTimers.current.get(id));
        cacheOf(id).clear();
        patchTab(id, (tab) => ({
            file: {
                ...tab.file,
                name: saved.name,
                size: saved.size,
                eol: saved.eol,
                fileKey: saved.fileKey,
                mtimeMs: saved.mtimeMs,
            },
            table: null, // rebuilt when the new index is ready
            text: tab.text ? { current: tab.text.current, saved: tab.text.current } : null,
            progress: null,
            analyzed: null,
            itemsProgress: null,
            itemsView: null,
            search: null,
            selection: null,
            working: null,
            notice: null,
            journal: null,
            version: tab.version + 1,
        }));
        // Statements and documents are re-found in the new content.
        void bridge?.analyzeFile(id, 'auto').then((analyzed) => {
            if (analyzed.ok && getTab(id)) patchTab(id, { analyzed: analyzed.value });
        });
    };

    const writePieces = (tab: FileTab): DbSavePiece[] | null => {
        if (tab.mode === 'text' && tab.text)
            return [{ kind: 'added', lines: splitLines(tab.text.current) }];
        return tab.table ? piecesOf(tab.table) : null;
    };

    const save = useCallback(
        async (id: string): Promise<boolean> => {
            const tab = getTab(id);
            if (!bridge || !tab || tab.working) return false;
            const pieces = writePieces(tab);
            if (!pieces) {
                patchTab(id, { error: 'The file is still being indexed. Try again in a moment.' });
                return false;
            }
            patchTab(id, { working: { op: 'save', bytes: 0, total: tab.file.size }, error: null });
            const result = await bridge.saveFile(id, pieces, tab.file.eol);
            if (!result.ok) {
                patchTab(id, { working: null, error: result.error.message });
                return false;
            }
            afterWrite(id, result.value);
            notifications.show({
                color: 'teal',
                message: `Saved ${result.value.name}.`,
                autoClose: 2000,
            });
            return true;
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [bridge],
    );

    const saveAs = useCallback(
        async (id: string): Promise<boolean> => {
            const tab = getTab(id);
            if (!bridge || !tab || tab.working) return false;
            const pieces = writePieces(tab);
            if (!pieces) {
                patchTab(id, { error: 'The file is still being indexed. Try again in a moment.' });
                return false;
            }
            patchTab(id, { working: { op: 'save', bytes: 0, total: tab.file.size }, error: null });
            const result = await bridge.saveFileAs(id, pieces, tab.file.eol);
            if (!result.ok) {
                patchTab(id, { working: null, error: result.error.message });
                return false;
            }
            if (!result.value) {
                patchTab(id, { working: null });
                return false;
            }
            afterWrite(id, result.value);
            notifications.show({
                color: 'teal',
                message: `Saved ${result.value.name}.`,
                autoClose: 2000,
            });
            return true;
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [bridge],
    );

    const restoreJournal = useCallback((id: string) => {
        const tab = getTab(id);
        const journal = tab?.journal;
        if (!tab || !journal) return;
        if (journal.kind === 'text' && tab.text) {
            patchTab(id, { text: { ...tab.text, current: journal.text }, journal: null });
        } else if (journal.kind === 'pieces' && tab.table) {
            try {
                tab.table.restore(
                    journal.pieces.map((piece): Piece =>
                        piece.kind === 'original' ? piece : { kind: 'added', lines: piece.lines },
                    ),
                );
                touch(id, { journal: null });
            } catch {
                clearJournal(tab.file.fileKey);
                patchTab(id, {
                    journal: null,
                    error: 'The recovery copy does not fit this file any more, so it was discarded.',
                });
            }
        } else {
            // The recovery copy is for the other editor mode; keep it until that mode is open.
            patchTab(id, {
                notice: 'Switch to the editor that was used when the changes were made to restore them.',
            });
        }
    }, []);

    const discardJournal = useCallback((id: string) => {
        const tab = getTab(id);
        if (!tab) return;
        clearJournal(tab.file.fileKey);
        patchTab(id, { journal: null });
    }, []);

    const setFindOpen = useCallback((id: string, open: boolean) => {
        patchTab(id, (tab) => ({
            findOpen: open,
            panel: open ? tab.panel : tab.panel === 'results' ? 'none' : tab.panel,
        }));
    }, []);

    const cancelSearch = useCallback(
        async (id: string) => {
            const search = getTab(id)?.search;
            if (!bridge || !search || (search.state !== 'running' && search.state !== 'starting'))
                return;
            await bridge.cancelSearch(search.searchId);
        },
        [bridge],
    );

    const search = useCallback(
        async (id: string, query: DbSearchQuery) => {
            const tab = getTab(id);
            if (!bridge || !tab) return;
            if (tab.search && (tab.search.state === 'running' || tab.search.state === 'starting')) {
                await bridge.cancelSearch(tab.search.searchId);
            }
            const searchId = newSearchId();
            patchTab(id, {
                panel: 'results',
                search: {
                    searchId,
                    query,
                    state: 'starting',
                    hits: [],
                    total: 0,
                    bytesRead: 0,
                    totalBytes: tab.file.size,
                    truncated: false,
                    error: null,
                    current: -1,
                },
            });
            const started = await bridge.startSearch(id, searchId, query);
            const latest = getTab(id)?.search;
            if (!latest || latest.searchId !== searchId) return; // replaced or closed meanwhile
            if (!started.ok)
                patchTab(id, {
                    search: { ...latest, state: 'failed', error: started.error.message },
                });
            else if (latest.state === 'starting')
                patchTab(id, { search: { ...latest, state: 'running' } });
        },
        [bridge],
    );

    const gotoHit = useCallback(
        (id: string, index: number) => {
            const found = getTab(id)?.search;
            const hit = found?.hits[index];
            if (!found || !hit) return;
            patchTab(id, { search: { ...found, current: index } });
            goToLine(id, hit.line + 1);
        },
        [goToLine],
    );

    const stepHit = useCallback(
        (id: string, direction: 1 | -1) => {
            const found = getTab(id)?.search;
            if (!found || found.hits.length === 0) return;
            gotoHit(id, (found.current + direction + found.hits.length) % found.hits.length);
        },
        [gotoHit],
    );

    const replaceAll = useCallback(
        async (id: string, query: DbSearchQuery, replacement: string) => {
            const tab = getTab(id);
            if (!bridge || !tab || tab.working) return;
            if (isDirty(tab)) {
                notifications.show({
                    color: 'yellow',
                    message: 'Save your changes before replacing in the whole file.',
                });
                return;
            }
            const answer = await confirmAction({
                title: 'Replace in the whole file?',
                message: `Every match of “${query.text}” in ${tab.file.name} will be replaced with “${replacement}” and the file saved. This cannot be undone.`,
                confirmLabel: 'Replace all',
                danger: true,
            });
            if (answer !== 'confirm') return;
            patchTab(id, {
                working: { op: 'replace', bytes: 0, total: tab.file.size },
                error: null,
            });
            const result = await bridge.replaceAll(id, query, replacement);
            if (!result.ok) {
                patchTab(id, { working: null, error: result.error.message });
                return;
            }
            afterWrite(id, result.value);
            if (tab.mode === 'text') {
                const text = await bridge.readText(id);
                if (text.ok)
                    patchTab(id, { text: { current: text.value.text, saved: text.value.text } });
            }
            notifications.show({
                color: result.value.replacements > 0 ? 'teal' : 'blue',
                message: `${result.value.replacements.toLocaleString('en-US')} replacement${result.value.replacements === 1 ? '' : 's'} made.`,
                autoClose: 3000,
            });
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [bridge],
    );

    const setPanel = useCallback(
        (id: string, panel: BottomPanel) => {
            patchTab(id, { panel });
            const tab = getTab(id);
            if (panel === 'items' && tab && !tab.itemsView) void loadItemsFor(id, 0);
        },
        [loadItemsFor],
    );

    const loadItems = loadItemsFor;

    const readItem = useCallback(
        async (id: string, index: number) => {
            if (!bridge || !getTab(id)) return null;
            const result = await bridge.readItem(id, index);
            return result.ok ? result.value : null;
        },
        [bridge],
    );

    return useMemo(
        () =>
            bridge
                ? {
                      available: true,
                      openFile,
                      openPending,
                      readPendingText,
                      saveText,
                      cancelPending,
                      pickFile,
                      closeTab,
                      activateTab,
                      setMode,
                      readRows,
                      setTopLine,
                      goToLine,
                      select,
                      copySelection,
                      setLine,
                      insertLines,
                      deleteSelection,
                      pasteAfterSelection,
                      undo,
                      redo,
                      setText,
                      save,
                      saveAs,
                      restoreJournal,
                      discardJournal,
                      setFindOpen,
                      search,
                      cancelSearch,
                      stepHit,
                      gotoHit,
                      replaceAll,
                      setPanel,
                      loadItems,
                      readItem,
                  }
                : UNAVAILABLE,
        [
            bridge,
            openFile,
            openPending,
            readPendingText,
            saveText,
            cancelPending,
            pickFile,
            closeTab,
            activateTab,
            setMode,
            readRows,
            setTopLine,
            goToLine,
            select,
            copySelection,
            setLine,
            insertLines,
            deleteSelection,
            pasteAfterSelection,
            undo,
            redo,
            setText,
            save,
            saveAs,
            restoreJournal,
            discardJournal,
            setFindOpen,
            search,
            cancelSearch,
            stepHit,
            gotoHit,
            replaceAll,
            setPanel,
            loadItems,
            readItem,
        ],
    );
}
