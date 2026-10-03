/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import {
    DbError,
    toDbError,
    type ColumnMeta,
    type DbErrorInfo,
    type DbValue,
    type ExecuteOptions,
    type Execution,
    type RelationalSession,
} from '@httpreq/db-core';
import { ResultSpool, clipPage, type ClippedCell } from '@httpreq/result-engine';

export interface QueryRunOptions extends ExecuteOptions {
    /** Folder for the temporary result files. */
    spoolDirectory: string;
    /** Pages fetched beyond what the grid has asked for, so scrolling stays smooth. */
    lookaheadPages?: number;
    /** Largest a single result may grow on disk. */
    maxSpoolBytes?: number;
}

/** What is known about one result set of a statement. */
export interface ResultInfo {
    index: number;
    columns: ColumnMeta[];
    /** Rows read so far. */
    rowCount: number;
    /** The server has sent all of this result's rows. */
    complete: boolean;
    /** The result outgrew its disk limit: rows after `rowCount` were not kept. */
    capped: boolean;
    /** For a statement that changes data. */
    affectedRows?: number;
    insertId?: string;
    info?: string;
    warnings?: number;
}

export type QueryRunState = 'running' | 'done' | 'failed' | 'cancelled';

export interface QueryRunSnapshot {
    state: QueryRunState;
    results: ResultInfo[];
    /** Milliseconds from start to now, or to the end of the statement. */
    elapsedMs: number;
    /** Still running on the server, but not being read because the window has what it asked for. */
    paused: boolean;
    error?: DbErrorInfo;
}

export interface ResultPage {
    /** Rows of this page, with wide cells cut. */
    rows: DbValue[][];
    clipped: ClippedCell[];
    /** Number of the first row of the page in the whole result. */
    firstRow: number;
    pageSize: number;
}

interface Slot {
    info: ResultInfo;
    spool: ResultSpool | null;
    /** Rows the window has asked for; the statement is read ahead of this by the lookahead only. */
    demand: number;
}

const DEFAULT_LOOKAHEAD_PAGES = 2;
const INITIAL_ROWS = 2_000;

/**
 * One statement being run for a query tab, with its results stored on disk as they arrive.
 *
 * The window pulls: it asks for pages, and the run reads from the server only a little beyond
 * what has been asked for. Past that point it stops consuming, which stops the driver reading the
 * socket, which makes the server wait. A `SELECT` over a billion rows therefore shows its first
 * screen at once, uses a few megabytes, and carries on only as the user scrolls (or asks to fetch
 * everything, which is bounded by the result's disk limit).
 */
export class QueryRun {
    private readonly slots: Slot[] = [];
    /** Rows the window asked for, by result: kept so a request made before the result exists counts. */
    private readonly demands = new Map<number, number>();
    private execution: Execution | null = null;
    private state: QueryRunState = 'running';
    private error: DbErrorInfo | undefined;
    private readonly startedAt = Date.now();
    private endedAt = 0;
    private readonly listeners = new Set<(snapshot: QueryRunSnapshot) => void>();
    private waiter: (() => void) | null = null;
    private cancelled = false;
    private waiting = false;
    private lastNotify = 0;
    private notifyTimer: ReturnType<typeof setTimeout> | undefined;
    private done: Promise<void>;

    constructor(
        session: RelationalSession,
        sql: string,
        private readonly options: QueryRunOptions,
    ) {
        this.done = this.run(session, sql);
    }

    /**
     * The statement is running on the server but this run has stopped reading, because the window
     * has all it asked for. The connection is still occupied by it.
     */
    get paused(): boolean {
        return this.state === 'running' && this.waiting;
    }

    /** Resolves when the statement has ended (or failed, or was cancelled). */
    get finished(): Promise<void> {
        return this.done;
    }

    snapshot(): QueryRunSnapshot {
        return {
            state: this.state,
            results: this.slots.map((slot) => ({ ...slot.info, columns: slot.info.columns })),
            elapsedMs: (this.endedAt || Date.now()) - this.startedAt,
            paused: this.paused,
            ...(this.error ? { error: this.error } : {}),
        };
    }

    /** Receives a snapshot whenever something changes (throttled while rows stream in). */
    onChange(listener: (snapshot: QueryRunSnapshot) => void): () => void {
        this.listeners.add(listener);
        return () => void this.listeners.delete(listener);
    }

    /** Tells the run how far the window needs to read: up to (not including) row `rows`. */
    demand(resultIndex: number, rows: number): void {
        if (rows <= (this.demands.get(resultIndex) ?? 0)) return;
        this.demands.set(resultIndex, rows);
        const slot = this.slots[resultIndex];
        if (slot) slot.demand = Math.max(slot.demand, rows);
        this.wake();
    }

    /** Reads the whole result (up to its disk limit). */
    fetchAll(resultIndex: number): void {
        this.demand(resultIndex, Number.MAX_SAFE_INTEGER);
    }

    async page(resultIndex: number, index: number): Promise<ResultPage | null> {
        const slot = this.slots[resultIndex];
        if (!slot?.spool) return null;
        // Looking at a page is asking for it, and for a little beyond.
        this.demand(resultIndex, (index + 1) * slot.spool.pageSize);
        const page = await slot.spool.page(index);
        if (!page) return null;
        const { rows, clipped } = clipPage(page.rows);
        return { rows, clipped, firstRow: page.firstRow, pageSize: slot.spool.pageSize };
    }

    /** The full value of one cell, for a cell that was cut when its page was sent. */
    async cell(resultIndex: number, row: number, column: number): Promise<DbValue> {
        const slot = this.slots[resultIndex];
        if (!slot?.spool) throw new DbError('NOT_FOUND', 'There is no such result.');
        return slot.spool.cell(row, column);
    }

    async cancel(): Promise<void> {
        if (this.state !== 'running') return;
        this.cancelled = true;
        this.wake();
        await this.execution?.cancel().catch(() => undefined);
    }

    /** Deletes the result files. The run is cancelled first if it is still going. */
    async dispose(): Promise<void> {
        await this.cancel();
        await this.done.catch(() => undefined);
        clearTimeout(this.notifyTimer);
        this.listeners.clear();
        await Promise.all(this.slots.map((slot) => slot.spool?.dispose()));
    }

    /* ---------- The reading loop ---------- */

    private async run(session: RelationalSession, sql: string): Promise<void> {
        const lookahead = this.options.lookaheadPages ?? DEFAULT_LOOKAHEAD_PAGES;
        let slot: Slot | null = null;
        try {
            this.execution = session.execute(sql, {
                pageRows: this.options.pageRows,
                timeoutMs: this.options.timeoutMs,
                signal: this.options.signal,
            });
            for await (const event of this.execution) {
                if (this.cancelled) break;
                if (event.kind === 'columns') {
                    const spool = await ResultSpool.create({
                        directory: this.options.spoolDirectory,
                        maxBytes: this.options.maxSpoolBytes,
                    });
                    spool.columns = event.columns;
                    slot = {
                        info: {
                            index: this.slots.length,
                            columns: event.columns,
                            rowCount: 0,
                            complete: false,
                            capped: false,
                        },
                        spool,
                        demand: Math.max(INITIAL_ROWS, this.demands.get(this.slots.length) ?? 0),
                    };
                    this.slots.push(slot);
                    this.notify(true);
                } else if (event.kind === 'rows' && slot?.spool) {
                    const stored = await slot.spool.append(event.rows);
                    slot.info.rowCount = slot.spool.rowCount;
                    this.notify(false);
                    if (!stored) {
                        slot.info.capped = true;
                        // The disk limit was reached: stop the statement rather than discard rows quietly.
                        await this.execution.cancel().catch(() => undefined);
                        break;
                    }
                    // Wait here while the window has all it asked for: this is the backpressure.
                    const spool = slot.spool;
                    while (
                        !this.cancelled &&
                        spool.rowCount >= slot.demand + lookahead * spool.pageSize
                    ) {
                        this.waiting = true;
                        await this.sleep();
                        this.waiting = false;
                    }
                } else if (event.kind === 'end') {
                    if (slot?.spool) {
                        await slot.spool.finish();
                        slot.info.rowCount = slot.spool.rowCount;
                        slot.info.complete = true;
                    } else {
                        // A statement with no rows (an INSERT, a DDL statement).
                        this.slots.push({
                            info: {
                                index: this.slots.length,
                                columns: [],
                                rowCount: 0,
                                complete: true,
                                capped: false,
                                ...(event.affectedRows !== undefined
                                    ? { affectedRows: event.affectedRows }
                                    : {}),
                                ...(event.insertId ? { insertId: event.insertId } : {}),
                            },
                            spool: null,
                            demand: 0,
                        });
                    }
                    const last = this.slots[this.slots.length - 1]!;
                    if (event.info) last.info.info = event.info;
                    if (event.warnings) last.info.warnings = event.warnings;
                    if (event.affectedRows !== undefined && slot?.spool)
                        last.info.affectedRows = event.affectedRows;
                    slot = null;
                    this.notify(true);
                }
            }
            this.state =
                this.cancelled || this.slots.some((s) => s.info.capped && !s.info.complete)
                    ? 'cancelled'
                    : 'done';
            if (slot?.spool) {
                await slot.spool.finish().catch(() => undefined);
                slot.info.rowCount = slot.spool.rowCount;
            }
        } catch (error) {
            const info = toDbError(error);
            this.state = info.code === 'CANCELLED' ? 'cancelled' : 'failed';
            if (this.state === 'failed' || this.cancelled === false) this.error = info.toInfo();
            if (slot?.spool) {
                await slot.spool.finish().catch(() => undefined);
                slot.info.rowCount = slot.spool.rowCount;
            }
        } finally {
            this.endedAt = Date.now();
            this.notify(true);
        }
    }

    private sleep(): Promise<void> {
        return new Promise((resolve) => (this.waiter = resolve));
    }

    private wake(): void {
        const waiter = this.waiter;
        this.waiter = null;
        waiter?.();
    }

    /** Tells listeners, at most about ten times a second unless `force` is set. */
    private notify(force: boolean): void {
        const now = Date.now();
        if (!force && now - this.lastNotify < 100) {
            this.notifyTimer ??= setTimeout(() => {
                this.notifyTimer = undefined;
                this.notify(true);
            }, 100);
            return;
        }
        this.lastNotify = now;
        const snapshot = this.snapshot();
        for (const listener of this.listeners) listener(snapshot);
    }
}
