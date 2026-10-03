/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import type {
    DbColumnInfo,
    DbConnectionStatus,
    DbDatabaseInfo,
    DbEventInfo,
    DbIndexInfo,
    DbRoutineInfo,
    DbTableInfo,
    DbTriggerInfo,
} from '@httpreq/shared';
import { layoutOf, type GroupLayout } from './engines';
import type { ConnectionProfile } from './profiles';

/** What a loaded list of schema objects looks like in the explorer's cache. */
export type MetaEntry =
    | { state: 'loading' }
    | { state: 'error'; message: string }
    | { state: 'ready'; items: unknown[] };

export type RowKind =
    | 'connection'
    | 'database'
    | 'schema'
    | 'group'
    | 'table'
    | 'view'
    | 'column'
    | 'index'
    | 'routine'
    | 'trigger'
    | 'event'
    | 'message';

export interface ExplorerRow {
    /** Stable key; also what is expanded or collapsed. */
    key: string;
    kind: RowKind;
    depth: number;
    label: string;
    /** A second, dimmer piece of text (a column's type, a table's row count). */
    detail?: string;
    expandable: boolean;
    expanded: boolean;
    loading?: boolean;
    /** The profile and object this row stands for, for its actions. */
    profileId: string;
    engine: string;
    database?: string;
    schema?: string;
    table?: string;
    object?: string;
    /** The engine's own kind of the object: a Redis key type, `materialized view`… */
    objectKind?: string;
    status?: DbConnectionStatus['state'];
    problem?: boolean;
    /** For a column: it is part of the primary key. */
    primaryKey?: boolean;
    /** For a routine: `function` or `procedure`. */
    routineKind?: string;
}

/** Separates the parts of a key. Names can hold any printable character, including `:` and `|`. */
const SEP = '\u001f';

export const rowKey = (...parts: (string | undefined)[]): string =>
    parts.map((p) => p ?? '').join(SEP);

/** Cache keys: one place so the explorer and its loader agree. */
export const metaKey = (
    profileId: string,
    kind: string,
    database = '',
    table = '',
    schema = '',
): string => rowKey(profileId, kind, database, schema, table);

/** The prefix every cache key of a connection starts with. */
export const profileKeyPrefix = (profileId: string): string => `${profileId}${SEP}`;

const COUNT = new Intl.NumberFormat('en-US');

const itemsOf = <T>(
    cache: Record<string, MetaEntry>,
    key: string,
): { entry?: MetaEntry; items: T[] } => {
    const entry = cache[key];
    return { entry, items: entry?.state === 'ready' ? (entry.items as T[]) : [] };
};

/** Pushes the loading or error row a node shows while its children are not there yet. */
const pending = (rows: ExplorerRow[], entry: MetaEntry | undefined, parent: ExplorerRow) => {
    if (!entry || entry.state === 'loading') {
        rows.push({
            ...parent,
            key: `${parent.key}${SEP}loading`,
            kind: 'message',
            depth: parent.depth + 1,
            label: 'Loading…',
            detail: undefined,
            expandable: false,
            expanded: false,
            loading: true,
        });
        return true;
    }
    if (entry.state === 'error') {
        rows.push({
            ...parent,
            key: `${parent.key}${SEP}error`,
            kind: 'message',
            depth: parent.depth + 1,
            label: entry.message,
            detail: undefined,
            expandable: false,
            expanded: false,
            problem: true,
        });
        return true;
    }
    return false;
};

/**
 * The rows the explorer shows, from what is saved, what is connected, what has been loaded and
 * what is expanded. It is a pure function of those four, so the tree needs no state of its own
 * and a change anywhere simply produces the next list of rows. How a connection is laid out
 * (databases, then schemas or not, then groups of objects) depends on its engine.
 */
export const buildRows = (
    profiles: ConnectionProfile[],
    status: Record<string, DbConnectionStatus>,
    cache: Record<string, MetaEntry>,
    expanded: ReadonlySet<string>,
    filter = '',
): ExplorerRow[] => {
    const rows: ExplorerRow[] = [];
    const term = filter.trim().toLowerCase();

    for (const profile of profiles) {
        const engine = profile.settings.engine;
        const layout = layoutOf(engine);
        const state = status[profile.id]?.state;
        const connected = state === 'connected';
        // Searching narrows the saved connections by name or address; a connected one always stays,
        // because the objects under it are what the search may be for.
        if (
            term &&
            !connected &&
            !`${profile.name} ${profile.settings.host}`.toLowerCase().includes(term)
        )
            continue;
        const key = rowKey('c', profile.id);
        const connection: ExplorerRow = {
            key,
            kind: 'connection',
            depth: 0,
            label: profile.name,
            detail: `${profile.settings.host}:${profile.settings.port}`,
            expandable: connected,
            expanded: connected && expanded.has(key),
            profileId: profile.id,
            engine,
            status: state ?? 'disconnected',
            loading: state === 'connecting',
            problem: state === 'failed',
        };
        rows.push(connection);
        if (!connection.expanded) continue;

        const databases = itemsOf<DbDatabaseInfo>(cache, metaKey(profile.id, 'databases'));
        if (pending(rows, databases.entry, connection)) continue;
        // The user's own databases first, then the system ones.
        const ordered = [...databases.items].sort(
            (a, b) =>
                Number(a.system) - Number(b.system) ||
                a.name.localeCompare(b.name, undefined, { numeric: true }),
        );
        for (const database of ordered) {
            const dbKey = rowKey('d', profile.id, database.name);
            // PostgreSQL runs statements on the database it connected to; the others are for browsing.
            const browseOnly =
                engine === 'postgresql' &&
                database.name !== (profile.settings.database || profile.settings.username);
            const dbRow: ExplorerRow = {
                key: dbKey,
                kind: 'database',
                depth: 1,
                label: database.name,
                detail: database.system ? 'system' : browseOnly ? 'browse only' : undefined,
                expandable: true,
                expanded: expanded.has(dbKey),
                profileId: profile.id,
                engine,
                database: database.name,
            };
            rows.push(dbRow);
            if (!dbRow.expanded) continue;

            if (layout.schemas) {
                const schemas = itemsOf<{ name: string; system: boolean }>(
                    cache,
                    metaKey(profile.id, 'schemas', database.name),
                );
                if (pending(rows, schemas.entry, dbRow)) continue;
                const orderedSchemas = [...schemas.items].sort(
                    (a, b) => Number(a.system) - Number(b.system) || a.name.localeCompare(b.name),
                );
                for (const schema of orderedSchemas) {
                    const schemaKey = rowKey('s', profile.id, database.name, schema.name);
                    const schemaRow: ExplorerRow = {
                        key: schemaKey,
                        kind: 'schema',
                        depth: 2,
                        label: schema.name,
                        detail: schema.system ? 'system' : undefined,
                        expandable: true,
                        expanded: expanded.has(schemaKey),
                        profileId: profile.id,
                        engine,
                        database: database.name,
                        schema: schema.name,
                    };
                    rows.push(schemaRow);
                    if (!schemaRow.expanded) continue;
                    for (const group of layout.groups) {
                        rows.push(
                            ...groupRows(
                                profile.id,
                                engine,
                                database.name,
                                schema.name,
                                group,
                                3,
                                cache,
                                expanded,
                                term,
                            ),
                        );
                    }
                }
            } else {
                for (const group of layout.groups) {
                    rows.push(
                        ...groupRows(
                            profile.id,
                            engine,
                            database.name,
                            undefined,
                            group,
                            2,
                            cache,
                            expanded,
                            term,
                        ),
                    );
                }
            }
        }
    }
    return rows;
};

const groupRows = (
    profileId: string,
    engine: string,
    database: string,
    schema: string | undefined,
    group: GroupLayout,
    depth: number,
    cache: Record<string, MetaEntry>,
    expanded: ReadonlySet<string>,
    term: string,
): ExplorerRow[] => {
    const rows: ExplorerRow[] = [];
    const layout = layoutOf(engine);
    const key = rowKey('g', profileId, database, schema, group.id);
    const row: ExplorerRow = {
        key,
        kind: 'group',
        depth,
        label: group.label,
        expandable: true,
        expanded: expanded.has(key),
        profileId,
        engine,
        database,
        schema,
        object: group.id,
    };
    rows.push(row);
    if (!row.expanded) return rows;

    const match = (name: string) => !term || name.toLowerCase().includes(term);
    // Tables and views come from one listing.
    const source = group.id === 'views' ? 'tables' : group.id;
    const { entry, items } = itemsOf<unknown>(
        cache,
        metaKey(profileId, source, database, '', schema),
    );
    if (pending(rows, entry, row)) return rows;

    if (group.id === 'tables' || group.id === 'views') {
        const tables = (items as DbTableInfo[]).filter(
            (t) => (!group.kinds || group.kinds.includes(t.kind)) && match(t.name),
        );
        row.detail = String(tables.length);
        const asView = group.id === 'views';
        for (const table of tables) {
            // A note the engine adds (Redis: "more keys than listed") is not an object.
            if (table.kind === 'note') {
                rows.push({
                    ...row,
                    key: rowKey('n', profileId, database, table.name),
                    kind: 'message',
                    depth: depth + 1,
                    label: table.name,
                    expandable: false,
                    expanded: false,
                    object: undefined,
                });
                continue;
            }
            const tableKey = rowKey('t', profileId, database, schema, table.name);
            const tableRow: ExplorerRow = {
                key: tableKey,
                kind: asView ? 'view' : 'table',
                depth: depth + 1,
                label: table.name,
                detail:
                    engine === 'redis'
                        ? table.kind
                        : table.rows !== undefined && !asView
                          ? `${COUNT.format(table.rows)} rows`
                          : undefined,
                expandable: layout.objectsExpand,
                expanded: layout.objectsExpand && expanded.has(tableKey),
                profileId,
                engine,
                database,
                schema,
                table: table.name,
                objectKind: table.kind,
            };
            rows.push(tableRow);
            if (!tableRow.expanded) continue;
            const columns = itemsOf<DbColumnInfo>(
                cache,
                metaKey(profileId, 'columns', database, table.name, schema),
            );
            if (!pending(rows, columns.entry, tableRow)) {
                for (const column of columns.items) {
                    rows.push({
                        key: rowKey('f', profileId, database, schema, table.name, column.name),
                        kind: 'column',
                        depth: depth + 2,
                        label: column.name,
                        detail: `${column.type}${column.primaryKey ? ' · key' : ''}${column.nullable ? '' : ' · not null'}`,
                        expandable: false,
                        expanded: false,
                        profileId,
                        engine,
                        database,
                        schema,
                        table: table.name,
                        object: column.name,
                        primaryKey: column.primaryKey,
                    });
                }
            }
            const indexes = itemsOf<DbIndexInfo>(
                cache,
                metaKey(profileId, 'indexes', database, table.name, schema),
            );
            for (const index of indexes.items) {
                rows.push({
                    key: rowKey('i', profileId, database, schema, table.name, index.name),
                    kind: 'index',
                    depth: depth + 2,
                    label: index.name,
                    detail: `${index.unique ? 'unique ' : ''}(${index.columns.join(', ')})`,
                    expandable: false,
                    expanded: false,
                    profileId,
                    engine,
                    database,
                    schema,
                    table: table.name,
                    object: index.name,
                });
            }
        }
        return rows;
    }

    const leaf = (
        kind: RowKind,
        prefix: string,
        name: string,
        detail: string | undefined,
    ): ExplorerRow => ({
        key: rowKey(prefix, profileId, database, schema, name),
        kind,
        depth: depth + 1,
        label: name,
        detail,
        expandable: false,
        expanded: false,
        profileId,
        engine,
        database,
        schema,
        object: name,
    });
    if (group.id === 'routines') {
        const routines = (items as DbRoutineInfo[]).filter((r) => match(r.name));
        row.detail = String(routines.length);
        for (const routine of routines)
            rows.push({
                ...leaf('routine', 'r', routine.name, routine.kind),
                routineKind: routine.kind,
            });
    } else if (group.id === 'triggers') {
        const triggers = (items as DbTriggerInfo[]).filter((t) => match(t.name));
        row.detail = String(triggers.length);
        for (const trigger of triggers) {
            rows.push({
                ...leaf(
                    'trigger',
                    'tr',
                    trigger.name,
                    `${trigger.timing} ${trigger.event} on ${trigger.table}`,
                ),
                // The table it fires on, to drop it and to open the trigger manager there.
                table: trigger.table,
            });
        }
    } else {
        const events = (items as DbEventInfo[]).filter((e) => match(e.name));
        row.detail = String(events.length);
        for (const event of events) {
            rows.push(
                leaf('event', 'e', event.name, `${event.status.toLowerCase()} · ${event.schedule}`),
            );
        }
    }
    return rows;
};

/** What must be loaded for a row to be expanded. */
export const loadsFor = (
    row: ExplorerRow,
): { kind: string; database?: string; table?: string; schema?: string }[] => {
    switch (row.kind) {
        case 'connection':
            return [{ kind: 'databases' }];
        case 'database':
            return layoutOf(row.engine).schemas
                ? [{ kind: 'schemas', database: row.database }]
                : [];
        case 'group': {
            const group = (row.object ?? 'tables') as string;
            return [
                {
                    kind: group === 'views' ? 'tables' : group,
                    database: row.database,
                    schema: row.schema,
                },
            ];
        }
        case 'table':
        case 'view':
            return layoutOf(row.engine).objectsExpand
                ? [
                      {
                          kind: 'columns',
                          database: row.database,
                          table: row.table,
                          schema: row.schema,
                      },
                      {
                          kind: 'indexes',
                          database: row.database,
                          table: row.table,
                          schema: row.schema,
                      },
                  ]
                : [];
        default:
            return [];
    }
};
