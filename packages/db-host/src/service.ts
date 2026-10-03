/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConnectionManager, ProviderRegistry } from '@httpreq/connection-manager';
import {
    DbError,
    isRelationalSession,
    toDbError,
    type DatabaseProvider,
    type ObjectRef,
    type RelationalSession,
} from '@httpreq/db-core';
import { ChunkReader, openFileSource } from '@httpreq/file-engine';
import {
    QueryRun,
    ScriptRun,
    splitStatements,
    statementAt,
    type QueryRunSnapshot,
    type ScriptProgress,
} from '@httpreq/query-engine';
import { splitShellStatements } from '@httpreq/mongo-engine';
import { splitCommandLines } from '@httpreq/redis-engine';
import type { SqlDialect } from '@httpreq/sql-parser';
import { TaskService } from './taskService';
import { integer, optionalText, parseConnectionConfig, record, text } from './validate';

export interface DbHostContext {
    emit: (topic: string, payload: unknown) => void;
    signal: AbortSignal;
}

export interface DbHostOptions {
    providers: DatabaseProvider[];
    /** Where result files go. */
    spoolDirectory?: string;
    /** Largest a single result may grow on disk. */
    maxSpoolBytes?: number;
    keepAliveMs?: number;
    /** Least time between two progress snapshots of one background task. */
    taskProgressIntervalMs?: number;
}

/** Pushed when a statement's state or progress changes. */
export interface QueryStateEvent {
    queryId: string;
    connectionId: string;
    snapshot: QueryRunSnapshot;
}

export interface ScriptProgressEvent {
    scriptId: string;
    connectionId: string;
    progress: ScriptProgress;
}

export interface ConnectionStatusEvent {
    connectionId: string;
    status: ReturnType<ConnectionManager['list']>[number];
}

const ID = /^[0-9a-f]{16}$/;
const DIALECTS: Record<string, SqlDialect> = { mysql: 'mysql', postgresql: 'postgresql' };

type Splitter = (text: string) => { start: number; end: number; sql: string; kind?: number }[];

/** Engines whose statements are not SQL split their own way; the editor asks by the same name. */
const COMMAND_SPLITTERS: Record<string, Splitter> = {
    redis: splitCommandLines,
    mongodb: splitShellStatements,
};

const id = (value: unknown, name: string): string => {
    if (typeof value !== 'string' || !ID.test(value)) {
        throw new DbError('INVALID_REQUEST', `${name} is invalid.`);
    }
    return value;
};

const objectRef = (value: unknown): ObjectRef => {
    const ref = record(value, 'The object');
    return {
        database: optionalText(ref.database, 'The database', 256),
        schema: optionalText(ref.schema, 'The schema', 256),
        name: text(ref.name, 'The name', 256),
    };
};

/**
 * The service that runs inside the Database Host process. It owns every connection, statement and
 * script of the application, and answers requests from the main process (which has already
 * decided the sender may ask). Nothing here touches the window or the credential store: a
 * password arrives inside a connection request, is used to connect, and stays in this process.
 */
export class DbHostService {
    private readonly registry = new ProviderRegistry();
    private readonly connections: ConnectionManager;
    private readonly runs = new Map<string, { run: QueryRun; connectionId: string }>();
    private readonly scripts = new Map<string, { run: ScriptRun; reader: ChunkReader }>();
    private readonly spoolDirectory: string;
    private emit: DbHostContext['emit'] = () => undefined;
    private readonly taskService: TaskService;

    constructor(private readonly options: DbHostOptions) {
        for (const provider of options.providers) this.registry.register(provider);
        this.connections = new ConnectionManager(this.registry, {
            keepAliveMs: options.keepAliveMs,
        });
        // Every status change (connected, dropped, reconnected) goes to the window.
        this.connections.onStatus((status) =>
            this.emit('conn.status', {
                connectionId: status.id,
                status,
            } satisfies ConnectionStatusEvent),
        );
        this.spoolDirectory = options.spoolDirectory ?? join(tmpdir(), 'httpreq-db-spool');
        this.taskService = new TaskService(this.connections, () => this.emit, {
            minIntervalMs: options.taskProgressIntervalMs,
        });
    }

    /** The dispatcher a worker server calls with each request. */
    handle = async (op: string, payload: unknown, context: DbHostContext): Promise<unknown> => {
        this.emit = context.emit;
        const request = op === 'host.stats' ? {} : record(payload);
        switch (op) {
            case 'engines.list':
                return this.registry.list().map((provider) => ({
                    id: provider.id,
                    displayName: provider.displayName,
                    defaultPort: provider.defaultPort,
                    capabilities: [...provider.capabilities],
                }));
            case 'conn.test':
                return this.connections.test(parseConnectionConfig(request.config), context.signal);
            case 'conn.open':
                return this.openConnection(request, context);
            case 'conn.close':
                await this.closeConnection(id(request.connectionId, 'The connection'));
                return {};
            case 'conn.list':
                return this.connections.list();

            case 'meta.list':
                return this.listMeta(request);
            case 'meta.definition': {
                const session = await this.relational(request.connectionId);
                return {
                    text: await session.getDefinition({
                        ...objectRef(request.object),
                        kind: text(record(request.object).kind, 'The kind', 32),
                    }),
                };
            }
            case 'meta.sessions':
                return (await this.relational(request.connectionId)).listSessions();
            case 'meta.kill':
                await (
                    await this.relational(request.connectionId)
                ).killSession(text(request.sessionId, 'The session', 64));
                return {};
            case 'meta.status':
                return (await this.relational(request.connectionId)).serverStatus();

            case 'query.start':
                return this.startQuery(request);
            case 'query.page': {
                const entry = this.run(request.queryId);
                return entry.run.page(
                    integer(request.result, 'The result', 0, 1000),
                    integer(request.page, 'The page', 0, 1e9),
                );
            }
            case 'query.cell': {
                const entry = this.run(request.queryId);
                return {
                    value: await entry.run.cell(
                        integer(request.result, 'The result', 0, 1000),
                        integer(request.row, 'The row', 0, Number.MAX_SAFE_INTEGER),
                        integer(request.column, 'The column', 0, 100_000),
                    ),
                };
            }
            case 'query.demand':
                this.run(request.queryId).run.demand(
                    integer(request.result, 'The result', 0, 1000),
                    integer(request.rows, 'The rows', 0, Number.MAX_SAFE_INTEGER),
                );
                return {};
            case 'query.fetchAll':
                this.run(request.queryId).run.fetchAll(
                    integer(request.result, 'The result', 0, 1000),
                );
                return {};
            case 'query.cancel':
                await this.run(request.queryId).run.cancel();
                return {};
            case 'query.close':
                await this.closeQuery(id(request.queryId, 'The query'));
                return {};
            case 'query.explain':
                return (await this.relational(request.connectionId)).explain(
                    text(request.sql, 'The statement', 16 * 1024 * 1024),
                );
            case 'tx.begin':
                await (await this.relational(request.connectionId)).begin();
                return {};
            case 'tx.commit':
                await (await this.relational(request.connectionId)).commit();
                return {};
            case 'tx.rollback':
                await (await this.relational(request.connectionId)).rollback();
                return {};

            case 'sql.split': {
                const source = text(request.text, 'The text', 64 * 1024 * 1024);
                const splitter = COMMAND_SPLITTERS[String(request.dialect)];
                if (splitter) return splitter(source).map((s) => ({ ...s, kind: s.kind ?? 0 }));
                return splitStatements(source, this.dialect(request.dialect));
            }
            case 'sql.statementAt': {
                const source = text(request.text, 'The text', 64 * 1024 * 1024);
                const offset = integer(request.offset, 'The offset', 0, Number.MAX_SAFE_INTEGER);
                const splitter = COMMAND_SPLITTERS[String(request.dialect)];
                if (!splitter) return statementAt(source, offset, this.dialect(request.dialect));
                // The statement the cursor is in, or the last one before it.
                const all = splitter(source);
                const found = all.find((s) => offset <= s.end) ?? all.at(-1);
                return found ? { ...found, kind: found.kind ?? 0 } : null;
            }

            case 'script.start':
                return this.startScript(request);
            case 'script.cancel':
                await this.scripts.get(id(request.scriptId, 'The script'))?.run.cancel();
                return {};
            case 'script.close':
                await this.closeScript(id(request.scriptId, 'The script'));
                return {};

            case 'task.export':
            case 'task.import':
            case 'task.script':
            case 'task.list':
            case 'task.cancel':
            case 'task.pause':
            case 'task.resume':
            case 'task.remove':
                return this.taskService.handle(op, request);

            case 'host.stats':
                return {
                    connections: this.connections.list().length,
                    queries: this.runs.size,
                    scripts: this.scripts.size,
                };
            default:
                throw new DbError('UNSUPPORTED', `Unknown operation “${op}”.`);
        }
    };

    async dispose(): Promise<void> {
        await this.taskService.dispose();
        await Promise.all([...this.runs.keys()].map((queryId) => this.closeQuery(queryId)));
        await Promise.all([...this.scripts.keys()].map((scriptId) => this.closeScript(scriptId)));
        await this.connections.closeAll();
    }

    /* ---------- Connections ---------- */

    private async openConnection(request: Record<string, unknown>, context: DbHostContext) {
        const connectionId = id(request.connectionId, 'The connection');
        const config = parseConnectionConfig(request.config);
        // Statements of a connection that is being replaced must go with it.
        await this.closeQueriesOf(connectionId);
        return this.connections.open(connectionId, config, context.signal);
    }

    private async closeConnection(connectionId: string): Promise<void> {
        await this.closeQueriesOf(connectionId);
        await this.connections.close(connectionId);
    }

    private async relational(connectionId: unknown): Promise<RelationalSession> {
        const session = await this.connections.acquire(id(connectionId, 'The connection'));
        if (!isRelationalSession(session)) {
            throw new DbError('UNSUPPORTED', 'This connection does not run SQL.');
        }
        return session;
    }

    /* ---------- Browsing ---------- */

    private async listMeta(request: Record<string, unknown>): Promise<unknown> {
        const session = await this.relational(request.connectionId);
        const scope = record(request.scope ?? {}, 'The scope');
        const where = {
            database: optionalText(scope.database, 'The database', 256),
            schema: optionalText(scope.schema, 'The schema', 256),
        };
        const table = () => ({ ...where, name: text(scope.name, 'The table', 256) });
        switch (text(request.kind, 'The kind', 32)) {
            case 'databases':
                return session.listDatabases();
            case 'schemas':
                return session.listSchemas(where.database);
            case 'tables':
                return session.listTables(where);
            case 'columns':
                return session.listColumns(table());
            case 'indexes':
                return session.listIndexes(table());
            case 'constraints':
                return session.listConstraints(table());
            case 'routines':
                return session.listRoutines(where);
            case 'triggers':
                return session.listTriggers(where);
            case 'events': {
                const withEvents = session as RelationalSession & {
                    listEvents?: (scope: { database?: string }) => Promise<unknown>;
                };
                if (!withEvents.listEvents)
                    throw new DbError('UNSUPPORTED', 'This engine has no scheduled events.');
                return withEvents.listEvents(where);
            }
            default:
                throw new DbError('INVALID_REQUEST', 'Unknown kind of object.');
        }
    }

    /* ---------- Statements ---------- */

    private run(queryId: unknown) {
        const entry = this.runs.get(id(queryId, 'The query'));
        if (!entry) throw new DbError('NOT_FOUND', 'That query is no longer open.');
        return entry;
    }

    private async startQuery(request: Record<string, unknown>) {
        const queryId = id(request.queryId, 'The query');
        const connectionId = id(request.connectionId, 'The connection');
        const sql = text(request.sql, 'The statement', 64 * 1024 * 1024);
        const session = await this.relational(connectionId);
        const timeout =
            request.timeoutMs === undefined
                ? undefined
                : integer(request.timeoutMs, 'The time limit', 0, 86_400_000);

        // A query tab that is run again replaces its own earlier run.
        if (this.runs.has(queryId)) await this.closeQuery(queryId);
        // The connection runs one statement at a time. A run that is only waiting for the window to
        // scroll can be stopped to make room (its rows so far stay readable); one still working cannot.
        for (const [otherId, other] of this.runs) {
            if (other.connectionId !== connectionId) continue;
            const state = other.run.snapshot().state;
            if (state === 'running') {
                if (!other.run.paused) {
                    throw new DbError(
                        'CONFLICT',
                        'A statement is already running on this connection.',
                    );
                }
                await other.run.cancel();
                await other.run.finished;
            }
            void otherId;
        }

        const run = new QueryRun(session, sql, {
            spoolDirectory: join(this.spoolDirectory, randomBytes(4).toString('hex')),
            maxSpoolBytes: this.options.maxSpoolBytes,
            ...(timeout !== undefined ? { timeoutMs: timeout } : {}),
        });
        this.runs.set(queryId, { run, connectionId });
        run.onChange((snapshot) =>
            this.emit('query.state', { queryId, connectionId, snapshot } satisfies QueryStateEvent),
        );
        return { queryId };
    }

    private async closeQuery(queryId: string): Promise<void> {
        const entry = this.runs.get(queryId);
        if (!entry) return;
        this.runs.delete(queryId);
        await entry.run.dispose();
    }

    private async closeQueriesOf(connectionId: string): Promise<void> {
        for (const [queryId, entry] of [...this.runs]) {
            if (entry.connectionId === connectionId) await this.closeQuery(queryId);
        }
    }

    /* ---------- Scripts ---------- */

    private async startScript(request: Record<string, unknown>) {
        const scriptId = id(request.scriptId, 'The script');
        const connectionId = id(request.connectionId, 'The connection');
        const session = await this.relational(connectionId);
        const dialect = this.dialect(request.dialect);
        for (const other of this.runs.values()) {
            if (
                other.connectionId === connectionId &&
                other.run.snapshot().state === 'running' &&
                !other.run.paused
            ) {
                throw new DbError('CONFLICT', 'A statement is already running on this connection.');
            }
        }
        const { source } = await openFileSource(request.path);
        const reader = new ChunkReader(source);
        const onError = request.onError === 'continue' ? 'continue' : 'stop';
        const run = new ScriptRun(session, reader, dialect, {
            onError,
            statementTimeoutMs:
                request.statementTimeoutMs === undefined
                    ? 0
                    : integer(request.statementTimeoutMs, 'The time limit', 0, 86_400_000),
            start:
                request.start === undefined
                    ? undefined
                    : integer(request.start, 'The start', 0, Number.MAX_SAFE_INTEGER),
            end:
                request.end === undefined
                    ? undefined
                    : integer(request.end, 'The end', 0, Number.MAX_SAFE_INTEGER),
        });
        this.scripts.set(scriptId, { run, reader });
        run.onChange((progress) =>
            this.emit('script.progress', {
                scriptId,
                connectionId,
                progress,
            } satisfies ScriptProgressEvent),
        );
        void run.finished.catch((error: unknown) => toDbError(error));
        return { scriptId };
    }

    private async closeScript(scriptId: string): Promise<void> {
        const entry = this.scripts.get(scriptId);
        if (!entry) return;
        this.scripts.delete(scriptId);
        await entry.run.cancel();
        await entry.run.finished.catch(() => undefined);
        await entry.reader.close().catch(() => undefined);
    }

    private dialect(value: unknown): SqlDialect {
        const dialect = DIALECTS[text(value ?? 'mysql', 'The dialect', 32)];
        if (!dialect) throw new DbError('INVALID_REQUEST', 'Unknown SQL dialect.');
        return dialect;
    }
}
