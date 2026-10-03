/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import type { DbQuerySnapshot } from '@httpreq/shared';
import { patchQuery, patchRun, useHistory, type QueryTab, type StatementLog } from './queryStore';
import { emptyView, type StatementRun } from './resultSession';
import type { ExecutionEvent } from './statementExecution';

/**
 * Applies execution events to a query tab: one place that writes the runs, the message log and the
 * history, so the tab only ever reads them. The events come from `executeStatements` (what the
 * script does) and from the host's own `query.state` pushes (what a statement's result looks like
 * as it arrives).
 */
export interface ExecutionContext {
    tabId: string;
    profileId: string;
}

/** Whether a snapshot describes a result the previous one did not (new columns or result sets). */
export const changesShape = (before: DbQuerySnapshot | null, after: DbQuerySnapshot): boolean => {
    if (!before || before.results.length !== after.results.length) return true;
    return after.results.some((result, i) => {
        const earlier = before.results[i]!;
        return (
            earlier.columns.length !== result.columns.length ||
            earlier.affectedRows !== result.affectedRows ||
            earlier.complete !== result.complete
        );
    });
};

const entryOf = (event: Extract<ExecutionEvent, { type: 'statementStarted' }>): StatementRun => ({
    index: event.statement.index,
    runId: event.statement.runId,
    sql: event.statement.preview,
    kind: event.statement.kind,
    snapshot: null,
    resultIndex: 0,
    view: emptyView(),
});

const setLog = (tabId: string, entry: StatementLog) =>
    patchQuery(tabId, (tab) => {
        const log = [...tab.log];
        log[entry.index] = entry;
        return { log };
    });

const finishedLog = (
    statement: { index: number; preview: string },
    snapshot: DbQuerySnapshot,
): { entry: StatementLog; state: 'done' | 'failed' | 'cancelled' } => {
    const first = snapshot.results[0];
    const last = snapshot.results.at(-1);
    const state = snapshot.state === 'running' ? 'done' : snapshot.state;
    return {
        state,
        entry: {
            index: statement.index,
            sql: statement.preview,
            state,
            elapsedMs: snapshot.elapsedMs,
            ...(first ? { rows: snapshot.results.reduce((sum, r) => sum + r.rowCount, 0) } : {}),
            ...(last?.affectedRows !== undefined ? { affectedRows: last.affectedRows } : {}),
            ...(snapshot.error ? { message: snapshot.error.message } : {}),
        },
    };
};

/** Applies one event to the tab's state. */
export function applyExecutionEvent(
    context: ExecutionContext,
    event: ExecutionEvent,
    currentTab: () => QueryTab | undefined,
): void {
    const { tabId, profileId } = context;
    switch (event.type) {
        case 'executionStarted':
            return;
        case 'statementStarted': {
            const entry = entryOf(event);
            setLog(tabId, { index: entry.index, sql: entry.sql, state: 'running' });
            // Every statement gets its own result entry, appended in order; nothing is closed here,
            // so earlier results stay readable beside this one.
            patchQuery(tabId, (tab) => {
                // The newest result is shown unless the user has moved to another one.
                const following = tab.activeRun === null || tab.activeRun === entry.index - 1;
                return {
                    runs: [...tab.runs, entry],
                    activeRun: following ? entry.index : tab.activeRun,
                };
            });
            return;
        }
        case 'resultMetadataAvailable':
        case 'resultRowsAvailable':
            // Each statement keeps its own snapshot; one statement's progress never touches another's.
            patchRun(tabId, event.runId, (run) => ({
                snapshot: event.snapshot,
                resultIndex: Math.min(
                    run.resultIndex,
                    Math.max(0, event.snapshot.results.length - 1),
                ),
            }));
            return;
        case 'statementTruncated':
            patchRun(tabId, event.runId, { truncated: true });
            return;
        case 'statementCompleted': {
            const { entry, state } = finishedLog(event.statement, event.snapshot);
            setLog(tabId, entry);
            const first = event.snapshot.results[0];
            const last = event.snapshot.results.at(-1);
            useHistory.getState().add({
                profileId,
                sql: event.statement.sql,
                at: Date.now(),
                elapsedMs: event.snapshot.elapsedMs,
                state,
                ...(first ? { rows: first.rowCount } : {}),
                ...(last?.affectedRows !== undefined ? { affectedRows: last.affectedRows } : {}),
                ...(event.snapshot.error ? { error: event.snapshot.error.message } : {}),
            });
            // A failure shows the message log, where the error is written out in full.
            if (state === 'failed') patchQuery(tabId, { bottom: 'messages' });
            return;
        }
        case 'statementFailed': {
            setLog(tabId, {
                index: event.statement.index,
                sql: event.statement.preview,
                state: 'failed',
                message: event.message,
            });
            useHistory.getState().add({
                profileId,
                sql: event.statement.sql,
                at: Date.now(),
                elapsedMs: 0,
                state: 'failed',
                error: event.message,
            });
            patchRun(tabId, event.statement.runId, {
                snapshot: {
                    state: 'failed',
                    results: [],
                    elapsedMs: 0,
                    paused: false,
                    error: { code: 'INTERNAL', message: event.message },
                },
            });
            patchQuery(tabId, { bottom: 'messages' });
            return;
        }
        case 'executionCancelled':
            return;
        case 'executionCompleted':
            if (currentTab()) patchQuery(tabId, { running: false });
            return;
    }
}
