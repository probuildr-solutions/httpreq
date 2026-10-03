/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import {
    DbError,
    toDbError,
    type DbErrorInfo,
    type Execution,
    type RelationalSession,
} from '@httpreq/db-core';
import type { ChunkReader } from '@httpreq/file-engine';
import type { SqlDialect } from '@httpreq/sql-parser';
import { streamStatements } from './statements';

export type ScriptState = 'running' | 'done' | 'failed' | 'cancelled';

export interface ScriptOptions {
    /** What to do when a statement fails. */
    onError: 'stop' | 'continue';
    /** Per-statement time limit; 0 for none. */
    statementTimeoutMs?: number;
    /** First and last byte of the part of the file to run (a selection of statements). */
    start?: number;
    end?: number;
}

export interface ScriptError {
    /** Which statement (0-based, among those sent). */
    statement: number;
    line: number;
    error: DbErrorInfo;
    /** The beginning of the statement, to recognise it. */
    preview: string;
}

export interface ScriptProgress {
    state: ScriptState;
    /** Statements that finished, successfully or not. */
    executed: number;
    failed: number;
    /** Rows changed, summed over the statements that change data. */
    affectedRows: number;
    /** Rows returned by statements that return rows (not kept). */
    rowsReturned: number;
    bytesRead: number;
    totalBytes: number;
    elapsedMs: number;
    /** The first failures, up to a cap. */
    errors: ScriptError[];
    /** The statement running now, shortened. */
    current?: string;
}

const MAX_ERRORS = 100;
const PREVIEW_CHARS = 120;

/**
 * Runs an SQL file against a session, statement by statement, reading the file as it goes.
 *
 * The file is never indexed or held: each statement is cut out of the stream as soon as its
 * terminator is seen and sent, so a script of millions of statements starts at once and uses a
 * constant amount of memory. Rows that statements return are counted, not kept (use a query tab
 * to look at results). Cancelling stops the running statement on the server.
 */
export class ScriptRun {
    private progress: ScriptProgress;
    private readonly startedAt = Date.now();
    private cancelled = false;
    private current: Execution | null = null;
    private readonly listeners = new Set<(progress: ScriptProgress) => void>();
    private lastNotify = 0;
    private readonly done: Promise<void>;
    private readonly abort = new AbortController();

    constructor(
        session: RelationalSession,
        private readonly reader: ChunkReader,
        dialect: SqlDialect,
        private readonly options: ScriptOptions,
    ) {
        this.progress = {
            state: 'running',
            executed: 0,
            failed: 0,
            affectedRows: 0,
            rowsReturned: 0,
            bytesRead: 0,
            totalBytes: (options.end ?? reader.size) - (options.start ?? 0),
            elapsedMs: 0,
            errors: [],
        };
        this.done = this.run(session, dialect);
    }

    get finished(): Promise<void> {
        return this.done;
    }

    snapshot(): ScriptProgress {
        return {
            ...this.progress,
            elapsedMs: Date.now() - this.startedAt,
            errors: [...this.progress.errors],
        };
    }

    onChange(listener: (progress: ScriptProgress) => void): () => void {
        this.listeners.add(listener);
        return () => void this.listeners.delete(listener);
    }

    async cancel(): Promise<void> {
        this.cancelled = true;
        this.abort.abort();
        await this.current?.cancel().catch(() => undefined);
    }

    private async run(session: RelationalSession, dialect: SqlDialect): Promise<void> {
        const base = this.options.start ?? 0;
        try {
            for await (const statement of streamStatements(this.reader, dialect, {
                start: this.options.start,
                end: this.options.end,
                signal: this.abort.signal,
            })) {
                if (this.cancelled) break;
                this.progress.bytesRead = statement.bytesRead - base;
                if (statement.malformed) {
                    this.fail(
                        statement.index,
                        statement.line,
                        statement.sql,
                        new DbError(
                            'INVALID_REQUEST',
                            'The script ends inside a quote or comment.',
                        ),
                    );
                    if (this.options.onError === 'stop') break;
                    continue;
                }
                if (statement.sql.length === 0) continue;
                this.progress.current = statement.sql.replace(/\s+/g, ' ').slice(0, PREVIEW_CHARS);
                this.notify(false);
                try {
                    await this.execute(session, statement.sql);
                } catch (error) {
                    const info = toDbError(error);
                    if (this.cancelled || info.code === 'CANCELLED') break;
                    this.fail(statement.index, statement.line, statement.sql, info);
                    if (this.options.onError === 'stop') {
                        this.progress.executed++; // it ran, and failed
                        break;
                    }
                }
                this.progress.executed++;
                this.notify(false);
            }
            this.progress.state = this.cancelled
                ? 'cancelled'
                : this.progress.failed > 0 && this.options.onError === 'stop'
                  ? 'failed'
                  : 'done';
        } catch (error) {
            const info = toDbError(error);
            this.progress.state = info.code === 'CANCELLED' ? 'cancelled' : 'failed';
            if (info.code !== 'CANCELLED') this.fail(this.progress.executed, 0, '', info);
        } finally {
            delete this.progress.current;
            this.progress.elapsedMs = Date.now() - this.startedAt;
            this.notify(true);
        }
    }

    private async execute(session: RelationalSession, sql: string): Promise<void> {
        this.current = session.execute(sql, {
            timeoutMs: this.options.statementTimeoutMs,
            pageRows: 1000,
        });
        try {
            for await (const event of this.current) {
                if (event.kind === 'rows') this.progress.rowsReturned += event.rows.length;
                else if (event.kind === 'end' && event.affectedRows)
                    this.progress.affectedRows += event.affectedRows;
            }
        } finally {
            this.current = null;
        }
    }

    private fail(statement: number, line: number, sql: string, error: DbError): void {
        this.progress.failed++;
        if (this.progress.errors.length < MAX_ERRORS) {
            this.progress.errors.push({
                statement,
                line,
                error: error.toInfo(),
                preview: sql.replace(/\s+/g, ' ').slice(0, PREVIEW_CHARS),
            });
        }
    }

    private notify(force: boolean): void {
        const now = Date.now();
        if (!force && now - this.lastNotify < 100) return;
        this.lastNotify = now;
        const snapshot = this.snapshot();
        for (const listener of this.listeners) listener(snapshot);
    }
}
