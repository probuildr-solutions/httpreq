/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
} from 'react';
import type {
    DbConnectionSettings,
    DbEngineInfo,
    DbHostEvent,
    DbQuerySnapshot,
    DbStudioBridge,
    DbTestResult,
} from '@httpreq/shared';
import { confirmAction } from '../../confirm';
import { notifications } from '../../kit';
import { useStudioStore } from '../studioStore';
import { createDbApi, DbApiError, type DbApi } from './dbApi';
import { createDbOps, type DbOps } from './dbOps';
import { applyTaskSnapshot, markTasksLost } from '../tasks/taskStore';
import {
    buildRows,
    loadsFor,
    metaKey,
    profileKeyPrefix,
    rowKey,
    type ExplorerRow,
    type MetaEntry,
} from './explorerRows';
import { layoutOf, startOfScript, statementsToOpen } from './engines';
import { newProfileId, useProfiles, type ConnectionProfile } from './profiles';
import {
    isQueryTabId,
    newQueryTabId,
    patchQuery,
    useHistory,
    useLive,
    useQueries,
    type BottomTab,
    type QueryTab,
    type StatementLog,
} from './queryStore';

export type RunMode = 'current' | 'selection' | 'all';

export interface DbManagerApi {
    readonly available: boolean;
    readonly engines: DbEngineInfo[];

    saveProfile: (profile: ConnectionProfile, password?: string) => Promise<void>;
    deleteProfile: (id: string) => Promise<void>;
    testConnection: (
        settings: DbConnectionSettings,
        profileId: string,
        password?: string,
    ) => Promise<DbTestResult>;
    connect: (profileId: string) => Promise<boolean>;
    disconnect: (profileId: string) => Promise<void>;

    toggle: (row: ExplorerRow) => void;
    refresh: (profileId: string) => void;
    /** Reloads one node's children (a database, schema, group, table) without reconnecting. */
    refreshRow: (row: ExplorerRow) => void;
    definition: (row: ExplorerRow) => Promise<string>;
    /** Reads a list of schema objects straight from the server, bypassing the explorer's cache. */
    listMeta: (
        profileId: string,
        kind: string,
        scope?: { database?: string; schema?: string; name?: string },
    ) => Promise<unknown[]>;
    /** Runs statements and reads rows from code (the table browser, the designer, dialogs). */
    readonly ops: DbOps | null;
    /** Chooses the database and schema a query tab runs in. */
    setContext: (id: string, context: { database?: string | null; schema?: string | null }) => void;

    newQuery: (profileId: string | null, text?: string, title?: string) => string;
    openTable: (row: ExplorerRow) => Promise<string>;
    /** Closes a query tab. `silent` skips the open-transaction question (a bulk close asks once). */
    closeQuery: (id: string, options?: { silent?: boolean }) => Promise<void>;
    setText: (id: string, text: string) => void;
    setConnection: (id: string, profileId: string | null) => void;
    run: (id: string, input: { text: string; mode: RunMode; offset?: number }) => Promise<void>;
    cancel: (id: string) => Promise<void>;
    fetchAll: (id: string) => void;
    demand: (id: string, rows: number) => void;
    explain: (id: string, text: string) => Promise<void>;
    transaction: (id: string, action: 'begin' | 'commit' | 'rollback') => Promise<void>;
    setBottom: (id: string, tab: BottomTab) => void;
    setResult: (id: string, index: number) => void;
    /** The api, for the result grid to fetch pages and cells. */
    readonly db: DbApi | null;
}

const UNAVAILABLE: DbManagerApi = {
    available: false,
    engines: [],
    saveProfile: async () => undefined,
    deleteProfile: async () => undefined,
    testConnection: async () => {
        throw new Error('Database connections are part of the desktop app.');
    },
    connect: async () => false,
    disconnect: async () => undefined,
    toggle: () => undefined,
    refresh: () => undefined,
    refreshRow: () => undefined,
    definition: async () => '',
    listMeta: async () => [],
    ops: null,
    setContext: () => undefined,
    newQuery: () => '',
    openTable: async () => '',
    closeQuery: async () => undefined,
    setText: () => undefined,
    setConnection: () => undefined,
    run: async () => undefined,
    cancel: async () => undefined,
    fetchAll: () => undefined,
    demand: () => undefined,
    explain: async () => undefined,
    transaction: async () => undefined,
    setBottom: () => undefined,
    setResult: () => undefined,
    db: null,
};

export const DbManagerContext = createContext<DbManagerApi>(UNAVAILABLE);
export const useDbManager = (): DbManagerApi => useContext(DbManagerContext);

const hex16 = (): string =>
    Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) =>
        b.toString(16).padStart(2, '0'),
    ).join('');

const message = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

const addStudioTab = (id: string) =>
    useStudioStore.setState((state) => ({
        order: state.order.includes(id) ? state.order : [...state.order, id],
        activeId: id,
    }));

const removeStudioTab = (id: string) =>
    useStudioStore.setState((state) => {
        const order = state.order.filter((item) => item !== id);
        const index = state.order.indexOf(id);
        return {
            order,
            activeId:
                state.activeId === id
                    ? (order[Math.min(index, order.length - 1)] ?? null)
                    : state.activeId,
        };
    });

const setMeta = (key: string, entry: MetaEntry | null) =>
    useLive.setState((state) => {
        const meta = { ...state.meta };
        if (entry) meta[key] = entry;
        else delete meta[key];
        return { meta };
    });

const setExpanded = (key: string, open: boolean) =>
    useLive.setState((state) => {
        const expanded = new Set(state.expanded);
        if (open) expanded.add(key);
        else expanded.delete(key);
        return { expanded };
    });

export function useDbManagerState(bridge: DbStudioBridge | undefined): DbManagerApi {
    const db = useMemo(() => (bridge ? createDbApi(bridge) : null), [bridge]);
    const [engines, setEngines] = useState<DbEngineInfo[]>([]);
    /** Resolves when a statement stops running (or pauses, waiting for the grid to scroll). */
    const settled = useRef(new Map<string, (snapshot: DbQuerySnapshot) => void>());
    const startedAt = useRef(new Map<string, number>());

    const profileOf = (id: string | null) =>
        id ? useProfiles.getState().profiles.find((p) => p.id === id) : undefined;

    /* ---------- Events from the host ---------- */

    useEffect(() => {
        if (!db) return;
        void db
            .engines()
            .then(setEngines)
            .catch(() => undefined);
        return db.onEvent((event: DbHostEvent) => {
            if (event.topic === 'conn.status') {
                const { connectionId, status } = event.payload;
                useLive.setState((state) => ({
                    status: { ...state.status, [connectionId]: status },
                }));
            } else if (event.topic === 'query.state') {
                const { queryId, snapshot } = event.payload;
                const tab = Object.values(useQueries.getState().tabs).find(
                    (t) => t.runId === queryId,
                );
                if (tab) {
                    patchQuery(tab.id, (current) => ({
                        snapshot,
                        // A new result set appearing selects it only when the user has not chosen one.
                        resultIndex: Math.min(
                            current.resultIndex,
                            Math.max(0, snapshot.results.length - 1),
                        ),
                    }));
                }
                if (snapshot.state !== 'running' || snapshot.paused)
                    settled.current.get(queryId)?.(snapshot);
            } else if (event.topic === 'task.state') {
                applyTaskSnapshot(event.payload.snapshot);
            } else if (event.topic === 'task.lost') {
                markTasksLost(event.payload.reason);
            } else if (event.topic === 'script.progress') {
                const { scriptId, progress } = event.payload;
                const tab = Object.values(useQueries.getState().tabs).find(
                    (t) => t.scriptId === scriptId,
                );
                if (tab) patchQuery(tab.id, { script: progress });
            }
        });
    }, [db]);

    /* ---------- Connections ---------- */

    const loadMeta = useCallback(
        async (
            profileId: string,
            kind: string,
            database?: string,
            table?: string,
            schema?: string,
            refreshing = false,
        ) => {
            if (!db) return;
            const key = metaKey(profileId, kind, database, table, schema);
            const existing = useLive.getState().meta[key];
            if (!refreshing && (existing?.state === 'loading' || existing?.state === 'ready'))
                return;
            // A refresh keeps showing the old list until the new one arrives.
            if (!refreshing) setMeta(key, { state: 'loading' });
            try {
                const scope = {
                    ...(database ? { database } : {}),
                    ...(schema ? { schema } : {}),
                    ...(table ? { name: table } : {}),
                };
                const items = await (
                    db.meta as (id: string, kind: string, scope: object) => Promise<unknown[]>
                )(profileId, kind, scope);
                setMeta(key, { state: 'ready', items });
            } catch (error) {
                setMeta(key, { state: 'error', message: message(error) });
            }
        },
        [db],
    );

    const connect = useCallback(
        async (profileId: string): Promise<boolean> => {
            const profile = profileOf(profileId);
            if (!db || !profile) return false;
            if (useLive.getState().status[profileId]?.state === 'connected') return true;
            useLive.setState((state) => ({ busy: { ...state.busy, [profileId]: true } }));
            try {
                const status = await db.open(profileId, profile.settings, profileId);
                useLive.setState((state) => ({ status: { ...state.status, [profileId]: status } }));
                useProfiles.getState().touch(profileId);
                setExpanded(rowKey('c', profileId), true);
                void loadMeta(profileId, 'databases');
                return true;
            } catch (error) {
                notifications.show({
                    color: 'red',
                    title: `Could not connect to ${profile.name}`,
                    message: message(error),
                    autoClose: 8000,
                });
                return false;
            } finally {
                useLive.setState((state) => ({ busy: { ...state.busy, [profileId]: false } }));
            }
        },
        [db, loadMeta],
    );

    const disconnect = useCallback(
        async (profileId: string) => {
            if (!db) return;
            // Query tabs on this connection lose their results with it.
            for (const tab of Object.values(useQueries.getState().tabs)) {
                if (tab.profileId === profileId)
                    patchQuery(tab.id, {
                        runId: null,
                        snapshot: null,
                        running: false,
                        inTransaction: false,
                    });
            }
            await db.close(profileId).catch(() => undefined);
            useLive.setState((state) => {
                const status = { ...state.status };
                delete status[profileId];
                const meta = Object.fromEntries(
                    Object.entries(state.meta).filter(
                        ([key]) => !key.startsWith(profileKeyPrefix(profileId)),
                    ),
                );
                const expanded = new Set(
                    [...state.expanded].filter((key) => !key.includes(profileKeyPrefix(profileId))),
                );
                return { status, meta, expanded };
            });
        },
        [db],
    );

    const saveProfile = useCallback(
        async (profile: ConnectionProfile, password?: string) => {
            const exists = useProfiles.getState().profiles.some((p) => p.id === profile.id);
            if (exists) useProfiles.getState().update(profile.id, profile);
            else useProfiles.getState().add(profile);
            if (db && password !== undefined && password !== '') {
                const stored = await db.setPassword(profile.id, password);
                if (!stored) {
                    notifications.show({
                        color: 'yellow',
                        title: 'Password not saved',
                        message:
                            'The system credential store is not available, so the password will have to be entered each time.',
                        autoClose: 8000,
                    });
                }
            }
            // Settings changed: a live connection to the old ones is dropped.
            if (exists && useLive.getState().status[profile.id]) await disconnect(profile.id);
        },
        [db, disconnect],
    );

    const deleteProfile = useCallback(
        async (id: string) => {
            await disconnect(id);
            await db?.deletePassword(id).catch(() => undefined);
            useProfiles.getState().remove(id);
            for (const tab of Object.values(useQueries.getState().tabs)) {
                if (tab.profileId === id) patchQuery(tab.id, { profileId: null });
            }
        },
        [db, disconnect],
    );

    const testConnection = useCallback(
        (settings: DbConnectionSettings, profileId: string, password?: string) => {
            if (!db)
                return Promise.reject(
                    new Error('Database connections are part of the desktop app.'),
                );
            return db.test(settings, profileId, password);
        },
        [db],
    );

    /* ---------- Explorer ---------- */

    const toggle = useCallback(
        (row: ExplorerRow) => {
            if (!row.expandable) return;
            const open = !row.expanded;
            setExpanded(row.key, open);
            if (open)
                for (const load of loadsFor(row))
                    void loadMeta(row.profileId, load.kind, load.database, load.table, load.schema);
        },
        [loadMeta],
    );

    const refresh = useCallback(
        (profileId: string) => {
            const { status, meta, expanded } = useLive.getState();
            const profiles = useProfiles.getState().profiles.filter((p) => p.id === profileId);
            // Everything that is open is loaded again, in place: the old lists stay on screen.
            for (const row of buildRows(profiles, status, meta, expanded)) {
                if (!row.expanded) continue;
                for (const load of loadsFor(row)) {
                    void loadMeta(
                        profileId,
                        load.kind,
                        load.database,
                        load.table,
                        load.schema,
                        true,
                    );
                }
            }
        },
        [loadMeta],
    );

    const refreshRow = useCallback(
        (row: ExplorerRow) => {
            // The node and everything open below it are loaded again, in place: the old lists stay
            // on screen until the new ones arrive, and nothing reconnects.
            const { status, meta, expanded } = useLive.getState();
            const profiles = useProfiles.getState().profiles.filter((p) => p.id === row.profileId);
            const below = (r: ExplorerRow) => {
                if (row.kind === 'connection') return true;
                if (r.database !== row.database) return false;
                if (row.kind === 'database') return true;
                if (r.schema !== row.schema) return false;
                if (row.kind === 'schema') return true;
                if (row.kind === 'group') return r.object === row.object || r.table !== undefined;
                return r.table === row.table;
            };
            const loads = new Map<string, ReturnType<typeof loadsFor>[number]>();
            const add = (r: ExplorerRow) => {
                for (const load of loadsFor(r))
                    loads.set(
                        `${load.kind}|${load.database ?? ''}|${load.schema ?? ''}|${load.table ?? ''}`,
                        load,
                    );
            };
            // The node itself, even if it is collapsed (its list is what the user asked to reload).
            add({ ...row, expanded: true });
            for (const r of buildRows(profiles, status, meta, expanded)) {
                if (r.expanded && below(r)) add(r);
            }
            for (const load of loads.values())
                void loadMeta(
                    row.profileId,
                    load.kind,
                    load.database,
                    load.table,
                    load.schema,
                    true,
                );
        },
        [loadMeta],
    );

    const listMeta = useCallback(
        async (
            profileId: string,
            kind: string,
            scope: { database?: string; schema?: string; name?: string } = {},
        ) => {
            if (!db) return [];
            if (!(await connect(profileId))) throw new Error('Could not connect to the database.');
            return (db.meta as (id: string, kind: string, scope: object) => Promise<unknown[]>)(
                profileId,
                kind,
                scope,
            );
        },
        [db, connect],
    );

    const ops = useMemo(
        () =>
            db ? createDbOps(db, connect, (id) => profileOf(id)?.settings.queryTimeoutMs) : null,
        [db, connect],
    );

    const setContext = useCallback(
        (id: string, context: { database?: string | null; schema?: string | null }) =>
            patchQuery(id, (tab) => ({
                database: context.database === undefined ? tab.database : context.database,
                // A new database invalidates the schema chosen for the old one.
                schema:
                    context.schema !== undefined
                        ? context.schema
                        : context.database !== undefined && context.database !== tab.database
                          ? null
                          : tab.schema,
            })),
        [],
    );

    const definition = useCallback(
        async (row: ExplorerRow) => {
            if (!db) return '';
            const isObject = row.kind === 'table' || row.kind === 'view';
            const kind =
                row.kind === 'routine'
                    ? // MySQL has no definition for "a routine", only for a function or a procedure.
                      (row.routineKind ?? 'function')
                    : row.kind === 'trigger' || row.kind === 'event'
                      ? row.kind
                      : row.objectKind === 'materialized view' || row.objectKind === 'view'
                        ? row.objectKind
                        : isObject && row.kind === 'view'
                          ? 'view'
                          : 'table';
            return db.definition(row.profileId, {
                database: row.database,
                ...(row.schema ? { schema: row.schema } : {}),
                name: isObject ? (row.table ?? row.label) : (row.object ?? row.label),
                kind,
            });
        },
        [db],
    );

    /* ---------- Query tabs ---------- */

    const newQuery = useCallback((profileId: string | null, text = '', title?: string) => {
        const id = newQueryTabId();
        // With no connection given, use the one that is open, or the only one there is.
        const known = useProfiles.getState().profiles;
        const live = known.find((p) => useLive.getState().status[p.id]?.state === 'connected');
        const chosen = profileId ?? live?.id ?? (known.length === 1 ? known[0]!.id : null);
        const count = Object.keys(useQueries.getState().tabs).length + 1;
        useQueries.setState((state) => ({
            tabs: {
                ...state.tabs,
                [id]: {
                    id,
                    title: title ?? `Query ${count}`,
                    profileId: chosen,
                    database: null,
                    schema: null,
                    text,
                    // A tab opened with generated text (a table's rows, a definition) is not
                    // unsaved work: only what the user types counts.
                    savedText: text,
                    source: null,
                    runId: null,
                    snapshot: null,
                    log: [],
                    resultIndex: 0,
                    bottom: 'results',
                    explain: null,
                    explainError: null,
                    inTransaction: false,
                    script: null,
                    scriptId: null,
                    running: false,
                } satisfies QueryTab,
            },
        }));
        addStudioTab(id);
        return id;
    }, []);

    const closeRun = useCallback(
        async (runId: string | null) => {
            if (!db || !runId) return;
            settled.current.delete(runId);
            await db.closeQuery(runId).catch(() => undefined);
        },
        [db],
    );

    const closeQuery = useCallback(
        async (id: string, options: { silent?: boolean } = {}) => {
            const tab = useQueries.getState().tabs[id];
            if (!tab) return;
            if (tab.inTransaction && !options.silent) {
                const answer = await confirmAction({
                    title: `Close ${tab.title}?`,
                    message:
                        'A transaction was started in this tab and not finished. Closing it leaves the transaction open on the connection until you commit or roll back.',
                    confirmLabel: 'Close anyway',
                    danger: true,
                });
                if (answer !== 'confirm') return;
            }
            if (tab.running) await db?.cancelQuery(tab.runId ?? '').catch(() => undefined);
            if (tab.scriptId) await db?.closeScript(tab.scriptId).catch(() => undefined);
            await closeRun(tab.runId);
            useQueries.setState((state) => {
                const tabs = { ...state.tabs };
                delete tabs[id];
                return { tabs };
            });
            removeStudioTab(id);
        },
        [db, closeRun],
    );

    const openTable = useCallback(
        async (row: ExplorerRow) => {
            const profile = profileOf(row.profileId);
            if (!profile || !row.table) return '';
            const text = statementsToOpen(profile.settings.engine, {
                database: row.database,
                schema: row.schema,
                name: row.table,
                kind: row.objectKind ?? row.kind,
            });
            const id = newQuery(row.profileId, text, `${row.table}`);
            void run(id, { text, mode: 'all' });
            return id;
        },
        // `run` is declared below and only called after render.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [newQuery],
    );

    const setText = useCallback((id: string, text: string) => patchQuery(id, { text }), []);
    const setConnection = useCallback(
        (id: string, profileId: string | null) => patchQuery(id, { profileId }),
        [],
    );
    const setBottom = useCallback(
        (id: string, bottom: BottomTab) => patchQuery(id, { bottom }),
        [],
    );
    const setResult = useCallback(
        (id: string, resultIndex: number) => patchQuery(id, { resultIndex }),
        [],
    );

    const run = useCallback(
        async (id: string, input: { text: string; mode: RunMode; offset?: number }) => {
            const tab = useQueries.getState().tabs[id];
            if (!db || !tab || tab.running) return;
            const profile = profileOf(tab.profileId);
            if (!profile) {
                notifications.show({
                    color: 'yellow',
                    message: 'Choose a connection for this query first.',
                });
                return;
            }
            if (!(await connect(profile.id))) return;
            const dialect = layoutOf(profile.settings.engine).split;

            let statements: { sql: string }[];
            try {
                if (input.mode === 'current') {
                    const one = await db.statementAt(input.text, input.offset ?? 0, dialect);
                    statements = one ? [one] : [];
                } else {
                    statements = await db.splitSql(input.text, dialect);
                }
            } catch (error) {
                patchQuery(id, {
                    bottom: 'messages',
                    log: [{ index: 0, sql: '', state: 'failed', message: message(error) }],
                });
                return;
            }
            if (statements.length === 0) {
                notifications.show({
                    color: 'blue',
                    message: 'There is nothing to run.',
                    autoClose: 2500,
                });
                return;
            }

            await closeRun(tab.runId);
            // The tab's database and schema are set on the shared connection before its statements,
            // so a tab behaves the same whichever tab ran last.
            const engine = profile.settings.engine;
            const preface = startOfScript(
                engine,
                tab.database ?? undefined,
                tab.schema ?? undefined,
            )
                .split(/\r?\n/)
                .filter(Boolean);
            patchQuery(id, {
                running: true,
                runId: null,
                snapshot: null,
                log: [],
                resultIndex: 0,
                bottom: 'results',
                explain: null,
                explainError: null,
            });
            if (preface.length > 0 && ops) {
                const outcomes = await ops.execute(profile.id, preface);
                const failed = outcomes.find((o) => !o.ok);
                if (failed) {
                    patchQuery(id, {
                        running: false,
                        bottom: 'messages',
                        log: [
                            {
                                index: 0,
                                sql: failed.sql,
                                state: 'failed',
                                message: `Could not switch to the chosen database or schema: ${failed.error}`,
                            },
                        ],
                    });
                    return;
                }
            }
            const log: StatementLog[] = [];
            const pushLog = (entry: StatementLog) => {
                log[entry.index] = entry;
                patchQuery(id, { log: [...log] });
            };

            let previous: string | null = null;
            for (let index = 0; index < statements.length; index++) {
                const sql = statements[index]!.sql;
                const preview = sql.replace(/\s+/g, ' ').slice(0, 120);
                const queryId = hex16();
                startedAt.current.set(queryId, Date.now());
                pushLog({ index, sql: preview, state: 'running' });
                if (previous) await closeRun(previous);
                previous = queryId;
                patchQuery(id, { runId: queryId, snapshot: null, resultIndex: 0 });
                let snapshot: DbQuerySnapshot;
                try {
                    const waiting = new Promise<DbQuerySnapshot>((resolve) =>
                        settled.current.set(queryId, resolve),
                    );
                    await db.startQuery(profile.id, queryId, sql, profile.settings.queryTimeoutMs);
                    snapshot = await waiting;
                } catch (error) {
                    const text = message(error);
                    pushLog({ index, sql: preview, state: 'failed', message: text });
                    useHistory.getState().add({
                        profileId: profile.id,
                        sql,
                        at: Date.now(),
                        elapsedMs: 0,
                        state: 'failed',
                        error: text,
                    });
                    patchQuery(id, { bottom: 'messages' });
                    break;
                } finally {
                    settled.current.delete(queryId);
                }

                const first = snapshot.results[0];
                const last = snapshot.results.at(-1);
                const state = snapshot.state === 'running' ? 'done' : snapshot.state;
                pushLog({
                    index,
                    sql: preview,
                    state,
                    elapsedMs: snapshot.elapsedMs,
                    ...(first
                        ? { rows: snapshot.results.reduce((sum, r) => sum + r.rowCount, 0) }
                        : {}),
                    ...(last?.affectedRows !== undefined
                        ? { affectedRows: last.affectedRows }
                        : {}),
                    ...(snapshot.error ? { message: snapshot.error.message } : {}),
                });
                useHistory.getState().add({
                    profileId: profile.id,
                    sql,
                    at: Date.now(),
                    elapsedMs: snapshot.elapsedMs,
                    state,
                    ...(first ? { rows: first.rowCount } : {}),
                    ...(last?.affectedRows !== undefined
                        ? { affectedRows: last.affectedRows }
                        : {}),
                    ...(snapshot.error ? { error: snapshot.error.message } : {}),
                });
                if (snapshot.state === 'failed') {
                    patchQuery(id, { bottom: 'messages' });
                    break;
                }
                if (snapshot.state === 'cancelled') break;
                // A statement that changes data shows its message; one that returns rows shows the grid.
                if (index === statements.length - 1 && !first?.columns.length)
                    patchQuery(id, { bottom: 'messages' });
            }
            patchQuery(id, { running: false });
        },
        [db, connect, closeRun, ops],
    );

    const cancel = useCallback(
        async (id: string) => {
            const tab = useQueries.getState().tabs[id];
            if (!db || !tab) return;
            if (tab.scriptId && tab.script?.state === 'running')
                await db.cancelScript(tab.scriptId).catch(() => undefined);
            if (tab.runId) await db.cancelQuery(tab.runId).catch(() => undefined);
        },
        [db],
    );

    const demand = useCallback(
        (id: string, rows: number) => {
            const tab = useQueries.getState().tabs[id];
            if (db && tab?.runId)
                void db.demand(tab.runId, tab.resultIndex, rows).catch(() => undefined);
        },
        [db],
    );

    const fetchAll = useCallback(
        (id: string) => {
            const tab = useQueries.getState().tabs[id];
            if (db && tab?.runId)
                void db.fetchAll(tab.runId, tab.resultIndex).catch(() => undefined);
        },
        [db],
    );

    const explain = useCallback(
        async (id: string, text: string) => {
            const tab = useQueries.getState().tabs[id];
            const profile = profileOf(tab?.profileId ?? null);
            if (!db || !tab || !profile) return;
            if (!(await connect(profile.id))) return;
            patchQuery(id, { bottom: 'explain', explain: null, explainError: null });
            try {
                const statement = (
                    await db.splitSql(text, layoutOf(profile.settings.engine).split)
                )[0];
                if (!statement) throw new Error('There is no statement to explain.');
                patchQuery(id, { explain: await db.explain(profile.id, statement.sql) });
            } catch (error) {
                patchQuery(id, { explainError: message(error) });
            }
        },
        [db, connect],
    );

    const transaction = useCallback(
        async (id: string, action: 'begin' | 'commit' | 'rollback') => {
            const tab = useQueries.getState().tabs[id];
            if (!db || !tab?.profileId) return;
            if (!(await connect(tab.profileId))) return;
            try {
                await db.transaction(tab.profileId, action);
                patchQuery(id, { inTransaction: action === 'begin' });
                notifications.show({
                    color: 'teal',
                    message:
                        action === 'begin'
                            ? 'Transaction started.'
                            : action === 'commit'
                              ? 'Committed.'
                              : 'Rolled back.',
                    autoClose: 2000,
                });
            } catch (error) {
                notifications.show({ color: 'red', title: 'Transaction', message: message(error) });
            }
        },
        [db, connect],
    );

    return useMemo(
        () =>
            db
                ? {
                      available: true,
                      engines,
                      saveProfile,
                      deleteProfile,
                      testConnection,
                      connect,
                      disconnect,
                      toggle,
                      refresh,
                      refreshRow,
                      definition,
                      listMeta,
                      ops,
                      setContext,
                      newQuery,
                      openTable,
                      closeQuery,
                      setText,
                      setConnection,
                      run,
                      cancel,
                      fetchAll,
                      demand,
                      explain,
                      transaction,
                      setBottom,
                      setResult,
                      db,
                  }
                : UNAVAILABLE,
        [
            db,
            engines,
            saveProfile,
            deleteProfile,
            testConnection,
            connect,
            disconnect,
            toggle,
            refresh,
            refreshRow,
            definition,
            listMeta,
            ops,
            setContext,
            newQuery,
            openTable,
            closeQuery,
            setText,
            setConnection,
            run,
            cancel,
            fetchAll,
            demand,
            explain,
            transaction,
            setBottom,
            setResult,
        ],
    );
}

export { DbApiError, isQueryTabId, newProfileId };
