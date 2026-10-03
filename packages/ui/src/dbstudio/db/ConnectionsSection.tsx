/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import {
    IconBolt,
    IconChevronDown,
    IconChevronRight,
    IconColumns,
    IconDatabase,
    IconFolder,
    IconDots,
    IconFunction,
    IconKey,
    IconPlus,
    IconServer,
    IconTable,
    IconTableOptions,
    IconClock,
} from '@tabler/icons-react';
import { useMemo, useState } from 'react';
import {
    ActionIcon,
    Menu,
    StatusDot,
    Text,
    TextInput,
    Tooltip,
    UnstyledButton,
    cx,
} from '../../kit';
import { confirmAction } from '../../confirm';
import { notifications } from '../../kit';
import { buildRows, type ExplorerRow, type RowKind } from './explorerRows';
import { openConnectionDialog } from './connectionDialogStore';
import { useProfiles } from './profiles';
import { useLive } from './queryStore';
import { quoteName, startOfQuery } from './engines';
import { useDbManager } from './useDbManager';

const ICONS: Record<RowKind, typeof IconTable> = {
    connection: IconServer,
    database: IconDatabase,
    schema: IconFolder,
    group: IconTableOptions,
    table: IconTable,
    view: IconTable,
    column: IconColumns,
    index: IconKey,
    routine: IconFunction,
    trigger: IconBolt,
    event: IconClock,
    message: IconDots,
};

const OPEN_LABEL: Record<string, string> = {
    mongodb: 'Find documents',
    redis: 'Show value',
};

/** The name that refers to an object in a statement. */
const qualifiedName = (engine: string, row: ExplorerRow): string => {
    const name = quoteName(engine, row.table ?? '');
    if (engine === 'redis' || engine === 'mongodb') return name;
    const schema = row.schema ? `${quoteName(engine, row.schema)}.` : '';
    const database = !row.schema && row.database ? `${quoteName(engine, row.database)}.` : '';
    return `${database}${schema}${name}`;
};

/** The connections tree: saved servers, and under a connected one its databases and their objects. */
export function ConnectionsSection() {
    const manager = useDbManager();
    const profiles = useProfiles((state) => state.profiles);
    const status = useLive((state) => state.status);
    const meta = useLive((state) => state.meta);
    const expanded = useLive((state) => state.expanded);
    const [filter, setFilter] = useState('');

    const rows = useMemo(
        () => buildRows(profiles, status, meta, expanded, filter),
        [profiles, status, meta, expanded, filter],
    );

    const showDefinition = async (row: ExplorerRow) => {
        try {
            const text = await manager.definition(row);
            manager.newQuery(row.profileId, text, row.object ?? row.table ?? row.label);
        } catch (error) {
            notifications.show({
                color: 'red',
                title: 'Could not read the definition',
                message: error instanceof Error ? error.message : String(error),
            });
        }
    };

    const remove = async (id: string, name: string) => {
        const answer = await confirmAction({
            title: `Delete ${name}?`,
            message:
                'The saved connection and its stored password are removed. The server itself is not touched.',
            confirmLabel: 'Delete',
            danger: true,
        });
        if (answer === 'confirm') await manager.deleteProfile(id);
    };

    return (
        <section aria-label="Connections" className="mb-4">
            <div className="mb-1 flex items-center justify-between">
                <Text size="xs" className="font-semibold tracking-wide text-dimmed uppercase">
                    Connections
                </Text>
                <Tooltip label="New connection">
                    <ActionIcon
                        size="xs"
                        variant="subtle"
                        aria-label="New connection"
                        onClick={() => openConnectionDialog('new')}
                    >
                        <IconPlus size={14} />
                    </ActionIcon>
                </Tooltip>
            </div>

            {profiles.length === 0 ? (
                <Text size="xs" className="text-dimmed">
                    Add a MySQL, PostgreSQL, MongoDB or Redis server to browse it and run queries.
                </Text>
            ) : (
                <>
                    {rows.some((r) => r.kind === 'table' || r.kind === 'group') && (
                        <TextInput
                            size="xs"
                            className="mb-1"
                            placeholder="Filter objects"
                            aria-label="Filter objects"
                            value={filter}
                            onChange={(e) => setFilter(e.target.value)}
                        />
                    )}
                    <ul role="tree" aria-label="Connections" className="m-0 list-none p-0">
                        {rows.map((row) => (
                            <TreeRow
                                key={row.key}
                                row={row}
                                onToggle={() => manager.toggle(row)}
                                onOpen={() => {
                                    if (row.kind === 'connection') {
                                        if (row.status === 'connected') manager.toggle(row);
                                        else void manager.connect(row.profileId);
                                    } else if (row.kind === 'table' || row.kind === 'view')
                                        void manager.openTable(row);
                                    else if (row.expandable) manager.toggle(row);
                                    else if (
                                        row.kind === 'routine' ||
                                        row.kind === 'trigger' ||
                                        row.kind === 'event'
                                    )
                                        void showDefinition(row);
                                }}
                                menu={
                                    <RowMenu
                                        row={row}
                                        onDefinition={() => void showDefinition(row)}
                                        onRemove={() => void remove(row.profileId, row.label)}
                                    />
                                }
                            />
                        ))}
                    </ul>
                </>
            )}
        </section>
    );
}

function TreeRow({
    row,
    onToggle,
    onOpen,
    menu,
}: {
    row: ExplorerRow;
    onToggle: () => void;
    onOpen: () => void;
    menu: React.ReactNode;
}) {
    const Icon = row.engine === 'redis' && row.kind === 'table' ? IconKey : ICONS[row.kind];
    return (
        <li role="none">
            <div
                role="treeitem"
                aria-level={row.depth + 1}
                aria-expanded={row.expandable ? row.expanded : undefined}
                className="group flex items-center rounded-sm hover:bg-hover"
                style={{ paddingLeft: row.depth * 12 }}
            >
                <UnstyledButton
                    aria-label={row.expandable ? (row.expanded ? 'Collapse' : 'Expand') : undefined}
                    tabIndex={-1}
                    className="grid size-5 flex-none place-items-center text-dimmed"
                    onClick={onToggle}
                    disabled={!row.expandable}
                >
                    {row.expandable &&
                        (row.expanded ? (
                            <IconChevronDown size={13} />
                        ) : (
                            <IconChevronRight size={13} />
                        ))}
                </UnstyledButton>
                <UnstyledButton
                    className={cx(
                        'flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left text-sm',
                        row.kind === 'message' && 'cursor-default',
                        row.problem && 'text-red-500',
                        row.loading && 'text-dimmed',
                    )}
                    onDoubleClick={onOpen}
                    onClick={() => row.kind === 'connection' && !row.expandable && onOpen()}
                    title={row.detail ? `${row.label} · ${row.detail}` : row.label}
                >
                    {row.kind === 'connection' ? (
                        <StatusDot
                            status={
                                row.status === 'failed' ? 'error' : (row.status ?? 'disconnected')
                            }
                        />
                    ) : (
                        row.kind !== 'message' && (
                            <Icon size={14} className="flex-none text-dimmed" />
                        )
                    )}
                    <span className="truncate">{row.label}</span>
                    {row.detail && row.kind !== 'message' && (
                        <span className="truncate text-[11px] text-dimmed">{row.detail}</span>
                    )}
                </UnstyledButton>
                {row.kind !== 'message' && row.kind !== 'column' && row.kind !== 'index' && (
                    <span className="flex-none opacity-0 focus-within:opacity-100 group-hover:opacity-100">
                        {menu}
                    </span>
                )}
            </div>
        </li>
    );
}

function RowMenu({
    row,
    onDefinition,
    onRemove,
}: {
    row: ExplorerRow;
    onDefinition: () => void;
    onRemove: () => void;
}) {
    const manager = useDbManager();
    const profile = useProfiles((state) => state.profiles.find((p) => p.id === row.profileId));
    const engine = profile?.settings.engine ?? 'mysql';
    return (
        <Menu position="bottom-end" width={200}>
            <Menu.Target>
                <ActionIcon
                    size="xs"
                    variant="subtle"
                    color="gray"
                    aria-label={`Actions for ${row.label}`}
                >
                    <IconDots size={13} />
                </ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
                {row.kind === 'connection' && (
                    <>
                        {row.status === 'connected' ? (
                            <>
                                <Menu.Item onClick={() => manager.newQuery(row.profileId)}>
                                    New query
                                </Menu.Item>
                                <Menu.Item onClick={() => manager.refresh(row.profileId)}>
                                    Refresh
                                </Menu.Item>
                                <Menu.Item onClick={() => void manager.disconnect(row.profileId)}>
                                    Disconnect
                                </Menu.Item>
                            </>
                        ) : (
                            <Menu.Item onClick={() => void manager.connect(row.profileId)}>
                                Connect
                            </Menu.Item>
                        )}
                        <Menu.Divider />
                        <Menu.Item onClick={() => openConnectionDialog(row.profileId)}>
                            Edit…
                        </Menu.Item>
                        <Menu.Item onClick={() => useProfiles.getState().duplicate(row.profileId)}>
                            Duplicate
                        </Menu.Item>
                        <Menu.Item color="red" onClick={onRemove}>
                            Delete…
                        </Menu.Item>
                    </>
                )}
                {row.kind === 'database' && (
                    <Menu.Item
                        onClick={() =>
                            manager.newQuery(
                                row.profileId,
                                startOfQuery(engine, row.database),
                                row.database,
                            )
                        }
                    >
                        New query
                    </Menu.Item>
                )}
                {(row.kind === 'table' || row.kind === 'view') && (
                    <>
                        <Menu.Item onClick={() => void manager.openTable(row)}>
                            {OPEN_LABEL[engine] ?? 'Select rows'}
                        </Menu.Item>
                        <Menu.Item onClick={onDefinition}>
                            {engine === 'redis' ? 'Show key info' : 'Show definition'}
                        </Menu.Item>
                        <Menu.Item
                            onClick={() =>
                                void navigator.clipboard?.writeText(qualifiedName(engine, row))
                            }
                        >
                            Copy name
                        </Menu.Item>
                    </>
                )}
                {(row.kind === 'routine' || row.kind === 'trigger' || row.kind === 'event') && (
                    <Menu.Item onClick={onDefinition}>Show definition</Menu.Item>
                )}
                {row.kind === 'group' && (
                    <Menu.Item onClick={() => manager.toggle(row)}>
                        {row.expanded ? 'Collapse' : 'Expand'}
                    </Menu.Item>
                )}
            </Menu.Dropdown>
        </Menu>
    );
}
