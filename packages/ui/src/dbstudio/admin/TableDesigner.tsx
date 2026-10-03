/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { IconPlus, IconTrash, IconX } from '@tabler/icons-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
    alterTableSql,
    createTableSql,
    designFromMetadata,
    dialectOf,
    emptyDesign,
    newColumnId,
    validateDesign,
    type ColumnDesign,
    type ForeignKeyDesign,
    type IndexDesign,
    type ReferentialAction,
    type TableDesign,
} from '@httpreq/db-admin';
import type { DbColumnInfo, DbConstraintInfo, DbIndexInfo, DbTableInfo } from '@httpreq/shared';
import { confirmAction } from '../../confirm';
import {
    ActionIcon,
    Alert,
    Autocomplete,
    Button,
    Checkbox,
    Menu,
    Select,
    Tabs,
    Text,
    TextInput,
    Tooltip,
    cx,
    notifications,
} from '../../kit';
import { useProfiles } from '../db/profiles';
import { useDbManager } from '../db/useDbManager';
import { patchAdmin, useAdmin } from './adminStore';

const ACTIONS: ReferentialAction[] = [
    'NO ACTION',
    'RESTRICT',
    'CASCADE',
    'SET NULL',
    'SET DEFAULT',
];

interface DesignerState {
    design: TableDesign;
    /** The table as the server has it; absent when creating. */
    original: TableDesign | null;
    section: string;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** A list of column names with a menu to add another from the table's own columns. */
function ColumnPicker({
    value,
    options,
    onChange,
    label,
}: {
    value: string[];
    options: string[];
    onChange: (value: string[]) => void;
    label: string;
}) {
    const remaining = options.filter((name) => !value.includes(name));
    return (
        <div className="flex min-h-7 flex-wrap items-center gap-1" aria-label={label}>
            {value.map((name) => (
                <span
                    key={name}
                    className="inline-flex items-center gap-1 rounded-sm bg-hover px-1.5 py-0.5 text-xs"
                >
                    {name}
                    <button
                        type="button"
                        aria-label={`Remove ${name}`}
                        className="grid size-3.5 place-items-center border-0 bg-transparent p-0 text-dimmed hover:text-fg"
                        onClick={() => onChange(value.filter((v) => v !== name))}
                    >
                        <IconX size={11} />
                    </button>
                </span>
            ))}
            <Menu position="bottom-start" width={200}>
                <Menu.Target>
                    <Button size="compact-xs" variant="subtle" disabled={remaining.length === 0}>
                        + Column
                    </Button>
                </Menu.Target>
                <Menu.Dropdown className="max-h-64 overflow-y-auto">
                    {remaining.map((name) => (
                        <Menu.Item key={name} onClick={() => onChange([...value, name])}>
                            {name}
                        </Menu.Item>
                    ))}
                </Menu.Dropdown>
            </Menu>
        </div>
    );
}

/**
 * The visual table designer. It edits a model of the table, shows the statements that would turn
 * the server's table into it (or create it) before anything runs, validates the model, and applies
 * the statements one at a time, reporting the one that failed. Dropping a column or the table is
 * confirmed; nothing is written until Apply.
 */
export function TableDesigner({ id }: { id: string }) {
    const manager = useDbManager();
    const tab = useAdmin((state) => state.tabs[id]);
    const profile = useProfiles((state) => state.profiles.find((p) => p.id === tab?.profileId));
    const engine = profile?.settings.engine ?? 'mysql';
    const dialect = useMemo(() => dialectOf(engine), [engine]);
    const creating = !tab?.name;

    const saved = tab?.state.designer as DesignerState | undefined;
    const [state, setState] = useState<DesignerState | null>(saved ?? null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [tables, setTables] = useState<string[]>([]);
    const [refColumns, setRefColumns] = useState<Record<string, string[]>>({});
    const [applying, setApplying] = useState(false);
    const [failure, setFailure] = useState<string | null>(null);
    const profileId = tab?.profileId ?? '';
    const { listMeta, ops } = manager;

    const commit = useCallback(
        (next: DesignerState) => {
            setState(next);
            patchAdmin(id, (t) => ({
                state: { ...t.state, designer: next },
                dirty: next.original === null ? true : !same(next.design, next.original),
            }));
        },
        [id],
    );

    const load = useCallback(async () => {
        if (!tab) return;
        setLoadError(null);
        try {
            if (creating) {
                const design = {
                    ...emptyDesign(''),
                    database: engine === 'mysql' ? tab.database : undefined,
                    schema: engine === 'postgresql' ? tab.schema : undefined,
                };
                design.columns = [
                    {
                        id: newColumnId(),
                        name: 'id',
                        type: engine === 'mysql' ? 'int' : 'integer',
                        nullable: false,
                        autoIncrement: true,
                    },
                ];
                design.primaryKey = ['id'];
                commit({ design, original: null, section: 'columns' });
                return;
            }
            const scope = {
                ...(tab.database ? { database: tab.database } : {}),
                ...(tab.schema ? { schema: tab.schema } : {}),
                name: tab.name!,
            };
            const [columns, indexes, constraints, listed] = await Promise.all([
                listMeta(profileId, 'columns', scope) as Promise<DbColumnInfo[]>,
                listMeta(profileId, 'indexes', scope) as Promise<DbIndexInfo[]>,
                listMeta(profileId, 'constraints', scope).catch(() => []) as Promise<
                    DbConstraintInfo[]
                >,
                // The table's comment is only in the table listing.
                (
                    listMeta(profileId, 'tables', {
                        ...(tab.database ? { database: tab.database } : {}),
                        ...(tab.schema ? { schema: tab.schema } : {}),
                    }) as Promise<DbTableInfo[]>
                )
                    .then((items) => items.find((t) => t.name === tab.name))
                    .catch(() => undefined),
            ]);
            const design = designFromMetadata({
                dialect: dialect.id,
                name: tab.name!,
                database: engine === 'mysql' ? tab.database : undefined,
                schema: engine === 'postgresql' ? tab.schema : undefined,
                columns,
                indexes,
                constraints,
                comment: listed?.comment,
            });
            commit({
                design,
                original: structuredClone(design),
                section: state?.section ?? 'columns',
            });
        } catch (error) {
            setLoadError(error instanceof Error ? error.message : String(error));
        }
        // Loads once per tab; `state` is only read for the selected section.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tab?.id, creating, engine, profileId, listMeta]);

    useEffect(() => {
        if (!state) void load();
    }, [state, load]);

    // The tables a foreign key can point at.
    useEffect(() => {
        if (!profileId || !tab) return;
        void (
            listMeta(profileId, 'tables', {
                ...(tab.database ? { database: tab.database } : {}),
                ...(tab.schema ? { schema: tab.schema } : {}),
            }) as Promise<DbTableInfo[]>
        )
            .then((items) => setTables(items.filter((t) => t.kind === 'table').map((t) => t.name)))
            .catch(() => setTables([]));
    }, [profileId, tab?.database, tab?.schema, listMeta, tab]);

    const needed = useMemo(
        () => [...new Set(state?.design.foreignKeys.map((k) => k.refTable).filter(Boolean))],
        [state?.design.foreignKeys],
    );
    useEffect(() => {
        if (!tab) return;
        for (const name of needed) {
            if (refColumns[name]) continue;
            void (
                listMeta(profileId, 'columns', {
                    ...(tab.database ? { database: tab.database } : {}),
                    ...(tab.schema ? { schema: tab.schema } : {}),
                    name,
                }) as Promise<DbColumnInfo[]>
            )
                .then((cols) => setRefColumns((c) => ({ ...c, [name]: cols.map((x) => x.name) })))
                .catch(() => setRefColumns((c) => ({ ...c, [name]: [] })));
        }
    }, [needed, refColumns, profileId, listMeta, tab]);

    const design = state?.design;
    const original = state?.original ?? null;
    const edit = (change: (d: TableDesign) => TableDesign) =>
        state && commit({ ...state, design: change(structuredClone(state.design)) });

    const problems = useMemo(
        () => (design ? validateDesign(dialect, design) : []),
        [dialect, design],
    );
    const statements = useMemo(() => {
        if (!design || problems.length > 0) return [];
        return original
            ? alterTableSql(dialect, original, design)
            : createTableSql(dialect, design);
    }, [dialect, design, original, problems]);

    const destructive = useMemo(
        () =>
            statements.filter((s) =>
                /\bDROP\s+(COLUMN|TABLE|PRIMARY KEY|INDEX|FOREIGN KEY|CONSTRAINT|CHECK)\b/i.test(s),
            ),
        [statements],
    );

    const apply = async () => {
        if (!ops || !design || statements.length === 0) return;
        if (destructive.length > 0) {
            const answer = await confirmAction({
                title: 'Apply destructive changes?',
                message: `This removes ${destructive.length} column${destructive.length === 1 ? '' : 's'}, key${destructive.length === 1 ? '' : 's'} or index${destructive.length === 1 ? '' : 'es'}. Data in dropped columns is deleted and cannot be recovered.`,
                confirmLabel: 'Apply changes',
                danger: true,
            });
            if (answer !== 'confirm') return;
        }
        setApplying(true);
        setFailure(null);
        try {
            const outcomes = await ops.execute(profileId, statements);
            const failed = outcomes.find((o) => !o.ok);
            if (failed) {
                setFailure(
                    `${failed.error}\n\nThe statement that failed:\n${failed.sql}${
                        outcomes.length > 1
                            ? `\n\n${outcomes.filter((o) => o.ok).length} earlier statement(s) were already applied.`
                            : ''
                    }`,
                );
                return;
            }
            notifications.show({
                color: 'teal',
                message: creating ? 'Table created.' : 'Table changed.',
            });
            const name = design.name;
            patchAdmin(id, { name, title: name, state: {}, dirty: false });
            setState(null);
            // The explorer reloads what is open, in place, so the new structure shows.
            manager.refresh(profileId);
        } finally {
            setApplying(false);
        }
    };

    if (!tab) return null;
    if (loadError)
        return (
            <div className="p-4">
                <Alert color="red">{loadError}</Alert>
            </div>
        );
    if (!design || !state)
        return (
            <Text className="p-4 text-dimmed" size="sm">
                Reading the table…
            </Text>
        );

    const columnNames = design.columns.map((c) => c.name).filter(Boolean);
    const updateColumn = (index: number, patch: Partial<ColumnDesign>) =>
        edit((d) => {
            const column = d.columns[index]!;
            const renamedFrom = column.name;
            Object.assign(column, patch);
            // Keys follow a renamed column.
            if (patch.name !== undefined && patch.name !== renamedFrom) {
                d.primaryKey = d.primaryKey.map((n) => (n === renamedFrom ? patch.name! : n));
                for (const key of d.uniques)
                    key.columns = key.columns.map((n) => (n === renamedFrom ? patch.name! : n));
                for (const key of d.foreignKeys)
                    key.columns = key.columns.map((n) => (n === renamedFrom ? patch.name! : n));
                for (const index of d.indexes)
                    for (const c of index.columns) if (c.name === renamedFrom) c.name = patch.name!;
            }
            return d;
        });

    const methods =
        engine === 'postgresql'
            ? ['', 'btree', 'hash', 'gin', 'gist', 'brin']
            : ['', 'BTREE', 'HASH'];

    return (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="table-designer">
            <div className="box-border flex h-10 flex-none items-center gap-2 border-b border-line bg-chrome px-2">
                <TextInput
                    size="xs"
                    aria-label="Table name"
                    placeholder="table_name"
                    value={design.name}
                    onChange={(e) => edit((d) => ({ ...d, name: e.target.value }))}
                    className="w-56"
                />
                <Text size="xs" className="text-dimmed">
                    {creating
                        ? 'New table'
                        : original && same(design, original)
                          ? 'No changes'
                          : 'Unapplied changes'}
                </Text>
                <span className="ml-auto" />
                {!creating && (
                    <Button
                        size="xs"
                        variant="subtle"
                        onClick={() => setState(null)}
                        disabled={applying}
                    >
                        Reload from server
                    </Button>
                )}
                <Button
                    size="xs"
                    loading={applying}
                    disabled={statements.length === 0}
                    onClick={() => void apply()}
                >
                    {creating ? 'Create table' : 'Apply changes'}
                </Button>
            </div>

            <Tabs
                value={state.section}
                onChange={(v) => v && commit({ ...state, section: v })}
                className="min-h-0 flex-1"
            >
                <Tabs.List className="flex-none border-b border-line bg-chrome px-2">
                    <Tabs.Tab value="columns">Columns ({design.columns.length})</Tabs.Tab>
                    <Tabs.Tab value="keys">Keys and constraints</Tabs.Tab>
                    <Tabs.Tab value="indexes">Indexes ({design.indexes.length})</Tabs.Tab>
                    <Tabs.Tab value="sql">SQL preview</Tabs.Tab>
                </Tabs.List>

                <div className="min-h-0 flex-1 overflow-auto p-3">
                    {problems.length > 0 && (
                        <Alert color="yellow" className="mb-3">
                            {problems.map((problem) => (
                                <div key={problem}>{problem}</div>
                            ))}
                        </Alert>
                    )}
                    {failure && (
                        <Alert color="red" className="mb-3" title="The change was not applied">
                            <pre className="m-0 font-mono text-xs whitespace-pre-wrap">
                                {failure}
                            </pre>
                        </Alert>
                    )}

                    {state.section === 'columns' && (
                        <div>
                            <table className="w-full border-collapse text-xs" aria-label="Columns">
                                <thead>
                                    <tr className="text-left text-dimmed">
                                        <th className="px-1 py-1 font-medium">Name</th>
                                        <th className="px-1 py-1 font-medium">Type</th>
                                        <th className="px-1 py-1 font-medium">Length</th>
                                        {dialect.id === 'mysql' && (
                                            <th className="px-1 py-1 font-medium">Unsigned</th>
                                        )}
                                        <th className="px-1 py-1 font-medium">Null</th>
                                        <th className="px-1 py-1 font-medium">Key</th>
                                        <th className="px-1 py-1 font-medium">
                                            {dialect.id === 'mysql' ? 'Auto inc.' : 'Identity'}
                                        </th>
                                        <th className="px-1 py-1 font-medium">Default</th>
                                        <th className="px-1 py-1 font-medium">Generated as</th>
                                        <th className="px-1 py-1 font-medium">Comment</th>
                                        <th />
                                    </tr>
                                </thead>
                                <tbody>
                                    {design.columns.map((column, index) => (
                                        <tr key={column.id} className="align-top">
                                            <td className="px-1 py-0.5">
                                                <TextInput
                                                    size="xs"
                                                    aria-label={`Column ${index + 1} name`}
                                                    value={column.name}
                                                    onChange={(e) =>
                                                        updateColumn(index, {
                                                            name: e.target.value,
                                                        })
                                                    }
                                                />
                                            </td>
                                            <td className="w-44 px-1 py-0.5">
                                                <Autocomplete
                                                    size="xs"
                                                    aria-label={`Column ${index + 1} type`}
                                                    data={[...dialect.dataTypes]}
                                                    value={column.type}
                                                    onChange={(value) =>
                                                        updateColumn(index, { type: value })
                                                    }
                                                />
                                            </td>
                                            <td className="w-20 px-1 py-0.5">
                                                <TextInput
                                                    size="xs"
                                                    aria-label={`Column ${index + 1} length`}
                                                    disabled={
                                                        !dialect.lengthTypes.has(
                                                            column.type.toLowerCase(),
                                                        )
                                                    }
                                                    value={column.length ?? ''}
                                                    onChange={(e) =>
                                                        updateColumn(index, {
                                                            length: e.target.value,
                                                        })
                                                    }
                                                />
                                            </td>
                                            {dialect.id === 'mysql' && (
                                                <td className="px-1 py-0.5 text-center">
                                                    <Checkbox
                                                        aria-label={`Column ${index + 1} unsigned`}
                                                        checked={!!column.unsigned}
                                                        onChange={(e) =>
                                                            updateColumn(index, {
                                                                unsigned: e.currentTarget.checked,
                                                            })
                                                        }
                                                    />
                                                </td>
                                            )}
                                            <td className="px-1 py-0.5 text-center">
                                                <Checkbox
                                                    aria-label={`Column ${index + 1} nullable`}
                                                    checked={column.nullable}
                                                    disabled={design.primaryKey.includes(
                                                        column.name,
                                                    )}
                                                    onChange={(e) =>
                                                        updateColumn(index, {
                                                            nullable: e.currentTarget.checked,
                                                        })
                                                    }
                                                />
                                            </td>
                                            <td className="px-1 py-0.5 text-center">
                                                <Checkbox
                                                    aria-label={`Column ${index + 1} primary key`}
                                                    checked={design.primaryKey.includes(
                                                        column.name,
                                                    )}
                                                    onChange={(e) =>
                                                        edit((d) => {
                                                            d.primaryKey = e.currentTarget.checked
                                                                ? [...d.primaryKey, column.name]
                                                                : d.primaryKey.filter(
                                                                      (n) => n !== column.name,
                                                                  );
                                                            if (e.currentTarget.checked)
                                                                d.columns[index]!.nullable = false;
                                                            return d;
                                                        })
                                                    }
                                                />
                                            </td>
                                            <td className="px-1 py-0.5 text-center">
                                                <Checkbox
                                                    aria-label={`Column ${index + 1} auto increment`}
                                                    checked={!!column.autoIncrement}
                                                    disabled={!!column.generated}
                                                    onChange={(e) =>
                                                        updateColumn(index, {
                                                            autoIncrement: e.currentTarget.checked,
                                                        })
                                                    }
                                                />
                                            </td>
                                            <td className="px-1 py-0.5">
                                                <TextInput
                                                    size="xs"
                                                    aria-label={`Column ${index + 1} default`}
                                                    placeholder="expression"
                                                    disabled={
                                                        !!column.autoIncrement || !!column.generated
                                                    }
                                                    value={column.default ?? ''}
                                                    onChange={(e) =>
                                                        updateColumn(index, {
                                                            default: e.target.value,
                                                        })
                                                    }
                                                />
                                            </td>
                                            <td className="px-1 py-0.5">
                                                <TextInput
                                                    size="xs"
                                                    aria-label={`Column ${index + 1} generated expression`}
                                                    placeholder="expression"
                                                    value={column.generated?.expression ?? ''}
                                                    onChange={(e) =>
                                                        updateColumn(index, {
                                                            generated: e.target.value
                                                                ? {
                                                                      expression: e.target.value,
                                                                      stored:
                                                                          column.generated
                                                                              ?.stored ?? true,
                                                                  }
                                                                : undefined,
                                                        })
                                                    }
                                                />
                                            </td>
                                            <td className="px-1 py-0.5">
                                                <TextInput
                                                    size="xs"
                                                    aria-label={`Column ${index + 1} comment`}
                                                    value={column.comment ?? ''}
                                                    onChange={(e) =>
                                                        updateColumn(index, {
                                                            comment: e.target.value,
                                                        })
                                                    }
                                                />
                                            </td>
                                            <td className="px-1 py-0.5">
                                                <Tooltip label="Remove this column">
                                                    <ActionIcon
                                                        size="sm"
                                                        variant="subtle"
                                                        color="red"
                                                        aria-label={`Remove column ${column.name || index + 1}`}
                                                        onClick={() =>
                                                            edit((d) => {
                                                                const [gone] = d.columns.splice(
                                                                    index,
                                                                    1,
                                                                );
                                                                d.primaryKey = d.primaryKey.filter(
                                                                    (n) => n !== gone!.name,
                                                                );
                                                                return d;
                                                            })
                                                        }
                                                    >
                                                        <IconTrash size={14} />
                                                    </ActionIcon>
                                                </Tooltip>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                            <Button
                                size="xs"
                                variant="light"
                                className="mt-2"
                                leftSection={<IconPlus size={14} />}
                                onClick={() =>
                                    edit((d) => {
                                        d.columns.push({
                                            id: newColumnId(),
                                            name: '',
                                            type: dialect.id === 'mysql' ? 'varchar' : 'text',
                                            length: dialect.id === 'mysql' ? '255' : undefined,
                                            nullable: true,
                                        });
                                        return d;
                                    })
                                }
                            >
                                Add column
                            </Button>
                        </div>
                    )}

                    {state.section === 'keys' && (
                        <div className="flex flex-col gap-5">
                            <section>
                                <h3 className="mt-0 mb-1 text-sm font-semibold">Primary key</h3>
                                <ColumnPicker
                                    label="Primary key columns"
                                    value={design.primaryKey}
                                    options={columnNames}
                                    onChange={(value) => edit((d) => ({ ...d, primaryKey: value }))}
                                />
                            </section>

                            <section>
                                <h3 className="mt-0 mb-1 text-sm font-semibold">Foreign keys</h3>
                                {design.foreignKeys.map((key, index) => (
                                    <div
                                        key={index}
                                        className="mb-2 flex flex-wrap items-start gap-2 rounded-sm border border-line p-2"
                                        aria-label={`Foreign key ${index + 1}`}
                                    >
                                        <TextInput
                                            size="xs"
                                            label="Name"
                                            placeholder="automatic"
                                            value={key.name ?? ''}
                                            onChange={(e) =>
                                                edit(
                                                    (d) => (
                                                        ((
                                                            d.foreignKeys[index] as ForeignKeyDesign
                                                        ).name = e.target.value || undefined),
                                                        d
                                                    ),
                                                )
                                            }
                                            className="w-44"
                                        />
                                        <div>
                                            <div className="mb-1 text-xs font-medium">Columns</div>
                                            <ColumnPicker
                                                label="Foreign key columns"
                                                value={key.columns}
                                                options={columnNames}
                                                onChange={(value) =>
                                                    edit(
                                                        (d) => (
                                                            ((
                                                                d.foreignKeys[
                                                                    index
                                                                ] as ForeignKeyDesign
                                                            ).columns = value),
                                                            d
                                                        ),
                                                    )
                                                }
                                            />
                                        </div>
                                        <Select
                                            size="xs"
                                            label="References"
                                            placeholder="Table"
                                            value={key.refTable || null}
                                            data={tables.map((t) => ({ value: t, label: t }))}
                                            onChange={(value) =>
                                                edit(
                                                    (d) => (
                                                        ((
                                                            d.foreignKeys[index] as ForeignKeyDesign
                                                        ).refTable = value ?? ''),
                                                        ((
                                                            d.foreignKeys[index] as ForeignKeyDesign
                                                        ).refColumns = []),
                                                        d
                                                    ),
                                                )
                                            }
                                            className="w-44"
                                        />
                                        <div>
                                            <div className="mb-1 text-xs font-medium">
                                                Referenced columns
                                            </div>
                                            <ColumnPicker
                                                label="Referenced columns"
                                                value={key.refColumns}
                                                options={refColumns[key.refTable] ?? []}
                                                onChange={(value) =>
                                                    edit(
                                                        (d) => (
                                                            ((
                                                                d.foreignKeys[
                                                                    index
                                                                ] as ForeignKeyDesign
                                                            ).refColumns = value),
                                                            d
                                                        ),
                                                    )
                                                }
                                            />
                                        </div>
                                        <Select
                                            size="xs"
                                            label="On delete"
                                            value={key.onDelete ?? 'NO ACTION'}
                                            data={ACTIONS.map((a) => ({ value: a, label: a }))}
                                            onChange={(value) =>
                                                edit(
                                                    (d) => (
                                                        ((
                                                            d.foreignKeys[index] as ForeignKeyDesign
                                                        ).onDelete = (value ??
                                                            'NO ACTION') as ReferentialAction),
                                                        d
                                                    ),
                                                )
                                            }
                                            className="w-36"
                                        />
                                        <Select
                                            size="xs"
                                            label="On update"
                                            value={key.onUpdate ?? 'NO ACTION'}
                                            data={ACTIONS.map((a) => ({ value: a, label: a }))}
                                            onChange={(value) =>
                                                edit(
                                                    (d) => (
                                                        ((
                                                            d.foreignKeys[index] as ForeignKeyDesign
                                                        ).onUpdate = (value ??
                                                            'NO ACTION') as ReferentialAction),
                                                        d
                                                    ),
                                                )
                                            }
                                            className="w-36"
                                        />
                                        <ActionIcon
                                            size="sm"
                                            variant="subtle"
                                            color="red"
                                            aria-label="Remove foreign key"
                                            className="mt-5"
                                            onClick={() =>
                                                edit((d) => (d.foreignKeys.splice(index, 1), d))
                                            }
                                        >
                                            <IconTrash size={14} />
                                        </ActionIcon>
                                    </div>
                                ))}
                                <Button
                                    size="xs"
                                    variant="light"
                                    leftSection={<IconPlus size={14} />}
                                    onClick={() =>
                                        edit(
                                            (d) => (
                                                d.foreignKeys.push({
                                                    columns: [],
                                                    refTable: '',
                                                    refColumns: [],
                                                }),
                                                d
                                            ),
                                        )
                                    }
                                >
                                    Add foreign key
                                </Button>
                            </section>

                            <section>
                                <h3 className="mt-0 mb-1 text-sm font-semibold">
                                    Unique constraints
                                </h3>
                                {design.uniques.map((key, index) => (
                                    <div
                                        key={index}
                                        className="mb-2 flex items-start gap-2"
                                        aria-label={`Unique constraint ${index + 1}`}
                                    >
                                        <TextInput
                                            size="xs"
                                            aria-label="Unique constraint name"
                                            placeholder="automatic"
                                            value={key.name ?? ''}
                                            onChange={(e) =>
                                                edit(
                                                    (d) => (
                                                        (d.uniques[index]!.name =
                                                            e.target.value || undefined),
                                                        d
                                                    ),
                                                )
                                            }
                                            className="w-44"
                                        />
                                        <ColumnPicker
                                            label="Unique columns"
                                            value={key.columns}
                                            options={columnNames}
                                            onChange={(value) =>
                                                edit(
                                                    (d) => ((d.uniques[index]!.columns = value), d),
                                                )
                                            }
                                        />
                                        <ActionIcon
                                            size="sm"
                                            variant="subtle"
                                            color="red"
                                            aria-label="Remove unique constraint"
                                            onClick={() =>
                                                edit((d) => (d.uniques.splice(index, 1), d))
                                            }
                                        >
                                            <IconTrash size={14} />
                                        </ActionIcon>
                                    </div>
                                ))}
                                <Button
                                    size="xs"
                                    variant="light"
                                    leftSection={<IconPlus size={14} />}
                                    onClick={() =>
                                        edit((d) => (d.uniques.push({ columns: [] }), d))
                                    }
                                >
                                    Add unique constraint
                                </Button>
                            </section>

                            <section>
                                <h3 className="mt-0 mb-1 text-sm font-semibold">
                                    Check constraints
                                </h3>
                                {design.checks.map((check, index) => (
                                    <div
                                        key={index}
                                        className="mb-2 flex items-start gap-2"
                                        aria-label={`Check constraint ${index + 1}`}
                                    >
                                        <TextInput
                                            size="xs"
                                            aria-label="Check constraint name"
                                            placeholder="automatic"
                                            value={check.name ?? ''}
                                            onChange={(e) =>
                                                edit(
                                                    (d) => (
                                                        (d.checks[index]!.name =
                                                            e.target.value || undefined),
                                                        d
                                                    ),
                                                )
                                            }
                                            className="w-44"
                                        />
                                        <TextInput
                                            size="xs"
                                            aria-label="Check expression"
                                            placeholder="price >= 0"
                                            value={check.expression}
                                            onChange={(e) =>
                                                edit(
                                                    (d) => (
                                                        (d.checks[index]!.expression =
                                                            e.target.value),
                                                        d
                                                    ),
                                                )
                                            }
                                            className="min-w-0 flex-1"
                                        />
                                        <ActionIcon
                                            size="sm"
                                            variant="subtle"
                                            color="red"
                                            aria-label="Remove check constraint"
                                            onClick={() =>
                                                edit((d) => (d.checks.splice(index, 1), d))
                                            }
                                        >
                                            <IconTrash size={14} />
                                        </ActionIcon>
                                    </div>
                                ))}
                                <Button
                                    size="xs"
                                    variant="light"
                                    leftSection={<IconPlus size={14} />}
                                    onClick={() =>
                                        edit((d) => (d.checks.push({ expression: '' }), d))
                                    }
                                >
                                    Add check constraint
                                </Button>
                            </section>
                        </div>
                    )}

                    {state.section === 'indexes' && (
                        <div>
                            {design.indexes.map((index, position) => (
                                <div
                                    key={position}
                                    className="mb-2 flex flex-wrap items-start gap-2 rounded-sm border border-line p-2"
                                    aria-label={`Index ${position + 1}`}
                                >
                                    <TextInput
                                        size="xs"
                                        label="Name"
                                        value={index.name}
                                        onChange={(e) =>
                                            edit(
                                                (d) => (
                                                    (d.indexes[position]!.name = e.target.value),
                                                    d
                                                ),
                                            )
                                        }
                                        className="w-48"
                                    />
                                    <div>
                                        <div className="mb-1 text-xs font-medium">Columns</div>
                                        <div className="flex flex-wrap items-center gap-1">
                                            {index.columns.map((column, c) => (
                                                <span
                                                    key={column.name}
                                                    className="inline-flex items-center gap-1 rounded-sm bg-hover px-1.5 py-0.5 text-xs"
                                                >
                                                    {column.name}
                                                    <button
                                                        type="button"
                                                        aria-label={`Sort ${column.name} ${column.order === 'DESC' ? 'ascending' : 'descending'}`}
                                                        className={cx(
                                                            'border-0 bg-transparent p-0 text-[10px] text-dimmed hover:text-fg',
                                                        )}
                                                        onClick={() =>
                                                            edit(
                                                                (d) => (
                                                                    (d.indexes[position]!.columns[
                                                                        c
                                                                    ]!.order =
                                                                        column.order === 'DESC'
                                                                            ? 'ASC'
                                                                            : 'DESC'),
                                                                    d
                                                                ),
                                                            )
                                                        }
                                                    >
                                                        {column.order === 'DESC' ? 'DESC' : 'ASC'}
                                                    </button>
                                                    <button
                                                        type="button"
                                                        aria-label={`Remove ${column.name}`}
                                                        className="grid size-3.5 place-items-center border-0 bg-transparent p-0 text-dimmed hover:text-fg"
                                                        onClick={() =>
                                                            edit(
                                                                (d) => (
                                                                    d.indexes[
                                                                        position
                                                                    ]!.columns.splice(c, 1),
                                                                    d
                                                                ),
                                                            )
                                                        }
                                                    >
                                                        <IconX size={11} />
                                                    </button>
                                                </span>
                                            ))}
                                            <Menu position="bottom-start" width={200}>
                                                <Menu.Target>
                                                    <Button size="compact-xs" variant="subtle">
                                                        + Column
                                                    </Button>
                                                </Menu.Target>
                                                <Menu.Dropdown className="max-h-64 overflow-y-auto">
                                                    {columnNames
                                                        .filter(
                                                            (n) =>
                                                                !index.columns.some(
                                                                    (c) => c.name === n,
                                                                ),
                                                        )
                                                        .map((name) => (
                                                            <Menu.Item
                                                                key={name}
                                                                onClick={() =>
                                                                    edit(
                                                                        (d) => (
                                                                            d.indexes[
                                                                                position
                                                                            ]!.columns.push({
                                                                                name,
                                                                            }),
                                                                            d
                                                                        ),
                                                                    )
                                                                }
                                                            >
                                                                {name}
                                                            </Menu.Item>
                                                        ))}
                                                </Menu.Dropdown>
                                            </Menu>
                                        </div>
                                    </div>
                                    <Select
                                        size="xs"
                                        label="Method"
                                        value={index.method ?? ''}
                                        data={methods.map((m) => ({
                                            value: m,
                                            label: m || 'Default',
                                        }))}
                                        onChange={(value) =>
                                            edit(
                                                (d) => (
                                                    (d.indexes[position]!.method =
                                                        value || undefined),
                                                    d
                                                ),
                                            )
                                        }
                                        className="w-28"
                                    />
                                    {dialect.id === 'postgresql' && (
                                        <TextInput
                                            size="xs"
                                            label="Where (partial index)"
                                            value={index.where ?? ''}
                                            onChange={(e) =>
                                                edit(
                                                    (d) => (
                                                        (d.indexes[position]!.where =
                                                            e.target.value || undefined),
                                                        d
                                                    ),
                                                )
                                            }
                                            className="w-56"
                                        />
                                    )}
                                    <Checkbox
                                        label="Unique"
                                        checked={index.unique}
                                        onChange={(e) =>
                                            edit(
                                                (d) => (
                                                    (d.indexes[position]!.unique =
                                                        e.currentTarget.checked),
                                                    d
                                                ),
                                            )
                                        }
                                        className="mt-5"
                                    />
                                    <ActionIcon
                                        size="sm"
                                        variant="subtle"
                                        color="red"
                                        aria-label="Remove index"
                                        className="mt-5"
                                        onClick={() =>
                                            edit((d) => (d.indexes.splice(position, 1), d))
                                        }
                                    >
                                        <IconTrash size={14} />
                                    </ActionIcon>
                                </div>
                            ))}
                            <Button
                                size="xs"
                                variant="light"
                                leftSection={<IconPlus size={14} />}
                                onClick={() =>
                                    edit((d) => {
                                        const next: IndexDesign = {
                                            name: `idx_${design.name || 'table'}_${design.indexes.length + 1}`,
                                            columns: [],
                                            unique: false,
                                        };
                                        d.indexes.push(next);
                                        return d;
                                    })
                                }
                            >
                                Add index
                            </Button>
                        </div>
                    )}

                    {state.section === 'sql' && (
                        <div>
                            <Text size="xs" className="mb-1 text-dimmed">
                                {statements.length === 0
                                    ? problems.length
                                        ? 'Fix the problems above to see the statements.'
                                        : 'No changes: the design matches the table.'
                                    : `${statements.length} statement${statements.length === 1 ? '' : 's'}, run in this order:`}
                            </Text>
                            <pre
                                aria-label="Generated SQL"
                                className="m-0 overflow-auto rounded-sm border border-line bg-hover p-2 font-mono text-xs whitespace-pre-wrap"
                            >
                                {statements.join('\n\n')}
                            </pre>
                        </div>
                    )}
                </div>
            </Tabs>
        </div>
    );
}
