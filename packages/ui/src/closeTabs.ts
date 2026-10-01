/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { confirmAction } from './confirm';
import { useWorkbenchStore } from './store';
import { notifications } from './kit';

export interface CloseTabsDeps {
    /** Writes a request's draft; resolves false when the write failed. */
    saveRequest: (id: string) => Promise<boolean>;
    /** Aborts an in-flight send for a tab that is going away. */
    cancelRequest: (id: string) => void;
}

const nameOf = (id: string) =>
    useWorkbenchStore.getState().workspace.requests.find((request) => request.id === id)?.name ??
    'this request';

/**
 * Closes one or more tabs as a single operation.
 *
 * All of the modified tabs are covered by one prompt, so no tab is asked about twice, and the
 * choice applies to the whole set. Saved tabs never raise a prompt. A tab whose save fails is
 * kept open while the rest still close, and nothing closes if the prompt is cancelled.
 */
export async function closeTabs(ids: Iterable<string>, deps: CloseTabsDeps): Promise<void> {
    const state = useWorkbenchStore.getState();
    const wanted = new Set(ids);
    // De-duplicated, in strip order, ignoring anything that is no longer open.
    const targets = state.workspace.openRequestIds.filter((id) => wanted.has(id));
    if (!targets.length) return;

    const modified = targets.filter((id) => state.drafts[id]);
    const kept = new Set<string>();
    if (modified.length) {
        const choice = await confirmAction({
            title: 'Unsaved changes',
            message:
                modified.length === 1
                    ? `Save the changes to “${nameOf(modified[0]!)}” before closing it?`
                    : `${modified.length} open requests have unsaved changes. Save them before closing?`,
            confirmLabel: 'Save and close',
            alternateLabel: 'Close without saving',
        });
        if (choice === 'cancel') return;
        if (choice === 'confirm') {
            for (const id of modified) if (!(await deps.saveRequest(id))) kept.add(id);
            if (kept.size) {
                notifications.show({
                    color: 'red',
                    title: 'Save failed',
                    message:
                        kept.size === 1
                            ? `“${nameOf([...kept][0]!)}” could not be saved, so its tab was kept open.`
                            : `${kept.size} requests could not be saved, so their tabs were kept open.`,
                });
            }
        } else {
            const store = useWorkbenchStore.getState();
            for (const id of modified) store.discardDraft(id);
        }
    }

    const closing = targets.filter((id) => !kept.has(id));
    if (!closing.length) return;
    for (const id of closing) deps.cancelRequest(id);
    useWorkbenchStore.getState().closeRequests(closing);
}
