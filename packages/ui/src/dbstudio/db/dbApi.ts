/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import type {
    DbCell,
    DbColumnInfo,
    DbConnectionSettings,
    DbConnectionStatus,
    DbConstraintInfo,
    DbDatabaseInfo,
    DbEngineInfo,
    DbEventInfo,
    DbExplainPlan,
    DbHostEvent,
    DbHostOp,
    DbIndexInfo,
    DbMetaKind,
    DbQuerySnapshot,
    DbResultPage,
    DbRoutineInfo,
    DbSessionInfo,
    DbStudioBridge,
    DbExportRequest,
    DbImportRequest,
    DbScriptTaskRequest,
    DbTaskSnapshot,
    DbTaskStarted,
    DbTableInfo,
    DbTestResult,
    DbTriggerInfo,
} from '@httpreq/shared';
import type { SplitDialect } from './engines';

/** A failure reported by the database host, with its code. */
export class DbApiError extends Error {
    constructor(
        readonly code: string,
        message: string,
    ) {
        super(message);
        this.name = 'DbApiError';
    }
}

/** Where to look for objects: a database, and for engines with them a schema, and a table name. */
export interface MetaScope {
    database?: string;
    schema?: string;
    name?: string;
}

/**
 * The renderer's typed view of the database host. Every call is a request through the preload
 * bridge; a failure becomes a `DbApiError` so callers can use ordinary try/catch.
 */
export interface DbApi {
    engines(): Promise<DbEngineInfo[]>;
    test(
        settings: DbConnectionSettings,
        profileId: string,
        password?: string,
    ): Promise<DbTestResult>;
    open(
        connectionId: string,
        settings: DbConnectionSettings,
        profileId: string,
    ): Promise<DbConnectionStatus>;
    close(connectionId: string): Promise<void>;

    meta(connectionId: string, kind: 'databases', scope?: MetaScope): Promise<DbDatabaseInfo[]>;
    meta(connectionId: string, kind: 'tables', scope?: MetaScope): Promise<DbTableInfo[]>;
    meta(connectionId: string, kind: 'columns', scope: MetaScope): Promise<DbColumnInfo[]>;
    meta(connectionId: string, kind: 'indexes', scope: MetaScope): Promise<DbIndexInfo[]>;
    meta(connectionId: string, kind: 'constraints', scope: MetaScope): Promise<DbConstraintInfo[]>;
    meta(connectionId: string, kind: 'routines', scope?: MetaScope): Promise<DbRoutineInfo[]>;
    meta(connectionId: string, kind: 'triggers', scope?: MetaScope): Promise<DbTriggerInfo[]>;
    meta(connectionId: string, kind: 'events', scope?: MetaScope): Promise<DbEventInfo[]>;
    definition(
        connectionId: string,
        object: { database?: string; schema?: string; name: string; kind: string },
    ): Promise<string>;
    sessions(connectionId: string): Promise<DbSessionInfo[]>;
    killSession(connectionId: string, sessionId: string): Promise<void>;
    serverStatus(connectionId: string): Promise<Record<string, string>>;

    startQuery(
        connectionId: string,
        queryId: string,
        sql: string,
        timeoutMs?: number,
    ): Promise<void>;
    page(queryId: string, result: number, page: number): Promise<DbResultPage | null>;
    cell(queryId: string, result: number, row: number, column: number): Promise<DbCell>;
    demand(queryId: string, result: number, rows: number): Promise<void>;
    fetchAll(queryId: string, result: number): Promise<void>;
    cancelQuery(queryId: string): Promise<void>;
    closeQuery(queryId: string): Promise<void>;
    explain(connectionId: string, sql: string): Promise<DbExplainPlan>;

    transaction(connectionId: string, action: 'begin' | 'commit' | 'rollback'): Promise<void>;

    splitSql(
        text: string,
        dialect: SplitDialect,
    ): Promise<{ start: number; end: number; sql: string; kind: number }[]>;
    statementAt(
        text: string,
        offset: number,
        dialect: SplitDialect,
    ): Promise<{ start: number; end: number; sql: string } | null>;

    startScript(
        connectionId: string,
        scriptId: string,
        fileId: string,
        options: {
            dialect: SplitDialect;
            onError: 'stop' | 'continue';
            start?: number;
            end?: number;
        },
    ): Promise<void>;
    cancelScript(scriptId: string): Promise<void>;
    closeScript(scriptId: string): Promise<void>;

    /** Background tasks. Where a task writes is chosen in a native dialog; the window gets no path. */
    startExport(request: DbExportRequest): Promise<DbTaskStarted>;
    startImport(request: DbImportRequest): Promise<DbTaskStarted>;
    startScriptTask(request: DbScriptTaskRequest): Promise<DbTaskStarted>;
    listTasks(): Promise<DbTaskSnapshot[]>;
    taskAction(action: 'cancel' | 'pause' | 'resume' | 'remove', taskId: string): Promise<void>;

    /** Subscribes to pushed state: connection status, query state and script progress. */
    onEvent(listener: (event: DbHostEvent) => void): () => void;

    setPassword(profileId: string, password: string): Promise<boolean>;
    hasPassword(profileId: string): Promise<boolean>;
    deletePassword(profileId: string): Promise<void>;
}

export const createDbApi = (bridge: DbStudioBridge): DbApi => {
    const call = async <T>(op: DbHostOp, payload?: unknown): Promise<T> => {
        const result = await bridge.dbRequest(op, payload);
        if (!result.ok) throw new DbApiError(result.error.code, result.error.message);
        return result.value as T;
    };
    const meta = (connectionId: string, kind: DbMetaKind, scope: MetaScope = {}) =>
        call<never>('meta.list', { connectionId, kind, scope });
    return {
        engines: () => call('engines.list'),
        test: (settings, profileId, password) =>
            call('conn.test', {
                settings,
                profileId,
                ...(password !== undefined ? { password } : {}),
            }),
        open: (connectionId, settings, profileId) =>
            call('conn.open', { connectionId, settings, profileId }),
        close: (connectionId) => call<void>('conn.close', { connectionId }).then(() => undefined),
        meta: meta as DbApi['meta'],
        definition: async (connectionId, object) =>
            (await call<{ text: string }>('meta.definition', { connectionId, object })).text,
        sessions: (connectionId) => call('meta.sessions', { connectionId }),
        killSession: (connectionId, sessionId) =>
            call<void>('meta.kill', { connectionId, sessionId }).then(() => undefined),
        serverStatus: (connectionId) => call('meta.status', { connectionId }),
        startQuery: (connectionId, queryId, sql, timeoutMs) =>
            call<void>('query.start', {
                connectionId,
                queryId,
                sql,
                ...(timeoutMs !== undefined ? { timeoutMs } : {}),
            }).then(() => undefined),
        page: (queryId, result, page) => call('query.page', { queryId, result, page }),
        cell: async (queryId, result, row, column) =>
            (await call<{ value: DbCell }>('query.cell', { queryId, result, row, column })).value,
        demand: (queryId, result, rows) =>
            call<void>('query.demand', { queryId, result, rows }).then(() => undefined),
        fetchAll: (queryId, result) =>
            call<void>('query.fetchAll', { queryId, result }).then(() => undefined),
        cancelQuery: (queryId) => call<void>('query.cancel', { queryId }).then(() => undefined),
        closeQuery: (queryId) => call<void>('query.close', { queryId }).then(() => undefined),
        explain: (connectionId, sql) => call('query.explain', { connectionId, sql }),
        transaction: (connectionId, action) =>
            call<void>(`tx.${action}` as DbHostOp, { connectionId }).then(() => undefined),
        splitSql: (text, dialect) => call('sql.split', { text, dialect }),
        statementAt: (text, offset, dialect) => call('sql.statementAt', { text, offset, dialect }),
        startScript: (connectionId, scriptId, fileId, options) =>
            call<void>('script.start', { connectionId, scriptId, fileId, ...options }).then(
                () => undefined,
            ),
        cancelScript: (scriptId) => call<void>('script.cancel', { scriptId }).then(() => undefined),
        closeScript: (scriptId) => call<void>('script.close', { scriptId }).then(() => undefined),
        startExport: (request) => call('task.export', request),
        startImport: (request) => call('task.import', request),
        startScriptTask: (request) => call('task.script', request),
        listTasks: () => call('task.list'),
        taskAction: (action, taskId) =>
            call<void>(`task.${action}` as DbHostOp, { taskId }).then(() => undefined),
        onEvent: (listener) => bridge.onDbEvent(listener),
        setPassword: (profileId, password) => bridge.setDbPassword(profileId, password),
        hasPassword: (profileId) => bridge.hasDbPassword(profileId),
        deletePassword: (profileId) => bridge.deleteDbPassword(profileId),
    };
};

export type { DbQuerySnapshot };
