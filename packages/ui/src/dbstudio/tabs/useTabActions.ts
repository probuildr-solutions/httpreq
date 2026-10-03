/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { useCallback, useMemo } from 'react';
import { confirmAction } from '../../confirm';
import { notifications } from '../../kit';
import { closeAdminTabNow, isAdminTabId, openAdminTab, useAdmin } from '../admin/adminStore';
import { isQueryDirty, isQueryTabId, patchQuery, useQueries } from '../db/queryStore';
import { useDbManager } from '../db/useDbManager';
import { isDirty, useStudioStore } from '../studioStore';
import { useDbStudio } from '../useDbStudio';
import { closeTargets, moveTab, nextActive, pinnedFirst, type CloseMode } from './tabCommands';
import {
    forgetTab,
    isPinned,
    rememberClosed,
    setCustomTitle,
    setPinned,
    takeClosed,
    useTabMeta,
} from './tabMetaStore';

const describeList = (names: string[]): string => {
    const shown = names.slice(0, 5).map((name) => `“${name}”`);
    const more = names.length - shown.length;
    return more > 0 ? `${shown.join(', ')} and ${more} more` : shown.join(', ');
};

const sqlName = (title: string) => (/\.[A-Za-z0-9]+$/.test(title) ? title : `${title}.sql`);

/**
 * Everything a tab can be asked to do, once, for every kind of tab. Closing several tabs is one
 * operation with one question (never one dialog per tab); a tab that could not be saved stays open;
 * a closed query tab can be reopened.
 */
export function useTabActions() {
    const manager = useDbManager();
    const studio = useDbStudio();

    const saveQuery = useCallback(
        async (id: string, options: { as?: boolean } = {}): Promise<boolean> => {
            const tab = useQueries.getState().tabs[id];
            if (!tab) return true;
            const result = await studio.saveText(
                options.as ? null : (tab.source?.token ?? null),
                tab.source?.name ?? sqlName(tab.title),
                tab.text,
            );
            if (result.kind === 'cancelled') return false;
            if (result.kind === 'failed') {
                notifications.show({
                    color: 'red',
                    title: `Could not save ${tab.title}`,
                    message: result.message,
                });
                return false;
            }
            patchQuery(id, {
                savedText: tab.text,
                source: { token: result.token, name: result.name },
                // A new file name is a new title, unless the user named the tab something else.
                title: tab.source || tab.title.startsWith('Query ') ? result.name : tab.title,
            });
            return true;
        },
        [studio],
    );

    const saveTab = useCallback(
        async (id: string, options: { as?: boolean } = {}): Promise<boolean> => {
            if (isQueryTabId(id)) return saveQuery(id, options);
            const file = useStudioStore.getState().tabs[id];
            if (file) return options.as ? studio.saveAs(id) : studio.save(id);
            return true;
        },
        [saveQuery, studio],
    );

    /** Closes tabs without asking anything. */
    const closeNow = useCallback(
        async (ids: string[]) => {
            const closing = new Set(ids);
            const { order, activeId } = useStudioStore.getState();
            const next = nextActive(order, closing, activeId);
            for (const id of ids) {
                if (isQueryTabId(id)) {
                    const tab = useQueries.getState().tabs[id];
                    if (tab && (tab.text.trim() !== '' || tab.source)) {
                        rememberClosed({
                            title: tab.title,
                            text: tab.text,
                            profileId: tab.profileId,
                            database: tab.database,
                            schema: tab.schema,
                            source: tab.source,
                            pinned: isPinned(id),
                            closedAt: Date.now(),
                        });
                    }
                    await manager.closeQuery(id, { silent: true });
                } else if (isAdminTabId(id)) {
                    closeAdminTabNow(id);
                    useStudioStore.setState((state) => ({
                        order: state.order.filter((item) => item !== id),
                    }));
                } else {
                    await studio.closeTab(id, { discard: true });
                }
                forgetTab(id);
            }
            useStudioStore.setState((state) => ({
                activeId:
                    state.activeId !== null && closing.has(state.activeId) ? next : state.activeId,
            }));
        },
        [manager, studio],
    );

    /**
     * Closes tabs as one operation. Tabs with unsaved changes, and query tabs with a transaction
     * still open, are covered by one question for the whole set; Cancel leaves everything open.
     */
    const closeTabs = useCallback(
        async (ids: string[]) => {
            const { order, tabs: files } = useStudioStore.getState();
            const queries = useQueries.getState().tabs;
            const admin = useAdmin.getState().tabs;
            const targets = order.filter((id) => ids.includes(id));
            if (targets.length === 0) return;

            const nameOf = (id: string) =>
                queries[id]?.title ?? admin[id]?.title ?? files[id]?.file.name ?? id;
            const savable = targets.filter(
                (id) =>
                    (queries[id] && isQueryDirty(queries[id])) ||
                    (files[id] && isDirty(files[id]!)),
            );
            const unsavable = targets.filter((id) => admin[id]?.dirty);
            const transactions = targets.filter((id) => queries[id]?.inTransaction);

            const kept = new Set<string>();
            if (savable.length + unsavable.length + transactions.length > 0) {
                const parts: string[] = [];
                if (savable.length)
                    parts.push(
                        `${describeList(savable.map(nameOf))} ${savable.length === 1 ? 'has' : 'have'} changes that are not saved.`,
                    );
                if (unsavable.length)
                    parts.push(
                        `${describeList(unsavable.map(nameOf))} ${unsavable.length === 1 ? 'has' : 'have'} changes that have not been applied to the database and cannot be saved to a file.`,
                    );
                if (transactions.length)
                    parts.push(
                        `${describeList(transactions.map(nameOf))} ${transactions.length === 1 ? 'has' : 'have'} a transaction that was started and not finished.`,
                    );
                const choice = await confirmAction({
                    title:
                        targets.length === 1
                            ? `Close ${nameOf(targets[0]!)}?`
                            : `Close ${targets.length} tabs?`,
                    message: parts.join(' '),
                    confirmLabel: savable.length ? 'Save and close' : 'Close anyway',
                    alternateLabel: savable.length ? 'Close without saving' : undefined,
                    danger: !savable.length,
                });
                if (choice === 'cancel') return;
                if (choice === 'confirm' && savable.length) {
                    for (const id of savable) if (!(await saveTab(id))) kept.add(id);
                    if (kept.size) {
                        notifications.show({
                            color: 'yellow',
                            message:
                                kept.size === 1
                                    ? `“${nameOf([...kept][0]!)}” was not saved, so its tab was kept open.`
                                    : `${kept.size} tabs were not saved, so they were kept open.`,
                        });
                    }
                }
            }
            await closeNow(targets.filter((id) => !kept.has(id)));
        },
        [closeNow, saveTab],
    );

    const closeBy = useCallback(
        (id: string, mode: CloseMode, includePinned = false) => {
            const meta = useTabMeta.getState().meta;
            const strip = useStudioStore
                .getState()
                .order.map((tabId) => ({ id: tabId, pinned: meta[tabId]?.pinned === true }));
            return closeTabs(closeTargets(strip, id, mode, includePinned));
        },
        [closeTabs],
    );

    const rename = useCallback((id: string, title: string) => {
        const name = title.trim();
        if (!name) return;
        if (isQueryTabId(id)) patchQuery(id, { title: name });
        else if (isAdminTabId(id))
            useAdmin.setState((s) => ({
                tabs: { ...s.tabs, [id]: { ...s.tabs[id]!, title: name } },
            }));
        else setCustomTitle(id, name);
    }, []);

    const duplicate = useCallback(
        (id: string): string | null => {
            const query = useQueries.getState().tabs[id];
            if (query) {
                const copy = manager.newQuery(query.profileId, query.text, `${query.title} (copy)`);
                // The copy is unsaved work of its own, and runs where the original runs.
                patchQuery(copy, {
                    database: query.database,
                    schema: query.schema,
                    savedText: '',
                });
                return copy;
            }
            const admin = useAdmin.getState().tabs[id];
            if (admin) return openAdminTab({ ...admin, state: undefined }, { fresh: true });
            const file = useStudioStore.getState().tabs[id];
            if (file?.text) {
                const copy = manager.newQuery(null, file.text.current, `${file.file.name} (copy)`);
                patchQuery(copy, { savedText: '' });
                return copy;
            }
            return null;
        },
        [manager],
    );

    const canDuplicate = useCallback((id: string): boolean => {
        if (isQueryTabId(id) || isAdminTabId(id)) return true;
        return !!useStudioStore.getState().tabs[id]?.text;
    }, []);

    const pin = useCallback((id: string, pinned: boolean) => {
        setPinned([id], pinned);
        const meta = useTabMeta.getState().meta;
        const set = new Set(Object.keys(meta).filter((key) => meta[key]?.pinned));
        useStudioStore.setState((state) => ({ order: pinnedFirst(state.order, set) }));
    }, []);

    const move = useCallback((id: string, beforeId: string) => {
        const meta = useTabMeta.getState().meta;
        const pinned = new Set(Object.keys(meta).filter((key) => meta[key]?.pinned));
        useStudioStore.setState((state) => ({ order: moveTab(state.order, id, beforeId, pinned) }));
    }, []);

    const reopenClosed = useCallback((): string | null => {
        const closed = takeClosed();
        if (!closed) return null;
        const id = manager.newQuery(closed.profileId, closed.text, closed.title);
        patchQuery(id, {
            database: closed.database,
            schema: closed.schema,
            source: closed.source,
            // Reopened text that differs from its file (or had no file) is still unsaved work.
            savedText: '',
        });
        if (closed.pinned) pin(id, true);
        return id;
    }, [manager, pin]);

    return useMemo(
        () => ({
            saveTab,
            closeTabs,
            closeBy,
            rename,
            duplicate,
            canDuplicate,
            pin,
            move,
            reopenClosed,
        }),
        [saveTab, closeTabs, closeBy, rename, duplicate, canDuplicate, pin, move, reopenClosed],
    );
}
