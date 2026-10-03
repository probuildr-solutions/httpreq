/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import type { DbCell, DbColumnMeta, DbHostEvent, DbQuerySnapshot } from '@httpreq/shared';
import { DbApiError, type DbApi } from './dbApi';

/**
 * Running a statement from code instead of from an editor: the table browser reading a page, the
 * designer applying `ALTER TABLE`, a dialog calling a procedure. Each call starts one statement on
 * the host, waits until it has stopped (or has all the rows asked for), reads at most `maxRows`
 * rows through the host's paged results, and closes the statement. Rows never pass through more
 * than the one page the caller asked for, so the window's memory stays bounded however large the
 * table is.
 */
export interface FetchedRows {
    columns: DbColumnMeta[];
    rows: DbCell[][];
    /** Rows the statement produced (may be more than were read). */
    rowCount: number;
    /** All of the statement's rows were read. */
    complete: boolean;
    /** Cells (`row:column`, counted from the first row read) whose text the host cut short. */
    clipped: Set<string>;
    affectedRows?: number;
    info?: string;
    elapsedMs: number;
}

export interface StatementOutcome {
    sql: string;
    ok: boolean;
    error?: string;
    affectedRows?: number;
    elapsedMs: number;
}

export interface DbOps {
    /** Runs one statement and reads up to `maxRows` rows of its (first row-returning) result. */
    fetchRows(profileId: string, sql: string, options?: { maxRows?: number }): Promise<FetchedRows>;
    /**
     * Runs statements one after another, stopping at the first failure unless `continueOnError`.
     * Always returns what happened to each statement that ran; never throws for a failed statement.
     */
    execute(
        profileId: string,
        statements: string[],
        options?: { continueOnError?: boolean; onProgress?: (done: number, total: number) => void },
    ): Promise<StatementOutcome[]>;
}

const newId = (): string =>
    Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) =>
        b.toString(16).padStart(2, '0'),
    ).join('');

export const createDbOps = (
    db: DbApi,
    ensureConnected: (profileId: string) => Promise<boolean>,
    timeoutOf: (profileId: string) => number | undefined,
): DbOps => {
    /** Starts a statement and waits for it to stop. The caller closes it. */
    const run = async (
        profileId: string,
        sql: string,
    ): Promise<{ queryId: string; snapshot: DbQuerySnapshot }> => {
        if (!(await ensureConnected(profileId))) {
            throw new DbApiError('CONNECTION_FAILED', 'Could not connect to the database.');
        }
        const queryId = newId();
        let stop: (() => void) | undefined;
        const waiting = new Promise<DbQuerySnapshot>((resolve) => {
            stop = db.onEvent((event: DbHostEvent) => {
                if (event.topic !== 'query.state' || event.payload.queryId !== queryId) return;
                const { snapshot } = event.payload;
                if (snapshot.state !== 'running' || snapshot.paused) resolve(snapshot);
            });
        });
        try {
            await db.startQuery(profileId, queryId, sql, timeoutOf(profileId));
            return { queryId, snapshot: await waiting };
        } catch (error) {
            await db.closeQuery(queryId).catch(() => undefined);
            throw error;
        } finally {
            stop?.();
        }
    };

    const failure = (snapshot: DbQuerySnapshot) =>
        new DbApiError(
            snapshot.error?.code ?? (snapshot.state === 'cancelled' ? 'CANCELLED' : 'QUERY_FAILED'),
            snapshot.error?.message ??
                (snapshot.state === 'cancelled'
                    ? 'The statement was cancelled.'
                    : 'The statement failed.'),
        );

    return {
        async fetchRows(profileId, sql, options = {}) {
            const maxRows = Math.max(1, options.maxRows ?? 1000);
            const { queryId, snapshot } = await run(profileId, sql);
            try {
                if (snapshot.state === 'failed' || snapshot.state === 'cancelled')
                    throw failure(snapshot);
                const index = Math.max(
                    0,
                    snapshot.results.findIndex((result) => result.columns.length > 0),
                );
                const result = snapshot.results[index];
                if (!result) {
                    return {
                        columns: [],
                        rows: [],
                        rowCount: 0,
                        complete: true,
                        clipped: new Set(),
                        elapsedMs: snapshot.elapsedMs,
                    };
                }
                const rows: DbCell[][] = [];
                const clipped = new Set<string>();
                let pageSize = 1000;
                for (
                    let page = 0;
                    rows.length < maxRows && page * pageSize < result.rowCount;
                    page++
                ) {
                    const got = await db.page(queryId, index, page);
                    if (!got) break;
                    pageSize = got.pageSize || pageSize;
                    rows.push(...got.rows.slice(0, maxRows - rows.length));
                    for (const cut of got.clipped) clipped.add(`${cut.row}:${cut.column}`);
                }
                return {
                    columns: result.columns,
                    rows,
                    rowCount: result.rowCount,
                    complete: rows.length >= result.rowCount && result.complete,
                    clipped,
                    affectedRows: result.affectedRows,
                    info: result.info,
                    elapsedMs: snapshot.elapsedMs,
                };
            } finally {
                await db.closeQuery(queryId).catch(() => undefined);
            }
        },

        async execute(profileId, statements, options = {}) {
            const outcomes: StatementOutcome[] = [];
            for (let index = 0; index < statements.length; index++) {
                const sql = statements[index]!;
                options.onProgress?.(index, statements.length);
                try {
                    const { queryId, snapshot } = await run(profileId, sql);
                    await db.closeQuery(queryId).catch(() => undefined);
                    if (snapshot.state === 'failed' || snapshot.state === 'cancelled') {
                        const error = failure(snapshot);
                        outcomes.push({
                            sql,
                            ok: false,
                            error: error.message,
                            elapsedMs: snapshot.elapsedMs,
                        });
                    } else {
                        outcomes.push({
                            sql,
                            ok: true,
                            affectedRows: snapshot.results.at(-1)?.affectedRows,
                            elapsedMs: snapshot.elapsedMs,
                        });
                    }
                } catch (error) {
                    outcomes.push({
                        sql,
                        ok: false,
                        error: error instanceof Error ? error.message : String(error),
                        elapsedMs: 0,
                    });
                }
                if (!outcomes.at(-1)!.ok && !options.continueOnError) break;
            }
            options.onProgress?.(outcomes.length, statements.length);
            return outcomes;
        },
    };
};
