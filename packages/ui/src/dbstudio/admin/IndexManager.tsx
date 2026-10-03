/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { IconPlus, IconRefresh, IconTrash } from '@tabler/icons-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
    createIndexSql,
    createIndexStatement,
    dialectOf,
    dropIndexSql,
    dropIndexStatement,
    type IndexDesign,
    type ObjectName,
} from '@httpreq/db-admin';
import type { DbColumnInfo, DbIndexInfo } from '@httpreq/shared';
import { AppModal } from '../../AppModal';
import {
    ActionIcon,
    Alert,
    Button,
    Checkbox,
    Menu,
    Select,
    Text,
    TextInput,
    Tooltip,
} from '../../kit';
import { useProfiles } from '../db/profiles';
import { useDbManager } from '../db/useDbManager';
import { useAdmin } from './adminStore';
import { RunStatementsDialog } from './RunStatementsDialog';

/**
 * Indexes of one table or collection: list, create and drop. The relational form builds
 * `CREATE INDEX` per dialect (composite columns, sort direction, unique, method, PostgreSQL partial
 * indexes); the MongoDB form builds `createIndex` from a key pattern and options (unique, sparse,
 * TTL, partial filter). Every change is previewed before it runs.
 */
export function IndexManager({ id }: { id: string }) {
    const manager = useDbManager();
    const tab = useAdmin((state) => state.tabs[id]);
    const profile = useProfiles((state) => state.profiles.find((p) => p.id === tab?.profileId));
    const engine = profile?.settings.engine ?? 'mysql';
    const isMongo = engine === 'mongodb';
    const profileId = tab?.profileId ?? '';
    const { listMeta } = manager;

    const [indexes, setIndexes] = useState<DbIndexInfo[] | null>(null);
    const [columns, setColumns] = useState<string[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [creating, setCreating] = useState(false);
    const [pending, setPending] = useState<{
        title: string;
        statements: string[];
        danger?: boolean;
        description?: string;
    } | null>(null);

    const scope = useMemo(
        () => ({
            ...(tab?.database ? { database: tab.database } : {}),
            ...(tab?.schema ? { schema: tab.schema } : {}),
            name: tab?.name ?? '',
        }),
        [tab?.database, tab?.schema, tab?.name],
    );
    const table: ObjectName = useMemo(
        () => ({
            database: engine === 'mysql' ? tab?.database : undefined,
            schema: engine === 'postgresql' ? tab?.schema : undefined,
            name: tab?.name ?? '',
        }),
        [engine, tab?.database, tab?.schema, tab?.name],
    );

    const load = useCallback(async () => {
        if (!profileId || !tab?.name) return;
        setError(null);
        try {
            setIndexes((await listMeta(profileId, 'indexes', scope)) as DbIndexInfo[]);
            if (!isMongo)
                setColumns(
                    ((await listMeta(profileId, 'columns', scope)) as DbColumnInfo[]).map(
                        (c) => c.name,
                    ),
                );
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        }
    }, [profileId, tab?.name, scope, listMeta, isMongo]);

    useEffect(() => {
        void load();
    }, [load]);

    const drop = (index: DbIndexInfo) => {
        const statement = isMongo
            ? dropIndexStatement(tab?.database, tab?.name ?? '', index.name)
            : dropIndexSql(dialectOf(engine), table, index.name);
        setPending({
            title: `Drop index ${index.name}?`,
            statements: [statement],
            danger: true,
            description: index.primary
                ? 'This is the primary key. Dropping it changes the table’s structure.'
                : 'Queries that used this index may become slower.',
        });
    };

    if (!tab) return null;
    return (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="index-manager">
            <div className="box-border flex h-9 flex-none items-center gap-1 border-b border-line bg-chrome px-2">
                <Text size="sm" className="font-medium">
                    Indexes of {tab.name}
                </Text>
                <span className="ml-auto" />
                <Tooltip label="Reload">
                    <ActionIcon
                        size="sm"
                        variant="subtle"
                        aria-label="Reload"
                        onClick={() => void load()}
                    >
                        <IconRefresh size={15} />
                    </ActionIcon>
                </Tooltip>
                <Button
                    size="xs"
                    leftSection={<IconPlus size={14} />}
                    onClick={() => setCreating(true)}
                >
                    New index
                </Button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-3">
                {error && <Alert color="red">{error}</Alert>}
                {indexes && indexes.length === 0 && (
                    <Text size="sm" className="text-dimmed">
                        No indexes.
                    </Text>
                )}
                {indexes && indexes.length > 0 && (
                    <table className="w-full border-collapse text-xs" aria-label="Indexes">
                        <thead>
                            <tr className="text-left text-dimmed">
                                <th className="px-2 py-1 font-medium">Name</th>
                                <th className="px-2 py-1 font-medium">
                                    {isMongo ? 'Keys' : 'Columns'}
                                </th>
                                <th className="px-2 py-1 font-medium">Kind</th>
                                <th className="px-2 py-1 font-medium">Method</th>
                                <th />
                            </tr>
                        </thead>
                        <tbody>
                            {indexes.map((index) => (
                                <tr key={index.name} className="border-t border-line/60">
                                    <td className="px-2 py-1 font-medium">{index.name}</td>
                                    <td className="px-2 py-1 font-mono">
                                        {index.columns.join(', ')}
                                    </td>
                                    <td className="px-2 py-1">
                                        {index.primary
                                            ? 'Primary key'
                                            : index.unique
                                              ? 'Unique'
                                              : 'Index'}
                                    </td>
                                    <td className="px-2 py-1">{index.method ?? ''}</td>
                                    <td className="px-2 py-1 text-right">
                                        {(!isMongo || index.name !== '_id_') && (
                                            <Tooltip label="Drop this index">
                                                <ActionIcon
                                                    size="sm"
                                                    variant="subtle"
                                                    color="red"
                                                    aria-label={`Drop index ${index.name}`}
                                                    onClick={() => drop(index)}
                                                >
                                                    <IconTrash size={14} />
                                                </ActionIcon>
                                            </Tooltip>
                                        )}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </div>

            {creating &&
                (isMongo ? (
                    <MongoIndexForm
                        onClose={() => setCreating(false)}
                        onPreview={(keys, options) => {
                            setCreating(false);
                            setPending({
                                title: 'Create index',
                                statements: [
                                    createIndexStatement(tab.database, tab.name ?? '', {
                                        keys,
                                        ...options,
                                    }),
                                ],
                            });
                        }}
                    />
                ) : (
                    <RelationalIndexForm
                        engine={engine}
                        columns={columns}
                        table={table}
                        onClose={() => setCreating(false)}
                        onPreview={(design) => {
                            setCreating(false);
                            setPending({
                                title: 'Create index',
                                statements: [
                                    `${createIndexSql(dialectOf(engine), table, design)};`,
                                ],
                                description:
                                    engine === 'postgresql'
                                        ? 'On a large table this blocks writes while it builds. Use CREATE INDEX CONCURRENTLY from a query tab to avoid that.'
                                        : undefined,
                            });
                        }}
                    />
                ))}
            {pending && (
                <RunStatementsDialog
                    title={pending.title}
                    description={pending.description}
                    statements={pending.statements}
                    profileId={profileId}
                    danger={pending.danger}
                    confirmLabel={pending.danger ? 'Drop index' : 'Create index'}
                    onClose={() => setPending(null)}
                    onDone={() => {
                        setPending(null);
                        void load();
                        manager.refresh(profileId);
                    }}
                />
            )}
        </div>
    );
}

function RelationalIndexForm({
    engine,
    columns,
    table,
    onClose,
    onPreview,
}: {
    engine: string;
    columns: string[];
    table: ObjectName;
    onClose: () => void;
    onPreview: (design: IndexDesign) => void;
}) {
    const [name, setName] = useState(`idx_${table.name}_`);
    const [picked, setPicked] = useState<{ name: string; order: 'ASC' | 'DESC' }[]>([]);
    const [unique, setUnique] = useState(false);
    const [method, setMethod] = useState('');
    const [where, setWhere] = useState('');
    const methods =
        engine === 'postgresql'
            ? ['', 'btree', 'hash', 'gin', 'gist', 'brin']
            : ['', 'BTREE', 'HASH'];
    const valid = name.trim() !== '' && picked.length > 0;
    return (
        <AppModal
            opened
            onClose={onClose}
            title="New index"
            footer={
                <>
                    <Button size="xs" variant="subtle" onClick={onClose}>
                        Cancel
                    </Button>
                    <Button
                        size="xs"
                        disabled={!valid}
                        onClick={() =>
                            onPreview({
                                name: name.trim(),
                                columns: picked.map((c) => ({
                                    name: c.name,
                                    ...(c.order === 'DESC' ? { order: 'DESC' as const } : {}),
                                })),
                                unique,
                                ...(method ? { method } : {}),
                                ...(engine === 'postgresql' && where.trim()
                                    ? { where: where.trim() }
                                    : {}),
                            })
                        }
                    >
                        Preview SQL
                    </Button>
                </>
            }
        >
            <div className="flex flex-col gap-3">
                <TextInput label="Name" value={name} onChange={(e) => setName(e.target.value)} />
                <div>
                    <div className="mb-1 text-sm font-medium">Columns (in order)</div>
                    <div className="flex flex-wrap items-center gap-1">
                        {picked.map((column, index) => (
                            <span
                                key={column.name}
                                className="inline-flex items-center gap-1 rounded-sm bg-hover px-1.5 py-0.5 text-xs"
                            >
                                {column.name}
                                <button
                                    type="button"
                                    aria-label={`Toggle sort of ${column.name}`}
                                    className="border-0 bg-transparent p-0 text-[10px] text-dimmed hover:text-fg"
                                    onClick={() =>
                                        setPicked((p) =>
                                            p.map((c, i) =>
                                                i === index
                                                    ? {
                                                          ...c,
                                                          order: c.order === 'ASC' ? 'DESC' : 'ASC',
                                                      }
                                                    : c,
                                            ),
                                        )
                                    }
                                >
                                    {column.order}
                                </button>
                                <button
                                    type="button"
                                    aria-label={`Remove ${column.name}`}
                                    className="border-0 bg-transparent p-0 text-dimmed hover:text-fg"
                                    onClick={() =>
                                        setPicked((p) => p.filter((_, i) => i !== index))
                                    }
                                >
                                    ×
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
                                {columns
                                    .filter((c) => !picked.some((p) => p.name === c))
                                    .map((c) => (
                                        <Menu.Item
                                            key={c}
                                            onClick={() =>
                                                setPicked((p) => [...p, { name: c, order: 'ASC' }])
                                            }
                                        >
                                            {c}
                                        </Menu.Item>
                                    ))}
                            </Menu.Dropdown>
                        </Menu>
                    </div>
                </div>
                <Select
                    label="Method"
                    value={method}
                    data={methods.map((m) => ({ value: m, label: m || 'Default' }))}
                    onChange={(v) => setMethod(v ?? '')}
                />
                {engine === 'postgresql' && (
                    <TextInput
                        label="Where (partial index)"
                        placeholder="deleted_at IS NULL"
                        value={where}
                        onChange={(e) => setWhere(e.target.value)}
                    />
                )}
                <Checkbox
                    label="Unique"
                    checked={unique}
                    onChange={(e) => setUnique(e.currentTarget.checked)}
                />
            </div>
        </AppModal>
    );
}

function MongoIndexForm({
    onClose,
    onPreview,
}: {
    onClose: () => void;
    onPreview: (
        keys: string,
        options: {
            name?: string;
            unique?: boolean;
            sparse?: boolean;
            expireAfterSeconds?: number;
            partialFilter?: string;
        },
    ) => void;
}) {
    const [keys, setKeys] = useState('{ field: 1 }');
    const [name, setName] = useState('');
    const [unique, setUnique] = useState(false);
    const [sparse, setSparse] = useState(false);
    const [ttl, setTtl] = useState('');
    const [partial, setPartial] = useState('');
    const ttlNumber = ttl.trim() === '' ? undefined : Number(ttl);
    const valid =
        /^\s*\{[\s\S]*\}\s*$/.test(keys) &&
        (ttlNumber === undefined || (Number.isInteger(ttlNumber) && ttlNumber >= 0));
    return (
        <AppModal
            opened
            onClose={onClose}
            title="New index"
            footer={
                <>
                    <Button size="xs" variant="subtle" onClick={onClose}>
                        Cancel
                    </Button>
                    <Button
                        size="xs"
                        disabled={!valid}
                        onClick={() =>
                            onPreview(keys, {
                                ...(name.trim() ? { name: name.trim() } : {}),
                                ...(unique ? { unique } : {}),
                                ...(sparse ? { sparse } : {}),
                                ...(ttlNumber !== undefined
                                    ? { expireAfterSeconds: ttlNumber }
                                    : {}),
                                ...(partial.trim() ? { partialFilter: partial.trim() } : {}),
                            })
                        }
                    >
                        Preview statement
                    </Button>
                </>
            }
        >
            <div className="flex flex-col gap-3">
                <TextInput
                    label="Keys"
                    description='Field directions: 1 ascending, -1 descending, "text", "2dsphere", "hashed"'
                    value={keys}
                    onChange={(e) => setKeys(e.target.value)}
                />
                <TextInput
                    label="Name"
                    placeholder="generated from the keys"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                />
                <TextInput
                    label="Expire after (seconds)"
                    description="Makes a TTL index on a date field"
                    value={ttl}
                    onChange={(e) => setTtl(e.target.value)}
                    error={valid ? undefined : 'Enter whole seconds, or leave empty.'}
                />
                <TextInput
                    label="Partial filter"
                    placeholder='{ status: "active" }'
                    value={partial}
                    onChange={(e) => setPartial(e.target.value)}
                />
                <Checkbox
                    label="Unique"
                    checked={unique}
                    onChange={(e) => setUnique(e.currentTarget.checked)}
                />
                <Checkbox
                    label="Sparse"
                    checked={sparse}
                    onChange={(e) => setSparse(e.currentTarget.checked)}
                />
            </div>
        </AppModal>
    );
}
