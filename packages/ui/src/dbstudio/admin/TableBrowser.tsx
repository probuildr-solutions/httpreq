/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import {
    IconChevronLeft,
    IconChevronRight,
    IconCode,
    IconDownload,
    IconFilter,
    IconLayoutSidebarRight,
    IconPlus,
    IconRefresh,
    IconTrash,
    IconX,
} from '@tabler/icons-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    FILTER_OPERATORS,
    categoryOfType,
    countSql,
    dialectOf,
    parseCellInput,
    selectPageSql,
    type FilterClause,
    type ObjectName,
    type SortClause,
    type SqlValue,
} from '@httpreq/db-admin';
import type { DbCell, DbColumnInfo, DbIndexInfo } from '@httpreq/shared';
import { AppModal } from '../../AppModal';
import { copyText } from '../../clipboard';
import { confirmAction } from '../../confirm';
import {
    ActionIcon,
    Alert,
    Button,
    Menu,
    Select,
    Text,
    TextInput,
    Textarea,
    Tooltip,
    cx,
    notifications,
} from '../../kit';
import { formatCell } from '../db/cells';
import type { FetchedRows } from '../db/dbOps';
import { useQueries } from '../db/queryStore';
import { useProfiles } from '../db/profiles';
import { useDbManager } from '../db/useDbManager';
import { useDbStudio } from '../useDbStudio';
import { patchAdmin, useAdmin } from './adminStore';
import {
    cellToSqlValue,
    editText,
    isEditableCell,
    rowsToCsv,
    rowsToInserts,
    rowsToJson,
    rowsToTsv,
} from './cellValue';
import { DataGrid, type GridCellView } from './DataGrid';
import {
    buildChangeStatements,
    changeCount,
    editKey,
    emptyChanges,
    keyColumnsOf,
    type StagedChanges,
    type TableColumn,
} from './tableChanges';

interface ViewState {
    page: number;
    pageSize: number;
    filters: FilterClause[];
    rawWhere: string;
    sort: SortClause[];
}

const DEFAULT_VIEW: ViewState = { page: 0, pageSize: 100, filters: [], rawWhere: '', sort: [] };
const PAGE_SIZES = ['50', '100', '250', '500', '1000'].map((value) => ({
    value,
    label: `${value} rows`,
}));

const cloneChanges = (c: StagedChanges): StagedChanges => ({
    edits: new Map(c.edits),
    deleted: new Set(c.deleted),
    inserts: c.inserts.map((insert) => new Map(insert)),
});

/**
 * Browse and edit the rows of a table (MySQL or PostgreSQL). One page is read at a time with
 * LIMIT/OFFSET, filtered and sorted by the server, and shown in a virtualised grid, so the size
 * of the table never matters to the window. Edits, inserts and deletes are staged and written
 * together after a preview of the exact statements, in a transaction when the connection is free
 * of another tab's transaction.
 */
export function TableBrowser({ id }: { id: string }) {
    const manager = useDbManager();
    const studio = useDbStudio();
    const tab = useAdmin((state) => state.tabs[id]);
    const profile = useProfiles((state) => state.profiles.find((p) => p.id === tab?.profileId));
    const engine = profile?.settings.engine ?? 'mysql';
    const dialect = useMemo(() => dialectOf(engine), [engine]);

    const saved = (tab?.state.view as ViewState | undefined) ?? DEFAULT_VIEW;
    const [view, setViewState] = useState<ViewState>(saved);
    const setView = useCallback(
        (patch: Partial<ViewState>) =>
            setViewState((current) => {
                const next = { ...current, ...patch };
                patchAdmin(id, (t) => ({ state: { ...t.state, view: next } }));
                return next;
            }),
        [id],
    );

    const table: ObjectName = useMemo(
        () => ({
            database: engine === 'mysql' ? tab?.database : undefined,
            schema: engine === 'postgresql' ? tab?.schema : undefined,
            name: tab?.name ?? '',
        }),
        [engine, tab?.database, tab?.schema, tab?.name],
    );

    const [columns, setColumns] = useState<TableColumn[]>([]);
    const [keyColumns, setKeyColumns] = useState<number[]>([]);
    const [data, setData] = useState<FetchedRows | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [version, setVersion] = useState(0);
    const [total, setTotal] = useState<number | null>(null);
    const [changes, setChanges] = useState<StagedChanges>(emptyChanges);
    const [active, setActive] = useState<{ row: number; column: number } | null>(null);
    const [selected, setSelected] = useState<Set<number>>(new Set());
    const [editing, setEditing] = useState<{ row: number; column: number; text: string } | null>(
        null,
    );
    const [dialog, setDialog] = useState<{ row: number; column: number } | null>(null);
    const [menu, setMenu] = useState<{ row: number; column: number; x: number; y: number } | null>(
        null,
    );
    const [inspect, setInspect] = useState(false);
    const [showFilters, setShowFilters] = useState(view.filters.length > 0 || view.rawWhere !== '');
    const [preview, setPreview] = useState<{ statements: string[]; problems: string[] } | null>(
        null,
    );
    const [applying, setApplying] = useState(false);
    const request = useRef(0);

    const profileId = tab?.profileId ?? '';
    const { listMeta, ops } = manager;

    /* ---------- Structure ---------- */

    useEffect(() => {
        if (!profileId || !table.name) return;
        let cancelled = false;
        const scope = {
            ...(tab?.database ? { database: tab.database } : {}),
            ...(tab?.schema ? { schema: tab.schema } : {}),
            name: table.name,
        };
        void (async () => {
            try {
                const [cols, indexes] = await Promise.all([
                    listMeta(profileId, 'columns', scope) as Promise<DbColumnInfo[]>,
                    listMeta(profileId, 'indexes', scope).catch(() => []) as Promise<DbIndexInfo[]>,
                ]);
                if (cancelled) return;
                const mapped: TableColumn[] = [...cols]
                    .sort((a, b) => a.position - b.position)
                    .map((c) => ({
                        name: c.name,
                        type: c.type,
                        primaryKey: c.primaryKey,
                        autoIncrement: c.autoIncrement,
                        nullable: c.nullable,
                    }));
                setColumns(mapped);
                setKeyColumns(
                    keyColumnsOf(
                        mapped,
                        indexes.filter((i) => i.unique),
                    ),
                );
            } catch (e) {
                if (!cancelled) setError(e instanceof Error ? e.message : String(e));
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [profileId, table.name, tab?.database, tab?.schema, listMeta, version]);

    /* ---------- Rows ---------- */

    const browseSql = useMemo(
        () =>
            selectPageSql(dialect, {
                table,
                filters: view.filters.filter((f) => f.column),
                rawWhere: view.rawWhere,
                sort: view.sort,
                limit: view.pageSize,
                offset: view.page * view.pageSize,
            }),
        [dialect, table, view],
    );

    useEffect(() => {
        if (!ops || !profileId || !table.name) return;
        const mine = ++request.current;
        setLoading(true);
        setError(null);
        void ops
            .fetchRows(profileId, browseSql, { maxRows: view.pageSize })
            .then((rows) => {
                if (request.current !== mine) return;
                setData(rows);
                setChanges(emptyChanges());
                setSelected(new Set());
                setActive(null);
                setEditing(null);
            })
            .catch((e) => {
                if (request.current === mine) setError(e instanceof Error ? e.message : String(e));
            })
            .finally(() => {
                if (request.current === mine) setLoading(false);
            });
    }, [ops, profileId, table.name, browseSql, view.pageSize, version]);

    const reload = () => setVersion((v) => v + 1);
    const rows = useMemo(() => data?.rows ?? [], [data]);
    const rowCount = rows.length + changes.inserts.length;
    const dirtyCount = changeCount(changes);
    useEffect(() => patchAdmin(id, { dirty: dirtyCount > 0 }), [id, dirtyCount]);

    const columnsByName = useMemo(
        () => columns.map((c) => ({ name: c.name, type: c.type })),
        [columns],
    );
    const canEdit = keyColumns.length > 0;

    const cellView = useCallback(
        (row: number, column: number): GridCellView => {
            const meta = columns[column];
            const type = meta?.type ?? '';
            const numeric = categoryOfType(type) === 'number';
            if (row >= rows.length) {
                const edit = changes.inserts[row - rows.length]?.get(column);
                return edit
                    ? { text: edit.text, isNull: edit.value.kind === 'null', edited: true, numeric }
                    : { text: meta?.autoIncrement ? 'AUTO' : 'DEFAULT', isNull: true, numeric };
            }
            const edit = changes.edits.get(editKey(row, column));
            if (edit)
                return {
                    text: edit.text,
                    isNull: edit.value.kind === 'null',
                    edited: true,
                    numeric,
                };
            const value = rows[row]?.[column];
            return {
                text: formatCell(value),
                isNull: value === null || value === undefined,
                clipped: data?.clipped.has(`${row}:${column}`),
                numeric,
            };
        },
        [columns, rows, changes, data],
    );

    /* ---------- Editing ---------- */

    const stage = (row: number, column: number, value: SqlValue, text: string) =>
        setChanges((current) => {
            const next = cloneChanges(current);
            if (row >= rows.length) {
                const insert = next.inserts[row - rows.length];
                if (insert) insert.set(column, { value, text });
            } else {
                // A value equal to the original is not a change.
                next.edits.set(editKey(row, column), { value, text });
            }
            return next;
        });

    const original = (row: number, column: number): DbCell | undefined => rows[row]?.[column];

    const startEdit = (row: number, column: number) => {
        const meta = columns[column];
        if (!meta) return;
        const isNew = row >= rows.length;
        if (!isNew && !canEdit) {
            notifications.show({
                color: 'yellow',
                message: 'This table has no key, so its rows cannot be edited here.',
            });
            return;
        }
        if (
            !isNew &&
            (data?.clipped.has(`${row}:${column}`) ||
                !isEditableCell(original(row, column), meta.type))
        ) {
            notifications.show({
                color: 'yellow',
                message: 'This value is too large to edit in the grid. Use a query to change it.',
            });
            return;
        }
        if (changes.deleted.has(row)) return;
        const category = categoryOfType(meta.type);
        const current = cellView(row, column);
        if (
            category === 'json' ||
            category === 'binary' ||
            current.text.length > 80 ||
            current.text.includes('\n')
        ) {
            setDialog({ row, column });
            return;
        }
        const staged = isNew
            ? changes.inserts[row - rows.length]?.get(column)
            : changes.edits.get(editKey(row, column));
        setEditing({
            row,
            column,
            text: staged
                ? staged.value.kind === 'null' || staged.value.kind === 'default'
                    ? ''
                    : staged.text
                : isNew
                  ? ''
                  : editText(original(row, column), meta.type),
        });
    };

    const commitEdit = (text: string, row: number, column: number) => {
        const meta = columns[column]!;
        const parsed = parseCellInput(meta.type, text);
        if (!parsed.ok) {
            notifications.show({ color: 'red', message: parsed.error });
            return false;
        }
        // Typing nothing into a nullable, non-text cell is NULL.
        const empty = text === '' && categoryOfType(meta.type) !== 'text';
        const value: SqlValue = empty ? { kind: 'null' } : parsed.value;
        const same =
            row < rows.length &&
            JSON.stringify(cellToSqlValue(original(row, column), meta.type)) ===
                JSON.stringify(value);
        if (same) {
            setChanges((current) => {
                const next = cloneChanges(current);
                next.edits.delete(editKey(row, column));
                return next;
            });
        } else stage(row, column, value, empty ? 'NULL' : text);
        setEditing(null);
        return true;
    };

    const setSpecial = (row: number, column: number, kind: 'null' | 'default') => {
        if (row < rows.length && !canEdit) return;
        stage(row, column, { kind }, kind === 'null' ? 'NULL' : 'DEFAULT');
    };

    const insertRow = () => {
        setChanges((current) => {
            const next = cloneChanges(current);
            next.inserts.push(new Map());
            return next;
        });
        const row = rowCount;
        const first = columns.findIndex((c) => !c.autoIncrement);
        setActive({ row, column: Math.max(0, first) });
        setSelected(new Set([row]));
    };

    const deleteSelected = () => {
        if (selected.size === 0) return;
        if (!canEdit && [...selected].some((row) => row < rows.length)) {
            notifications.show({
                color: 'yellow',
                message: 'This table has no key, so its rows cannot be deleted here.',
            });
            return;
        }
        setChanges((current) => {
            const next = cloneChanges(current);
            const fresh = [...selected].filter((row) => row >= rows.length).sort((a, b) => b - a);
            for (const row of fresh) next.inserts.splice(row - rows.length, 1);
            for (const row of selected) if (row < rows.length) next.deleted.add(row);
            return next;
        });
        setSelected(new Set());
    };

    const discard = () => {
        setChanges(emptyChanges());
        setEditing(null);
    };

    /* ---------- Applying ---------- */

    const buildStatements = () =>
        buildChangeStatements(dialect, table, columns, keyColumns, rows, changes);

    const openPreview = () => setPreview(buildStatements());

    const apply = async () => {
        if (!ops || !preview) return;
        const { statements } = preview;
        if (statements.length === 0) return;
        setApplying(true);
        try {
            // Another tab's open transaction on this connection would be committed by a BEGIN.
            const busy = Object.values(useQueries.getState().tabs).some(
                (t) => t.profileId === profileId && t.inTransaction,
            );
            const wrap = !busy && statements.length > 1;
            const begin = dialect.id === 'mysql' ? 'START TRANSACTION' : 'BEGIN';
            const outcomes = await ops.execute(
                profileId,
                wrap ? [begin, ...statements, 'COMMIT'] : statements,
            );
            const failed = outcomes.find((o) => !o.ok);
            if (failed) {
                if (wrap) await ops.execute(profileId, ['ROLLBACK']);
                notifications.show({
                    color: 'red',
                    title: wrap ? 'Nothing was changed' : 'Some changes were not written',
                    message: failed.error ?? 'A statement failed.',
                    autoClose: 10_000,
                });
                return;
            }
            notifications.show({
                color: 'teal',
                message: `${statements.length} change${statements.length === 1 ? '' : 's'} written.`,
                autoClose: 3000,
            });
            setPreview(null);
            reload();
        } finally {
            setApplying(false);
        }
    };

    /* ---------- Copy and export ---------- */

    const selectedRowIndexes = () =>
        [...(selected.size ? selected : active ? new Set([active.row]) : new Set<number>())]
            .filter((row) => row < rows.length)
            .sort((a, b) => a - b);

    const copy = async (what: 'cell' | 'row' | 'csv' | 'json' | 'insert') => {
        const picked = selectedRowIndexes();
        let text = '';
        if (what === 'cell' && active) text = formatCell(rows[active.row]?.[active.column]);
        else if (what === 'row')
            text = rowsToTsv(
                picked.map((r) => rows[r]!),
                columns.map((_, i) => i),
            );
        else if (what === 'csv')
            text = rowsToCsv(
                columnsByName,
                picked.map((r) => rows[r]!),
            );
        else if (what === 'json')
            text = rowsToJson(
                columnsByName,
                picked.map((r) => rows[r]!),
            );
        else if (what === 'insert')
            text = rowsToInserts(
                dialect,
                table,
                columnsByName,
                picked.map((r) => rows[r]!),
            );
        if (!text) return;
        await copyText(text);
        notifications.show({ color: 'teal', message: 'Copied.', autoClose: 1500 });
    };

    const saveRows = async (format: 'csv' | 'json' | 'sql') => {
        const picked = selected.size ? selectedRowIndexes() : rows.map((_, i) => i);
        const subset = picked.map((r) => rows[r]!);
        const text =
            format === 'csv'
                ? rowsToCsv(columnsByName, subset)
                : format === 'json'
                  ? rowsToJson(columnsByName, subset)
                  : rowsToInserts(dialect, table, columnsByName, subset);
        const result = await studio.saveText(null, `${table.name}.${format}`, text);
        if (result.kind === 'failed')
            notifications.show({ color: 'red', title: 'Could not save', message: result.message });
        else if (result.kind === 'saved')
            notifications.show({
                color: 'teal',
                message: `Saved ${subset.length} rows to ${result.name}.`,
            });
    };

    /* ---------- Paging and sorting ---------- */

    const lastPage = total === null ? null : Math.max(0, Math.ceil(total / view.pageSize) - 1);
    const hasNext = lastPage === null ? rows.length === view.pageSize : view.page < lastPage;

    const countRows = async () => {
        if (!ops) return;
        try {
            const result = await ops.fetchRows(
                profileId,
                countSql(
                    dialect,
                    table,
                    view.filters.filter((f) => f.column),
                    view.rawWhere,
                ),
                { maxRows: 1 },
            );
            setTotal(Number(result.rows[0]?.[0] ?? 0));
        } catch (e) {
            notifications.show({
                color: 'red',
                title: 'Could not count rows',
                message: e instanceof Error ? e.message : String(e),
            });
        }
    };
    // A different filter means a different total.
    useEffect(() => setTotal(null), [view.filters, view.rawWhere, version]);

    const sortBy = (column: number, additive: boolean) => {
        const name = columns[column]?.name;
        if (!name) return;
        const existing = view.sort.find((s) => s.column === name);
        let next: SortClause[];
        if (!existing)
            next = additive
                ? [...view.sort, { column: name, direction: 'asc' }]
                : [{ column: name, direction: 'asc' }];
        else if (existing.direction === 'asc')
            next = view.sort.map((s) =>
                s.column === name ? { ...s, direction: 'desc' as const } : s,
            );
        else next = view.sort.filter((s) => s.column !== name);
        setView({ sort: next, page: 0 });
    };

    const guardUnsaved = async (): Promise<boolean> => {
        if (dirtyCount === 0) return true;
        const answer = await confirmAction({
            title: 'Discard the staged changes?',
            message: `${dirtyCount} change${dirtyCount === 1 ? ' is' : 's are'} staged and not written. Changing the page or the filter discards them.`,
            confirmLabel: 'Discard changes',
            danger: true,
        });
        return answer === 'confirm';
    };

    /* ---------- Keyboard ---------- */

    const onKeyDown = (event: React.KeyboardEvent) => {
        if (editing || dialog) return;
        const row = active?.row ?? 0;
        const column = active?.column ?? 0;
        const move = (dr: number, dc: number) => {
            event.preventDefault();
            const nextRow = Math.min(rowCount - 1, Math.max(0, row + dr));
            const nextColumn = Math.min(columns.length - 1, Math.max(0, column + dc));
            setActive({ row: nextRow, column: nextColumn });
            setSelected(event.shiftKey ? new Set([...selected, nextRow]) : new Set([nextRow]));
        };
        if (event.key === 'ArrowDown') move(1, 0);
        else if (event.key === 'ArrowUp') move(-1, 0);
        else if (event.key === 'ArrowRight') move(0, 1);
        else if (event.key === 'ArrowLeft') move(0, -1);
        else if ((event.key === 'Enter' || event.key === 'F2') && active) {
            event.preventDefault();
            startEdit(active.row, active.column);
        } else if (event.key === 'Delete' && selected.size) {
            event.preventDefault();
            deleteSelected();
        } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') {
            event.preventDefault();
            void copy(event.shiftKey ? 'row' : 'cell');
        } else if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && dirtyCount) {
            event.preventDefault();
            openPreview();
        }
    };

    if (!tab) return null;
    if (!ops) {
        return (
            <div className="p-6">
                <Text size="sm" className="text-dimmed">
                    Editing table data is part of the desktop app.
                </Text>
            </div>
        );
    }

    const first = view.page * view.pageSize;
    const inspectRow = active && active.row < rows.length ? rows[active.row] : undefined;
    const dialogMeta = dialog ? columns[dialog.column] : undefined;

    return (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="table-browser">
            <div className="box-border flex h-9 flex-none items-center gap-1 overflow-x-auto border-b border-line bg-chrome px-2 whitespace-nowrap">
                <Tooltip label="Reload this page">
                    <ActionIcon
                        size="sm"
                        variant="subtle"
                        aria-label="Reload"
                        onClick={async () => (await guardUnsaved()) && reload()}
                    >
                        <IconRefresh size={15} />
                    </ActionIcon>
                </Tooltip>
                <Button
                    size="xs"
                    variant="subtle"
                    leftSection={<IconPlus size={14} />}
                    onClick={insertRow}
                >
                    Insert row
                </Button>
                <Button
                    size="xs"
                    variant="subtle"
                    color="red"
                    leftSection={<IconTrash size={14} />}
                    disabled={selected.size === 0}
                    onClick={deleteSelected}
                >
                    Delete
                </Button>
                <span className="mx-1 h-4 w-px bg-line" />
                <Button size="xs" disabled={dirtyCount === 0} onClick={openPreview}>
                    Apply{dirtyCount ? ` (${dirtyCount})` : ''}
                </Button>
                <Button size="xs" variant="subtle" disabled={dirtyCount === 0} onClick={discard}>
                    Discard
                </Button>
                <span className="mx-1 h-4 w-px bg-line" />
                <Button
                    size="xs"
                    variant={showFilters ? 'light' : 'subtle'}
                    leftSection={<IconFilter size={14} />}
                    onClick={() => setShowFilters((v) => !v)}
                >
                    Filter
                    {view.filters.length + (view.rawWhere ? 1 : 0) > 0
                        ? ` (${view.filters.length + (view.rawWhere ? 1 : 0)})`
                        : ''}
                </Button>
                <Menu position="bottom-start" width={230}>
                    <Menu.Target>
                        <Button size="xs" variant="subtle" leftSection={<IconDownload size={14} />}>
                            Copy / export
                        </Button>
                    </Menu.Target>
                    <Menu.Dropdown>
                        <Menu.Label>
                            {selected.size ? `${selected.size} selected row(s)` : 'The current row'}
                        </Menu.Label>
                        <Menu.Item onClick={() => void copy('row')}>
                            Copy as tab-separated
                        </Menu.Item>
                        <Menu.Item onClick={() => void copy('csv')}>Copy as CSV</Menu.Item>
                        <Menu.Item onClick={() => void copy('json')}>Copy as JSON</Menu.Item>
                        <Menu.Item onClick={() => void copy('insert')}>
                            Copy as INSERT statements
                        </Menu.Item>
                        <Menu.Divider />
                        <Menu.Label>
                            Save {selected.size ? 'the selected rows' : 'this page'} to a file
                        </Menu.Label>
                        <Menu.Item onClick={() => void saveRows('csv')}>CSV…</Menu.Item>
                        <Menu.Item onClick={() => void saveRows('json')}>JSON…</Menu.Item>
                        <Menu.Item onClick={() => void saveRows('sql')}>SQL INSERTs…</Menu.Item>
                    </Menu.Dropdown>
                </Menu>
                <Tooltip label="The statements behind this view">
                    <Button
                        size="xs"
                        variant="subtle"
                        leftSection={<IconCode size={14} />}
                        onClick={() =>
                            setPreview({
                                statements: [browseSql, ...buildStatements().statements],
                                problems: buildStatements().problems,
                            })
                        }
                    >
                        SQL
                    </Button>
                </Tooltip>
                <span className="ml-auto" />
                <Tooltip label="Inspect the selected row">
                    <ActionIcon
                        size="sm"
                        variant={inspect ? 'light' : 'subtle'}
                        aria-label="Inspect row"
                        onClick={() => setInspect((v) => !v)}
                    >
                        <IconLayoutSidebarRight size={15} />
                    </ActionIcon>
                </Tooltip>
            </div>

            {showFilters && (
                <FilterBar
                    columns={columns}
                    filters={view.filters}
                    rawWhere={view.rawWhere}
                    onApply={async (filters, rawWhere) => {
                        if (await guardUnsaved()) setView({ filters, rawWhere, page: 0 });
                    }}
                />
            )}

            {!canEdit && columns.length > 0 && (
                <Alert color="yellow" className="m-2">
                    This table has no primary key or unique key, so existing rows cannot be edited
                    or deleted safely. You can still insert rows.
                </Alert>
            )}
            {error && (
                <Alert color="red" className="m-2" icon={<IconX size={14} />}>
                    {error}
                </Alert>
            )}

            <div className="flex min-h-0 flex-1">
                <div className={cx('min-w-0 flex-1', loading && 'opacity-60')}>
                    {columns.length > 0 && (
                        <DataGrid
                            ariaLabel={`Rows of ${table.name}`}
                            columns={columns}
                            rowCount={rowCount}
                            getCell={cellView}
                            rowFlag={(row) =>
                                row >= rows.length
                                    ? 'new'
                                    : changes.deleted.has(row)
                                      ? 'deleted'
                                      : undefined
                            }
                            firstRowNumber={first + 1}
                            active={active}
                            selectedRows={selected}
                            sort={view.sort}
                            editor={
                                editing
                                    ? {
                                          row: editing.row,
                                          column: editing.column,
                                          node: (
                                              <input
                                                  autoFocus
                                                  aria-label="Cell value"
                                                  className="h-5 w-full min-w-0 rounded-xs border border-primary bg-surface px-1 text-xs outline-none"
                                                  defaultValue={editing.text}
                                                  onKeyDown={(event) => {
                                                      event.stopPropagation();
                                                      if (event.key === 'Enter')
                                                          commitEdit(
                                                              event.currentTarget.value,
                                                              editing.row,
                                                              editing.column,
                                                          );
                                                      else if (event.key === 'Escape')
                                                          setEditing(null);
                                                      else if (event.key === 'Tab') {
                                                          event.preventDefault();
                                                          if (
                                                              commitEdit(
                                                                  event.currentTarget.value,
                                                                  editing.row,
                                                                  editing.column,
                                                              )
                                                          )
                                                              setActive({
                                                                  row: editing.row,
                                                                  column: Math.min(
                                                                      columns.length - 1,
                                                                      editing.column + 1,
                                                                  ),
                                                              });
                                                      }
                                                  }}
                                                  onBlur={(event) => {
                                                      if (editing)
                                                          commitEdit(
                                                              event.currentTarget.value,
                                                              editing.row,
                                                              editing.column,
                                                          );
                                                  }}
                                              />
                                          ),
                                      }
                                    : null
                            }
                            onCellClick={(row, column, event) => {
                                setActive({ row, column });
                                setSelected((current) =>
                                    event.shiftKey && active
                                        ? new Set(
                                              Array.from(
                                                  { length: Math.abs(row - active.row) + 1 },
                                                  (_, i) => Math.min(row, active.row) + i,
                                              ),
                                          )
                                        : event.ctrlKey || event.metaKey
                                          ? new Set(
                                                current.has(row)
                                                    ? [...current].filter((r) => r !== row)
                                                    : [...current, row],
                                            )
                                          : new Set([row]),
                                );
                            }}
                            onCellDoubleClick={startEdit}
                            onRowNumberClick={(row, event) => {
                                setActive({ row, column: active?.column ?? 0 });
                                setSelected((current) =>
                                    event.ctrlKey || event.metaKey
                                        ? new Set(
                                              current.has(row)
                                                  ? [...current].filter((r) => r !== row)
                                                  : [...current, row],
                                          )
                                        : new Set([row]),
                                );
                            }}
                            onHeaderClick={(column, event) => sortBy(column, event.shiftKey)}
                            onContextMenu={(row, column, x, y) => {
                                setActive({ row, column });
                                if (!selected.has(row)) setSelected(new Set([row]));
                                setMenu({ row, column, x, y });
                            }}
                            onKeyDown={onKeyDown}
                        />
                    )}
                    {columns.length > 0 && rowCount === 0 && !loading && (
                        <Text size="sm" className="p-4 text-dimmed">
                            {view.filters.length || view.rawWhere
                                ? 'No rows match the filter.'
                                : 'This table is empty.'}
                        </Text>
                    )}
                </div>
                {inspect && (
                    <aside
                        aria-label="Row inspector"
                        className="w-72 flex-none overflow-auto border-l border-line p-2"
                    >
                        {inspectRow ? (
                            columns.map((column, index) => (
                                <div key={column.name} className="mb-2">
                                    <div className="text-[11px] text-dimmed">
                                        {column.name} · {column.type}
                                    </div>
                                    <pre className="m-0 max-h-40 overflow-auto font-mono text-xs break-words whitespace-pre-wrap">
                                        {inspectRow[index] === null
                                            ? 'NULL'
                                            : editText(inspectRow[index], column.type) ||
                                              formatCell(inspectRow[index])}
                                    </pre>
                                </div>
                            ))
                        ) : (
                            <Text size="xs" className="text-dimmed">
                                Select a row to see its values.
                            </Text>
                        )}
                    </aside>
                )}
            </div>

            <div className="box-border flex h-8 flex-none items-center gap-2 border-t border-line bg-chrome px-2 text-xs text-dimmed">
                <ActionIcon
                    size="xs"
                    variant="subtle"
                    aria-label="Previous page"
                    disabled={view.page === 0}
                    onClick={async () => (await guardUnsaved()) && setView({ page: view.page - 1 })}
                >
                    <IconChevronLeft size={14} />
                </ActionIcon>
                <span>
                    {rows.length === 0 ? 'No rows' : `Rows ${first + 1}–${first + rows.length}`}
                    {total !== null ? ` of ${total.toLocaleString('en-US')}` : ''}
                </span>
                <ActionIcon
                    size="xs"
                    variant="subtle"
                    aria-label="Next page"
                    disabled={!hasNext}
                    onClick={async () => (await guardUnsaved()) && setView({ page: view.page + 1 })}
                >
                    <IconChevronRight size={14} />
                </ActionIcon>
                {total === null && (
                    <Button size="compact-xs" variant="subtle" onClick={() => void countRows()}>
                        Count rows
                    </Button>
                )}
                <Select
                    size="xs"
                    aria-label="Rows per page"
                    data={PAGE_SIZES}
                    value={String(view.pageSize)}
                    onChange={async (value) => {
                        if (value && (await guardUnsaved()))
                            setView({ pageSize: Number(value), page: 0 });
                    }}
                    className="w-28"
                />
                <span className="ml-auto">
                    {data ? `${data.elapsedMs} ms` : ''}
                    {dirtyCount > 0
                        ? ` · ${dirtyCount} unapplied change${dirtyCount === 1 ? '' : 's'}`
                        : ''}
                </span>
            </div>

            <Menu opened={!!menu} onClose={() => setMenu(null)} position="bottom-start" width={220}>
                <Menu.Target>
                    <span
                        aria-hidden
                        className="fixed block size-0"
                        style={{ left: menu?.x ?? 0, top: menu?.y ?? 0 }}
                    />
                </Menu.Target>
                <Menu.Dropdown aria-label="Cell actions">
                    {menu && (
                        <>
                            <Menu.Item onClick={() => startEdit(menu.row, menu.column)}>
                                Edit value…
                            </Menu.Item>
                            <Menu.Item onClick={() => setSpecial(menu.row, menu.column, 'null')}>
                                Set to NULL
                            </Menu.Item>
                            <Menu.Item onClick={() => setSpecial(menu.row, menu.column, 'default')}>
                                Set to DEFAULT
                            </Menu.Item>
                            <Menu.Divider />
                            <Menu.Item onClick={() => void copy('cell')}>Copy cell</Menu.Item>
                            <Menu.Item onClick={() => void copy('row')}>Copy row</Menu.Item>
                            <Menu.Item onClick={() => void copy('insert')}>
                                Copy row as INSERT
                            </Menu.Item>
                            <Menu.Divider />
                            <Menu.Item color="red" onClick={deleteSelected}>
                                Delete row
                            </Menu.Item>
                        </>
                    )}
                </Menu.Dropdown>
            </Menu>

            {dialog && dialogMeta && (
                <ValueDialog
                    column={dialogMeta}
                    initial={(() => {
                        const staged =
                            dialog.row >= rows.length
                                ? changes.inserts[dialog.row - rows.length]?.get(dialog.column)
                                : changes.edits.get(editKey(dialog.row, dialog.column));
                        if (
                            staged &&
                            staged.value.kind !== 'null' &&
                            staged.value.kind !== 'default'
                        )
                            return staged.text;
                        return dialog.row >= rows.length
                            ? ''
                            : editText(original(dialog.row, dialog.column), dialogMeta.type);
                    })()}
                    onClose={() => setDialog(null)}
                    onSave={(text) =>
                        commitEdit(text, dialog.row, dialog.column) && (setDialog(null), true)
                    }
                    onNull={() => {
                        setSpecial(dialog.row, dialog.column, 'null');
                        setDialog(null);
                    }}
                    onDefault={() => {
                        setSpecial(dialog.row, dialog.column, 'default');
                        setDialog(null);
                    }}
                />
            )}

            {preview && (
                <AppModal
                    opened
                    onClose={() => setPreview(null)}
                    title="Statements"
                    size="lg"
                    footer={
                        <>
                            <Button size="xs" variant="subtle" onClick={() => setPreview(null)}>
                                Close
                            </Button>
                            <Button
                                size="xs"
                                loading={applying}
                                disabled={preview.statements.length === 0 || dirtyCount === 0}
                                onClick={() => void apply()}
                            >
                                Write {dirtyCount} change{dirtyCount === 1 ? '' : 's'}
                            </Button>
                        </>
                    }
                >
                    {preview.problems.map((problem) => (
                        <Alert key={problem} color="yellow" className="mb-2">
                            {problem}
                        </Alert>
                    ))}
                    <pre className="m-0 max-h-96 overflow-auto rounded-sm border border-line bg-hover p-2 font-mono text-xs whitespace-pre-wrap">
                        {preview.statements.join('\n\n') || 'Nothing to write.'}
                    </pre>
                </AppModal>
            )}
        </div>
    );
}

/* ---------- Filter bar ---------- */

function FilterBar({
    columns,
    filters,
    rawWhere,
    onApply,
}: {
    columns: TableColumn[];
    filters: FilterClause[];
    rawWhere: string;
    onApply: (filters: FilterClause[], rawWhere: string) => void;
}) {
    const [draft, setDraft] = useState<FilterClause[]>(
        filters.length ? filters : [{ column: '', operator: 'eq', value: '' }],
    );
    const [where, setWhere] = useState(rawWhere);
    const update = (index: number, patch: Partial<FilterClause>) =>
        setDraft((current) => current.map((f, i) => (i === index ? { ...f, ...patch } : f)));
    return (
        <div
            className="flex flex-none flex-col gap-1 border-b border-line bg-chrome p-2"
            aria-label="Filters"
        >
            {draft.map((filter, index) => (
                <div key={index} className="flex items-center gap-1">
                    <Select
                        size="xs"
                        aria-label="Filter column"
                        placeholder="Column"
                        value={filter.column || null}
                        data={columns.map((c) => ({ value: c.name, label: c.name }))}
                        onChange={(value) => update(index, { column: value ?? '' })}
                        className="w-40"
                    />
                    <Select
                        size="xs"
                        aria-label="Filter operator"
                        value={filter.operator}
                        data={FILTER_OPERATORS.map((o) => ({ value: o.id, label: o.label }))}
                        onChange={(value) =>
                            value && update(index, { operator: value as FilterClause['operator'] })
                        }
                        className="w-48"
                    />
                    {FILTER_OPERATORS.find((o) => o.id === filter.operator)?.needsValue && (
                        <TextInput
                            size="xs"
                            aria-label="Filter value"
                            value={filter.value ?? ''}
                            onChange={(e) => update(index, { value: e.target.value })}
                            onKeyDown={(e) => e.key === 'Enter' && onApply(draft, where)}
                            className="w-56"
                        />
                    )}
                    <ActionIcon
                        size="xs"
                        variant="subtle"
                        aria-label="Remove filter"
                        onClick={() =>
                            setDraft((current) =>
                                current.length > 1
                                    ? current.filter((_, i) => i !== index)
                                    : [{ column: '', operator: 'eq', value: '' }],
                            )
                        }
                    >
                        <IconX size={13} />
                    </ActionIcon>
                </div>
            ))}
            <div className="flex items-center gap-1">
                <TextInput
                    size="xs"
                    aria-label="WHERE condition"
                    placeholder="WHERE condition, for example amount > 100 AND status = 'open'"
                    value={where}
                    onChange={(e) => setWhere(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && onApply(draft, where)}
                    className="min-w-0 flex-1"
                />
                <Button
                    size="xs"
                    variant="subtle"
                    onClick={() =>
                        setDraft((c) => [...c, { column: '', operator: 'eq', value: '' }])
                    }
                >
                    Add condition
                </Button>
                <Button size="xs" onClick={() => onApply(draft, where)}>
                    Apply filter
                </Button>
                <Button
                    size="xs"
                    variant="subtle"
                    onClick={() => {
                        setDraft([{ column: '', operator: 'eq', value: '' }]);
                        setWhere('');
                        onApply([], '');
                    }}
                >
                    Clear
                </Button>
            </div>
        </div>
    );
}

/* ---------- Value dialog (JSON, binary and long text) ---------- */

function ValueDialog({
    column,
    initial,
    onClose,
    onSave,
    onNull,
    onDefault,
}: {
    column: TableColumn;
    initial: string;
    onClose: () => void;
    onSave: (text: string) => boolean | void;
    onNull: () => void;
    onDefault: () => void;
}) {
    const [text, setText] = useState(initial);
    const category = categoryOfType(column.type);
    const check =
        category === 'text' || category === 'temporal'
            ? { ok: true as const }
            : parseCellInput(column.type, text);
    return (
        <AppModal
            opened
            onClose={onClose}
            title={`Edit ${column.name}`}
            size="lg"
            footerStart={
                <>
                    <Button size="xs" variant="light" onClick={onNull}>
                        Set NULL
                    </Button>
                    <Button size="xs" variant="light" onClick={onDefault}>
                        Set DEFAULT
                    </Button>
                </>
            }
            footer={
                <>
                    <Button size="xs" variant="subtle" onClick={onClose}>
                        Cancel
                    </Button>
                    <Button size="xs" disabled={!check.ok} onClick={() => onSave(text)}>
                        Stage change
                    </Button>
                </>
            }
        >
            <Text size="xs" className="mb-1 text-dimmed">
                {column.type}
                {category === 'binary'
                    ? ' · hexadecimal digits, two per byte'
                    : category === 'json'
                      ? ' · must be valid JSON'
                      : ''}
            </Text>
            <Textarea
                aria-label={`Value of ${column.name}`}
                minRows={12}
                maxRows={24}
                autosize
                className="font-mono"
                value={text}
                onChange={(e) => setText(e.target.value)}
                error={check.ok ? undefined : check.error}
            />
        </AppModal>
    );
}
