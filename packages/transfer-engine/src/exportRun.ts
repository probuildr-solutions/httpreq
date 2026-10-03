/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import {
    DbError,
    toDbError,
    type ColumnMeta,
    type RelationalSession,
    type TaskContext,
} from '@httpreq/db-core';
import { FileSink } from '@httpreq/file-engine';
import type { ExportFormatter, Piece } from './formatters';
import { pieceLength } from './formatters';

/**
 * Exports the result of a statement to a file as a stream:
 *
 *     database cursor → batch (one result page) → formatter → buffered writer → destination
 *
 * The statement is read through the session's `execute`, which stops reading from the network while
 * this loop is not asking for more, and the writer does not accept another piece until the last one
 * reached the file, so a slow disk slows the database down instead of filling memory. Only one page
 * of rows and one write buffer exist at any moment, whatever the size of the table. The file is
 * written beside its destination and moved into place at the end; a cancelled or failed export
 * leaves nothing behind.
 */
export interface ExportRunOptions {
    session: RelationalSession;
    statement: string;
    formatter: ExportFormatter;
    destination: string;
    context: TaskContext;
    /** Rows per page fetched from the server. */
    fetchSize?: number;
    estimatedBytes?: number;
    /** Server-side statement time limit; 0 for none (the default for an export). */
    timeoutMs?: number;
    /** Writer buffer; mainly for tests. */
    highWaterBytes?: number;
}

export interface ExportResult {
    rows: number;
    bytes: number;
}

const REPORT_EVERY_ROWS = 2000;

export const runExport = async (options: ExportRunOptions): Promise<ExportResult> => {
    const { context, session } = options;
    context.report({ stage: 'Preparing' });
    const sink = await FileSink.create(options.destination, {
        signal: context.signal,
        estimatedBytes: options.estimatedBytes,
        highWaterBytes: options.highWaterBytes,
    });
    let rows = 0;
    const write = async (piece: Piece) => {
        if (pieceLength(piece) > 0) await sink.write(piece);
    };
    const execution = session.execute(options.statement, {
        pageRows: options.fetchSize ?? 1000,
        timeoutMs: options.timeoutMs ?? 0,
        signal: context.signal,
    });
    const onAbort = () => void execution.cancel().catch(() => undefined);
    context.signal.addEventListener('abort', onAbort, { once: true });
    try {
        let columns: ColumnMeta[] | null = null;
        let reportedAt = 0;
        read: for await (const event of execution) {
            await context.waitIfPaused();
            if (context.signal.aborted) throw new DbError('CANCELLED', 'The export was cancelled.');
            switch (event.kind) {
                case 'columns':
                    // Only the first result set that has columns is exported.
                    if (columns) break read;
                    columns = event.columns;
                    await write(options.formatter.begin(columns));
                    context.report({ stage: 'Writing' });
                    break;
                case 'rows':
                    if (!columns) break;
                    await write(options.formatter.rows(event.rows));
                    rows += event.rows.length;
                    if (rows - reportedAt >= REPORT_EVERY_ROWS) {
                        reportedAt = rows;
                        context.report({ rowsProcessed: rows, bytesProcessed: sink.bytesWritten });
                    }
                    break;
                case 'end':
                    if (columns) break read;
                    break;
            }
        }
        // A cancelled statement ends its stream quietly; the export must not call that a success.
        if (context.signal.aborted) throw new DbError('CANCELLED', 'The export was cancelled.');
        if (!columns) {
            throw new DbError(
                'INVALID_REQUEST',
                'That statement does not return rows, so there is nothing to export.',
            );
        }
        await write(options.formatter.end());
        context.report({
            stage: 'Finishing',
            rowsProcessed: rows,
            bytesProcessed: sink.bytesWritten,
        });
        const bytes = await sink.commit();
        context.report({ rowsProcessed: rows, bytesProcessed: bytes });
        return { rows, bytes };
    } catch (error) {
        await sink.abort();
        await execution.cancel().catch(() => undefined);
        const info = toDbError(error);
        if (context.signal.aborted && info.code !== 'CANCELLED')
            throw new DbError('CANCELLED', 'The export was cancelled.');
        if (info.code === 'CONNECTION_FAILED') {
            throw new DbError(
                'CONNECTION_FAILED',
                `The connection to the database was lost after ${rows.toLocaleString('en-US')} rows. The incomplete file was removed.`,
                { cause: error },
            );
        }
        if (info.code === 'TIMEOUT') {
            throw new DbError(
                'TIMEOUT',
                `The database stopped the statement after ${rows.toLocaleString('en-US')} rows because it ran too long. The incomplete file was removed.`,
                { cause: error },
            );
        }
        throw info;
    } finally {
        context.signal.removeEventListener('abort', onAbort);
    }
};
