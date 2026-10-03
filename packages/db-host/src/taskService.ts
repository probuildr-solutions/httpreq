/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import type { ConnectionManager } from '@httpreq/connection-manager';
import {
    BackgroundTaskManager,
    DbError,
    isRelationalSession,
    type RelationalSession,
    type TaskContext,
    type TaskInfo,
    type TaskSnapshot,
} from '@httpreq/db-core';
import { dialectOf, isSqlEngine } from '@httpreq/db-admin';
import { ChunkReader, FileSink, openFileSource } from '@httpreq/file-engine';
import { ScriptRun } from '@httpreq/query-engine';
import {
    bsonFormatter,
    csvFormatter,
    jsonFormatter,
    ndjsonFormatter,
    runExport,
    runImport,
    sqlFormatter,
    type ExportFormat,
    type ExportFormatter,
    type ImportCheckpoint,
    type ImportFormat,
    type ImportTarget,
} from '@httpreq/transfer-engine';
import { integer, optionalText, record, text } from './validate';

const ID = /^[0-9a-f]{16}$/;

const taskId = (value: unknown): string => {
    if (typeof value !== 'string' || !ID.test(value))
        throw new DbError('INVALID_REQUEST', 'The task is invalid.');
    return value;
};

const choice = <T extends string>(
    value: unknown,
    allowed: readonly T[],
    what: string,
    fallback?: T,
): T => {
    if (value === undefined && fallback !== undefined) return fallback;
    if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value))
        throw new DbError('INVALID_REQUEST', `${what} is not one of ${allowed.join(', ')}.`);
    return value as T;
};

const baseName = (path: string): string => path.replace(/^.*[\\/]/, '');

const EXPORT_FORMATS = ['csv', 'json', 'ndjson', 'sql', 'bson'] as const;
const IMPORT_FORMATS = ['csv', 'json', 'ndjson', 'bson'] as const;

/**
 * Runs exports, imports and script executions as background tasks inside the database host.
 *
 * Each task gets a session of its own, so a long-running transfer never makes the query tabs of the
 * same connection wait. The window asks for a task by id; progress comes back as throttled
 * snapshots; cancelling stops the statement on the server, closes the file and removes any
 * partial output. Paths arrive from the main process (which got them from a native dialog or a
 * file token), never from the window.
 */
export class TaskService {
    readonly tasks: BackgroundTaskManager;

    constructor(
        private readonly connections: ConnectionManager,
        emit: () => (topic: string, payload: unknown) => void,
        options: { minIntervalMs?: number; maxConcurrent?: number } = {},
    ) {
        this.tasks = new BackgroundTaskManager({
            minIntervalMs: options.minIntervalMs ?? 250,
            maxConcurrent: options.maxConcurrent ?? 3,
        });
        this.tasks.onChange((snapshot) => emit()('task.state', { snapshot }));
    }

    async handle(op: string, request: Record<string, unknown>): Promise<unknown> {
        switch (op) {
            case 'task.export':
                return this.startExport(request);
            case 'task.import':
                return this.startImport(request);
            case 'task.script':
                return this.startScript(request);
            case 'task.list':
                return this.tasks.list();
            case 'task.cancel':
                this.tasks.cancel(taskId(request.taskId));
                return {};
            case 'task.pause':
                this.tasks.pause(taskId(request.taskId));
                return {};
            case 'task.resume':
                this.tasks.resume(taskId(request.taskId));
                return {};
            case 'task.remove':
                return { removed: this.tasks.remove(taskId(request.taskId)) };
            default:
                throw new DbError('UNSUPPORTED', `Unknown operation “${op}”.`);
        }
    }

    async dispose(): Promise<void> {
        await this.tasks.dispose();
    }

    /* ---------- Helpers ---------- */

    private async session(connectionId: string, signal: AbortSignal): Promise<RelationalSession> {
        const session = await this.connections.openDedicated(connectionId, signal);
        if (!isRelationalSession(session)) {
            await session.close().catch(() => undefined);
            throw new DbError('UNSUPPORTED', 'This connection does not run statements.');
        }
        return session;
    }

    private submit(
        info: TaskInfo,
        id: string,
        run: (context: TaskContext) => Promise<void | { message?: string }>,
    ) {
        return { taskId: this.tasks.submit(info, run, id) };
    }

    /* ---------- Export ---------- */

    private startExport(request: Record<string, unknown>) {
        const id = taskId(request.taskId);
        const connectionId = text(request.connectionId, 'The connection', 64);
        const engine = this.connections.engineOf(connectionId);
        if (!engine) throw new DbError('NOT_FOUND', 'That connection is not open.');
        const path = text(request.path, 'The destination', 4096);
        const format = choice<ExportFormat>(request.format, EXPORT_FORMATS, 'The format');
        const source = record(request.source, 'The source');
        const kind = choice(source.kind, ['table', 'query'] as const, 'The source');
        const fetchSize =
            request.fetchSize === undefined
                ? 1000
                : integer(request.fetchSize, 'The fetch size', 1, 100_000);
        const csv = record(request.csv ?? {}, 'The CSV options');
        const sql = record(request.sql ?? {}, 'The SQL options');
        const table = {
            database: optionalText(source.database, 'The database', 256),
            schema: optionalText(source.schema, 'The schema', 256),
            name: kind === 'table' ? text(source.name, 'The table', 256) : '',
        };
        const queryText =
            kind === 'query' ? text(source.text, 'The statement', 16 * 1024 * 1024) : '';
        const documents = engine === 'mongodb';
        if (format === 'bson' && !documents)
            throw new DbError('INVALID_REQUEST', 'BSON is only for MongoDB collections.');
        if (format === 'sql' && !isSqlEngine(engine))
            throw new DbError(
                'INVALID_REQUEST',
                'SQL export is only for MySQL and PostgreSQL tables.',
            );
        if (engine === 'redis')
            throw new DbError('UNSUPPORTED', 'Redis keys cannot be exported this way.');

        const label =
            kind === 'table'
                ? table.name
                : (optionalText(source.label, 'The label', 120) ?? 'Query');
        return this.submit(
            {
                name: `Export ${label}`,
                type: 'export',
                source:
                    kind === 'table'
                        ? [table.database ?? table.schema, table.name].filter(Boolean).join('.')
                        : 'Query',
                destination: `${baseName(path)} (${format.toUpperCase()})`,
                database: table.database ?? table.schema,
                target: label,
                file: baseName(path),
                connectionId,
            },
            id,
            async (context) => {
                const session = await this.session(connectionId, context.signal);
                try {
                    let statement = queryText;
                    let formatter: ExportFormatter;
                    if (kind === 'table') {
                        if (documents) {
                            const root = table.database
                                ? `db.getSiblingDB(${JSON.stringify(table.database)})`
                                : 'db';
                            statement = `${root}.getCollection(${JSON.stringify(table.name)}).find({}).asDocuments()`;
                        } else {
                            statement = `SELECT * FROM ${dialectOf(engine).qualify({
                                database: engine === 'mysql' ? table.database : undefined,
                                schema: engine === 'postgresql' ? table.schema : undefined,
                                name: table.name,
                            })}`;
                        }
                    } else if (
                        documents &&
                        !/\.asDocuments\(\)\s*;?\s*$/.test(statement) &&
                        /\.find\(/.test(statement)
                    ) {
                        statement = `${statement.replace(/;\s*$/, '')}.asDocuments()`;
                    }
                    switch (format) {
                        case 'csv':
                            formatter = csvFormatter({
                                delimiter: optionalText(csv.delimiter, 'The delimiter', 1),
                                header: csv.header !== false,
                                bom: csv.bom === true,
                                nullText:
                                    typeof csv.nullText === 'string' && csv.nullText.length <= 8
                                        ? csv.nullText
                                        : undefined,
                                eol: csv.eol === 'lf' ? '\n' : '\r\n',
                            });
                            break;
                        case 'json':
                            formatter = jsonFormatter({ documents });
                            break;
                        case 'ndjson':
                            formatter = ndjsonFormatter({ documents });
                            break;
                        case 'bson':
                            formatter = bsonFormatter();
                            break;
                        default: {
                            let create: string | undefined;
                            if (sql.includeCreate !== false && kind === 'table') {
                                create = await session
                                    .getDefinition({ ...table, kind: 'table' })
                                    .catch(() => undefined);
                            }
                            formatter = sqlFormatter({
                                dialect: dialectOf(engine),
                                table: {
                                    database: engine === 'mysql' ? table.database : undefined,
                                    schema: engine === 'postgresql' ? table.schema : undefined,
                                    name: kind === 'table' ? table.name : 'exported_rows',
                                },
                                rowsPerStatement:
                                    sql.rowsPerStatement === undefined
                                        ? 100
                                        : integer(
                                              sql.rowsPerStatement,
                                              'The rows per statement',
                                              1,
                                              10_000,
                                          ),
                                create,
                                drop: sql.includeDrop === true,
                            });
                        }
                    }
                    const result = await runExport({
                        session,
                        statement,
                        formatter,
                        destination: path,
                        context,
                        fetchSize,
                    });
                    return { message: `${result.rows.toLocaleString('en-US')} rows written.` };
                } finally {
                    await session.close().catch(() => undefined);
                }
            },
        );
    }

    /* ---------- Import ---------- */

    private startImport(request: Record<string, unknown>) {
        const id = taskId(request.taskId);
        const connectionId = text(request.connectionId, 'The connection', 64);
        const engine = this.connections.engineOf(connectionId);
        if (!engine) throw new DbError('NOT_FOUND', 'That connection is not open.');
        const path = text(request.path, 'The file', 4096);
        const format = choice<ImportFormat>(request.format, IMPORT_FORMATS, 'The format');
        const target = record(request.target, 'The target');
        const where = {
            database: optionalText(target.database, 'The database', 256),
            schema: optionalText(target.schema, 'The schema', 256),
            name: text(target.name, 'The target', 256),
        };
        const csv = record(request.csv ?? {}, 'The CSV options');
        const columnMap: Record<string, string> = {};
        for (const [key, value] of Object.entries(
            record(csv.columnMap ?? {}, 'The column mapping'),
        )) {
            if (typeof value === 'string' && key.length <= 256 && value.length <= 256)
                columnMap[key] = value;
        }
        if (engine === 'redis')
            throw new DbError('UNSUPPORTED', 'Redis keys cannot be imported this way.');
        const resume = request.resume === undefined ? undefined : this.checkpoint(request.resume);
        const rejectsPath =
            typeof request.rejectsPath === 'string' ? request.rejectsPath : undefined;

        return this.submit(
            {
                name: `Import into ${where.name}`,
                type: 'import',
                source: baseName(path),
                destination: [where.database ?? where.schema, where.name].filter(Boolean).join('.'),
                database: where.database ?? where.schema,
                target: where.name,
                file: baseName(path),
                connectionId,
                resumable: transactionOf(request) !== 'all',
            },
            id,
            async (context) => {
                const session = await this.session(connectionId, context.signal);
                const { source } = await openFileSource(path);
                const reader = new ChunkReader(source);
                let rejects: FileSink | undefined;
                try {
                    let importTarget: ImportTarget;
                    if (engine === 'mongodb') {
                        importTarget = {
                            kind: 'collection',
                            database: where.database,
                            collection: where.name,
                        };
                    } else {
                        const columns = await session.listColumns({
                            database: engine === 'mysql' ? where.database : undefined,
                            schema: engine === 'postgresql' ? where.schema : undefined,
                            name: where.name,
                        });
                        if (columns.length === 0)
                            throw new DbError(
                                'NOT_FOUND',
                                `The table “${where.name}” was not found or has no columns.`,
                            );
                        importTarget = {
                            kind: 'table',
                            dialect: dialectOf(engine),
                            table: {
                                database: engine === 'mysql' ? where.database : undefined,
                                schema: engine === 'postgresql' ? where.schema : undefined,
                                name: where.name,
                            },
                            columns: columns.map((c) => ({ name: c.name, type: c.type })),
                        };
                    }
                    if (request.saveRejects === true && rejectsPath)
                        rejects = await FileSink.create(rejectsPath, { signal: context.signal });
                    const result = await runImport({
                        session,
                        reader,
                        format,
                        target: importTarget,
                        context,
                        mode: choice(
                            request.mode,
                            ['append', 'truncate'] as const,
                            'The mode',
                            'append',
                        ),
                        batchSize:
                            request.batchSize === undefined
                                ? undefined
                                : integer(request.batchSize, 'The batch size', 1, 50_000),
                        onError: choice(
                            request.onError,
                            ['stop', 'skip'] as const,
                            'The error handling',
                            'stop',
                        ),
                        transaction: transactionOf(request),
                        csv: {
                            delimiter: optionalText(csv.delimiter, 'The delimiter', 1),
                            header: csv.header !== false,
                            columnMap,
                            nullToken:
                                typeof csv.nullToken === 'string' ? csv.nullToken : undefined,
                            emptyAsNull: csv.emptyAsNull === true,
                        },
                        rejects,
                        resume,
                    });
                    if (rejects && result.rejected > 0) await rejects.commit();
                    else await rejects?.abort();
                    rejects = undefined;
                    return {
                        message: `${result.imported.toLocaleString('en-US')} rows imported${
                            result.rejected
                                ? `, ${result.rejected.toLocaleString('en-US')} rejected`
                                : ''
                        }.`,
                    };
                } finally {
                    await rejects?.abort();
                    await reader.close().catch(() => undefined);
                    await session.close().catch(() => undefined);
                }
            },
        );
    }

    private checkpoint(value: unknown): ImportCheckpoint {
        const c = record(value, 'The checkpoint');
        return {
            byteOffset: integer(c.byteOffset, 'The checkpoint offset', 0, Number.MAX_SAFE_INTEGER),
            record: integer(c.record, 'The checkpoint record', 1, Number.MAX_SAFE_INTEGER),
            line: integer(c.line, 'The checkpoint line', 1, Number.MAX_SAFE_INTEGER),
            ...(Array.isArray(c.header) &&
            c.header.every((h) => typeof h === 'string' && h.length <= 256)
                ? { header: c.header as string[] }
                : {}),
        };
    }

    /* ---------- Script files ---------- */

    private startScript(request: Record<string, unknown>) {
        const id = taskId(request.taskId);
        const connectionId = text(request.connectionId, 'The connection', 64);
        const engine = this.connections.engineOf(connectionId);
        if (!engine) throw new DbError('NOT_FOUND', 'That connection is not open.');
        if (!isSqlEngine(engine))
            throw new DbError('UNSUPPORTED', 'Only SQL files can be executed as a script.');
        const path = text(request.path, 'The file', 4096);
        const onError = choice(
            request.onError,
            ['stop', 'continue'] as const,
            'The error handling',
            'stop',
        );
        const transaction = choice(
            request.transaction,
            ['none', 'single'] as const,
            'The transaction',
            'none',
        );
        const timeout =
            request.statementTimeoutMs === undefined
                ? 0
                : integer(request.statementTimeoutMs, 'The time limit', 0, 86_400_000);

        return this.submit(
            {
                name: `Run ${baseName(path)}`,
                type: 'script',
                source: baseName(path),
                file: baseName(path),
                connectionId,
                database: undefined,
            },
            id,
            async (context) => {
                const session = await this.session(connectionId, context.signal);
                const { source } = await openFileSource(path);
                const reader = new ChunkReader(source);
                try {
                    if (transaction === 'single') await session.begin();
                    const run = new ScriptRun(session, reader, engine, {
                        onError,
                        statementTimeoutMs: timeout,
                    });
                    let seen = 0;
                    const unsubscribe = run.onChange((progress) => {
                        context.report({
                            stage: progress.current ? 'Running' : 'Finishing',
                            bytesProcessed: progress.bytesRead,
                            totalBytes: progress.totalBytes,
                            rowsProcessed: progress.executed,
                            message: progress.current,
                        });
                        for (; seen < progress.errors.length; seen++) {
                            const error = progress.errors[seen]!;
                            context.issue({
                                statement: error.statement + 1,
                                line: error.line,
                                message: `${error.error.message} — ${error.preview}`,
                            });
                        }
                    });
                    const onAbort = () => void run.cancel();
                    context.signal.addEventListener('abort', onAbort, { once: true });
                    await run.finished;
                    context.signal.removeEventListener('abort', onAbort);
                    unsubscribe();
                    const final = run.snapshot();
                    if (transaction === 'single') {
                        if (final.state === 'done' && final.failed === 0) await session.commit();
                        else await session.rollback().catch(() => undefined);
                    }
                    if (final.state === 'cancelled')
                        throw new DbError('CANCELLED', 'The script was cancelled.');
                    if (final.state === 'failed')
                        throw new DbError(
                            'QUERY_FAILED',
                            `The script stopped at statement ${final.executed}: ${final.errors[0]?.error.message ?? 'a statement failed'}${transaction === 'single' ? ' Everything was rolled back.' : ''}`,
                        );
                    return {
                        message: `${final.executed.toLocaleString('en-US')} statements run${final.failed ? `, ${final.failed} failed` : ''}.`,
                    };
                } finally {
                    await reader.close().catch(() => undefined);
                    await session.close().catch(() => undefined);
                }
            },
        );
    }
}

const transactionOf = (request: Record<string, unknown>) =>
    choice(request.transaction, ['none', 'batch', 'all'] as const, 'The transaction', 'batch');

export type { TaskSnapshot };
