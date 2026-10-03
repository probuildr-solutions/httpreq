/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import type { DbQuerySnapshot } from '@httpreq/shared';
import type { DbApi } from './dbApi';
import { statementKind } from './resultSession';

/**
 * Runs the statements of a script one after another on a connection and reports what happens as
 * events. It knows the host (through `DbApi`) and nothing about tabs, stores or components: the
 * query tab receives the events (see `executionEvents.ts`) and never drives the host itself. This
 * keeps execution, cancellation and the "read on before the next statement" rule in one place that
 * can be tested without a window.
 *
 *   executeStatements ──► ExecutionEvent ──► applyExecutionEvent ──► query store ──► UI
 *          │
 *          └─► DbApi (startQuery, demand)         the host streams rows to its own spool
 */
export interface StatementInfo {
    /** The statement's number in this execution, from 0. */
    index: number;
    /** The host's id for the statement. */
    runId: string;
    /** The whole statement, for the history. */
    sql: string;
    /** The beginning of the statement, on one line, for lists and tabs. */
    preview: string;
    /** `SELECT`, `UPDATE`… */
    kind: string;
}

export type ExecutionOutcome = 'completed' | 'failed' | 'cancelled';

export type ExecutionEvent =
    | { type: 'executionStarted'; statements: number }
    | { type: 'statementStarted'; statement: StatementInfo }
    /** The host reported the shape of a result (its columns, or that there are none). */
    | { type: 'resultMetadataAvailable'; runId: string; snapshot: DbQuerySnapshot }
    /** The host has read more rows of a result it already described. */
    | { type: 'resultRowsAvailable'; runId: string; snapshot: DbQuerySnapshot }
    /** The statement was followed by another and its rows were read only up to the limit. */
    | { type: 'statementTruncated'; runId: string }
    | { type: 'statementCompleted'; statement: StatementInfo; snapshot: DbQuerySnapshot }
    | { type: 'statementFailed'; statement: StatementInfo; message: string }
    | { type: 'executionCompleted'; outcome: ExecutionOutcome }
    | { type: 'executionCancelled' };

/** Resolves when a statement stops running, or pauses because the window has all it asked for. */
export type Settle = (snapshot: DbQuerySnapshot) => void;

export interface ExecutionDeps {
    db: Pick<DbApi, 'startQuery' | 'demand'>;
    /** The host's `query.state` events call the entry of a query when it settles. */
    settled: Map<string, Settle>;
    connectionId: string;
    timeoutMs?: number;
    /**
     * How many rows an earlier, row-returning statement is read to before the next statement
     * starts. The host cancels a result that is merely waiting to be scrolled when the connection
     * is needed again; reading it on first, to this limit, keeps more than its first screen. The
     * rows go to the host's spool on disk, not into the window.
     */
    rowLimit: number;
    newId: () => string;
    /** Called with the time each statement started, so a duration can be shown. */
    onStart?: (runId: string) => void;
}

const lastIndexWhere = <T>(items: readonly T[], test: (item: T) => boolean): number => {
    for (let index = items.length - 1; index >= 0; index--) if (test(items[index]!)) return index;
    return -1;
};

/**
 * Reads a paused result on until it is complete or `limit` rows are in, waiting for the host to
 * pause or finish again each time. Stop still works while it waits: cancelling the statement makes
 * the host report a settled state, which ends the wait.
 */
export async function readOn(
    deps: Pick<ExecutionDeps, 'db' | 'settled'>,
    runId: string,
    first: DbQuerySnapshot,
    limit: number,
): Promise<DbQuerySnapshot> {
    let snapshot = first;
    while (snapshot.paused) {
        const index = lastIndexWhere(snapshot.results, (r) => r.columns.length > 0 && !r.complete);
        const target = snapshot.results[index];
        if (!target || target.rowCount >= limit) break;
        const waiting = new Promise<DbQuerySnapshot>((resolve) => deps.settled.set(runId, resolve));
        try {
            await deps.db.demand(runId, target.index, limit);
        } catch {
            deps.settled.delete(runId);
            break;
        }
        snapshot = await waiting;
    }
    deps.settled.delete(runId);
    return snapshot;
}

/** Runs the statements in order and says what happened. Stops at the first failure or cancel. */
export async function executeStatements(
    deps: ExecutionDeps,
    statements: readonly { sql: string }[],
    emit: (event: ExecutionEvent) => void,
): Promise<ExecutionOutcome> {
    emit({ type: 'executionStarted', statements: statements.length });
    let outcome: ExecutionOutcome = 'completed';

    for (let index = 0; index < statements.length; index++) {
        const sql = statements[index]!.sql;
        const statement: StatementInfo = {
            index,
            runId: deps.newId(),
            sql,
            preview: sql.replace(/\s+/g, ' ').slice(0, 120),
            kind: statementKind(sql),
        };
        deps.onStart?.(statement.runId);
        emit({ type: 'statementStarted', statement });

        let snapshot: DbQuerySnapshot;
        try {
            const waiting = new Promise<DbQuerySnapshot>((resolve) =>
                deps.settled.set(statement.runId, resolve),
            );
            await deps.db.startQuery(deps.connectionId, statement.runId, sql, deps.timeoutMs);
            snapshot = await waiting;
        } catch (error) {
            emit({
                type: 'statementFailed',
                statement,
                message: error instanceof Error ? error.message : String(error),
            });
            outcome = 'failed';
            break;
        } finally {
            deps.settled.delete(statement.runId);
        }

        // An earlier result is read on, to a limit, before the next statement takes the connection.
        if (index < statements.length - 1 && snapshot.paused) {
            snapshot = await readOn(deps, statement.runId, snapshot, deps.rowLimit);
            if (snapshot.results.some((r) => r.columns.length > 0 && !r.complete))
                emit({ type: 'statementTruncated', runId: statement.runId });
        }

        emit({ type: 'statementCompleted', statement, snapshot });
        if (snapshot.state === 'failed') {
            outcome = 'failed';
            break;
        }
        if (snapshot.state === 'cancelled') {
            outcome = 'cancelled';
            break;
        }
    }

    if (outcome === 'cancelled') emit({ type: 'executionCancelled' });
    emit({ type: 'executionCompleted', outcome });
    return outcome;
}
