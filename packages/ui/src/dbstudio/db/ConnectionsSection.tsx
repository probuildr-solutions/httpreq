/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import {
    IconChevronDown,
    IconChevronRight,
    IconPlus,
    IconSearch,
    IconX,
} from '@tabler/icons-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { TREE_ROW_HEIGHT, TreeRowActions, TreeRowMenuButton } from '../TreeRowActions';
import { ActionIcon, Menu, StatusDot, Text, Tooltip, UnstyledButton, cx } from '../../kit';
import { confirmAction } from '../../confirm';
import { notifications } from '../../kit';
import { buildRows, type ExplorerRow } from './explorerRows';
import { ObjectIcon, type ObjectKind } from '../icons';
import { openConnectionDialog } from './connectionDialogStore';
import { useProfiles } from './profiles';
import { useLive } from './queryStore';
import { quoteName, startOfQuery } from './engines';
import { useExplorerActions } from './explorerActions';
import { useDbManager } from './useDbManager';

/** The icon kind of an explorer row. */
const iconKindOf = (row: ExplorerRow): ObjectKind => {
    switch (row.kind) {
        case 'connection':
            return 'server';
        case 'database':
            return 'database';
        case 'schema':
            return 'schema';
        case 'group':
            return 'folder';
        case 'table':
            return row.engine === 'mongodb' ? 'collection' : 'table';
        case 'view':
            return row.objectKind === 'materialized view' ? 'materializedView' : 'view';
        case 'column':
            return row.primaryKey ? 'primaryKey' : 'column';
        case 'index':
            return 'index';
        case 'routine':
            return row.routineKind === 'procedure' ? 'procedure' : 'function';
        case 'trigger':
            return 'trigger';
        case 'event':
            return 'event';
        default:
            return 'folder';
    }
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
    const [searching, setSearching] = useState(false);
    const searchRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (searching) searchRef.current?.focus();
    }, [searching]);

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

    // Closing the search always clears it, so the full tree comes straight back; what was expanded
    // is untouched because filtering never changes the expanded set.
    const closeSearch = () => {
        setFilter('');
        setSearching(false);
    };

    return (
        <section aria-label="Connections" className="flex min-h-0 flex-1 flex-col">
            {/* A fixed-height strip outside the scrolling tree. Searching swaps its contents in
                place, so neither the tree nor anything around it moves. */}
            <div className="box-border flex h-8 flex-none items-center gap-0.5 border-b border-line pr-1.5 pl-3">
                {searching ? (
                    <>
                        <IconSearch size={14} className="flex-none text-dimmed" aria-hidden />
                        <input
                            ref={searchRef}
                            type="text"
                            role="searchbox"
                            aria-label="Search connections"
                            placeholder="Search connections and objects"
                            value={filter}
                            onChange={(event) => setFilter(event.target.value)}
                            onKeyDown={(event) => {
                                if (event.key === 'Escape') closeSearch();
                            }}
                            className="mx-1 h-6 min-w-0 flex-1 border-0 bg-transparent p-0 text-sm text-inherit outline-none placeholder:text-dimmed"
                        />
                        {filter && (
                            <ActionIcon
                                size="xs"
                                variant="subtle"
                                aria-label="Clear search"
                                onClick={() => {
                                    setFilter('');
                                    searchRef.current?.focus();
                                }}
                            >
                                <IconX size={13} />
                            </ActionIcon>
                        )}
                        <ActionIcon
                            size="xs"
                            variant="subtle"
                            aria-label="Close search"
                            onClick={closeSearch}
                        >
                            <IconChevronRight size={14} />
                        </ActionIcon>
                    </>
                ) : (
                    <>
                        <Text
                            size="xs"
                            className="flex-1 font-semibold tracking-wide text-dimmed uppercase"
                        >
                            Connections
                        </Text>
                        {profiles.length > 0 && (
                            <Tooltip label="Search connections">
                                <ActionIcon
                                    size="xs"
                                    variant="subtle"
                                    aria-label="Search connections"
                                    onClick={() => setSearching(true)}
                                >
                                    <IconSearch size={14} />
                                </ActionIcon>
                            </Tooltip>
                        )}
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
                    </>
                )}
            </div>

            <div className="min-h-0 flex-1 overflow-auto p-2 [scrollbar-gutter:stable]">
                {profiles.length === 0 ? (
                    <Text size="xs" className="text-dimmed">
                        Add a MySQL, PostgreSQL, MongoDB or Redis server to browse it and run
                        queries.
                    </Text>
                ) : rows.length === 0 ? (
                    <Text size="xs" className="text-dimmed">
                        Nothing matches “{filter.trim()}”.
                    </Text>
                ) : (
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
                )}
            </div>
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
    return (
        <li role="none">
            <div
                role="treeitem"
                aria-level={row.depth + 1}
                aria-expanded={row.expandable ? row.expanded : undefined}
                className={cx('group flex items-center rounded-sm hover:bg-hover', TREE_ROW_HEIGHT)}
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
                        'flex h-full min-w-0 flex-1 items-center gap-1.5 text-left text-sm',
                        row.kind === 'message' && 'cursor-default',
                        row.problem && 'text-red-500',
                        row.loading && 'text-dimmed',
                    )}
                    onDoubleClick={onOpen}
                    onClick={() => row.kind === 'connection' && !row.expandable && onOpen()}
                    title={row.detail ? `${row.label} · ${row.detail}` : row.label}
                >
                    {row.kind === 'connection' ? (
                        <>
                            <StatusDot
                                status={
                                    row.status === 'failed'
                                        ? 'error'
                                        : (row.status ?? 'disconnected')
                                }
                            />
                            <ObjectIcon kind="server" />
                        </>
                    ) : (
                        row.kind !== 'message' && <ObjectIcon kind={iconKindOf(row)} />
                    )}
                    <span className="truncate">{row.label}</span>
                    {row.detail && row.kind !== 'message' && (
                        <span className="truncate text-[11px] text-dimmed">{row.detail}</span>
                    )}
                </UnstyledButton>
                {row.kind !== 'message' && row.kind !== 'column' && row.kind !== 'index' && (
                    <TreeRowActions>{menu}</TreeRowActions>
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
    const actions = useExplorerActions();
    const profile = useProfiles((state) => state.profiles.find((p) => p.id === row.profileId));
    const engine = profile?.settings.engine ?? 'mysql';
    const can = actions.capabilities(row);
    const isTable = row.kind === 'table';
    const isView = row.kind === 'view';
    const mongo = engine === 'mongodb';
    const refresh = (
        <Menu.Item onClick={() => manager.refreshRow(row)}>
            {row.kind === 'connection' ? 'Refresh server' : 'Refresh'}
        </Menu.Item>
    );
    return (
        <Menu position="bottom-end" width={230}>
            <Menu.Target>
                <TreeRowMenuButton aria-label={`Actions for ${row.label}`} />
            </Menu.Target>
            <Menu.Dropdown>
                {row.kind === 'connection' && (
                    <>
                        {row.status === 'connected' ? (
                            <>
                                <Menu.Item onClick={() => manager.newQuery(row.profileId)}>
                                    New query
                                </Menu.Item>
                                {refresh}
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
                {(row.kind === 'database' || row.kind === 'schema') && (
                    <>
                        <Menu.Item
                            onClick={() =>
                                manager.newQuery(
                                    row.profileId,
                                    startOfQuery(engine, row.database),
                                    row.schema ?? row.database,
                                )
                            }
                        >
                            New query
                        </Menu.Item>
                        {refresh}
                        <Menu.Divider />
                        {can.supportsTableDesigner && (
                            <Menu.Item onClick={() => actions.newTable(row)}>New table…</Menu.Item>
                        )}
                        {mongo && (
                            <Menu.Item onClick={() => actions.newObject(row, 'collection')}>
                                New collection…
                            </Menu.Item>
                        )}
                        {can.supportsERDiagram && (
                            <Menu.Item onClick={() => actions.relationships(row)}>
                                Show relationships
                            </Menu.Item>
                        )}
                        {can.supportsImport && (
                            <Menu.Item onClick={() => actions.importData(row)}>
                                Import a file…
                            </Menu.Item>
                        )}
                        {can.supportsViews && !mongo && (
                            <Menu.Item onClick={() => actions.newObject(row, 'view')}>
                                New view…
                            </Menu.Item>
                        )}
                        {can.supportsFunctions && (
                            <Menu.Item onClick={() => actions.newObject(row, 'function')}>
                                New function…
                            </Menu.Item>
                        )}
                        {can.supportsProcedures && (
                            <Menu.Item onClick={() => actions.newObject(row, 'procedure')}>
                                New stored procedure…
                            </Menu.Item>
                        )}
                        {can.supportsTriggers && (
                            <Menu.Item onClick={() => actions.newObject(row, 'trigger')}>
                                New trigger…
                            </Menu.Item>
                        )}
                        {can.supportsEvents && (
                            <Menu.Item onClick={() => actions.newObject(row, 'event')}>
                                New event…
                            </Menu.Item>
                        )}
                    </>
                )}
                {row.kind === 'group' && (
                    <>
                        <Menu.Item onClick={() => manager.toggle(row)}>
                            {row.expanded ? 'Collapse' : 'Expand'}
                        </Menu.Item>
                        {refresh}
                        {row.object === 'tables' && can.supportsTableDesigner && (
                            <Menu.Item onClick={() => actions.newTable(row)}>New table…</Menu.Item>
                        )}
                        {row.object === 'tables' && mongo && (
                            <Menu.Item onClick={() => actions.newObject(row, 'collection')}>
                                New collection…
                            </Menu.Item>
                        )}
                        {row.object === 'views' && can.supportsViews && !mongo && (
                            <Menu.Item onClick={() => actions.newObject(row, 'view')}>
                                New view…
                            </Menu.Item>
                        )}
                        {row.object === 'routines' && can.supportsFunctions && (
                            <Menu.Item onClick={() => actions.newObject(row, 'function')}>
                                New function…
                            </Menu.Item>
                        )}
                        {row.object === 'routines' && can.supportsProcedures && (
                            <Menu.Item onClick={() => actions.newObject(row, 'procedure')}>
                                New stored procedure…
                            </Menu.Item>
                        )}
                        {row.object === 'triggers' && can.supportsTriggers && (
                            <Menu.Item onClick={() => actions.newObject(row, 'trigger')}>
                                New trigger…
                            </Menu.Item>
                        )}
                        {row.object === 'events' && can.supportsEvents && (
                            <Menu.Item onClick={() => actions.newObject(row, 'event')}>
                                New event…
                            </Menu.Item>
                        )}
                    </>
                )}
                {(isTable || isView) && (
                    <>
                        {(can.supportsTableEditor || can.supportsDocumentEditor) && (
                            <Menu.Item onClick={() => actions.openData(row)}>
                                {mongo ? 'Open documents' : 'Open table data'}
                            </Menu.Item>
                        )}
                        <Menu.Item onClick={() => void manager.openTable(row)}>
                            {OPEN_LABEL[engine] ?? 'Select rows in a query'}
                        </Menu.Item>
                        {isTable && can.supportsTableDesigner && (
                            <Menu.Item onClick={() => actions.design(row)}>
                                Edit structure…
                            </Menu.Item>
                        )}
                        {isTable && can.supportsIndexes && (
                            <Menu.Item onClick={() => actions.indexes(row)}>Indexes…</Menu.Item>
                        )}
                        {isTable && can.supportsTriggers && (
                            <Menu.Item onClick={() => actions.triggers(row)}>Triggers…</Menu.Item>
                        )}
                        {isTable && can.supportsTriggers && (
                            <Menu.Item onClick={() => actions.newObject(row, 'trigger')}>
                                New trigger…
                            </Menu.Item>
                        )}
                        {isTable && can.supportsERDiagram && (
                            <Menu.Item onClick={() => actions.relationships(row)}>
                                Show relationships
                            </Menu.Item>
                        )}
                        <Menu.Divider />
                        <Menu.Item onClick={onDefinition}>
                            {engine === 'redis' ? 'Show key info' : 'Show definition'}
                        </Menu.Item>
                        {isView && !mongo && (
                            <Menu.Item onClick={() => void actions.editDefinition(row)}>
                                Edit view…
                            </Menu.Item>
                        )}
                        {mongo && isTable && can.supportsValidation && (
                            <Menu.Item onClick={() => void actions.editValidation(row)}>
                                Edit validation rules…
                            </Menu.Item>
                        )}
                        {isTable && can.supportsExport && (
                            <Menu.Item onClick={() => actions.exportData(row)}>
                                Export data…
                            </Menu.Item>
                        )}
                        {isTable && can.supportsImport && (
                            <Menu.Item onClick={() => actions.importData(row)}>
                                Import data…
                            </Menu.Item>
                        )}
                        <Menu.Item
                            onClick={() =>
                                void navigator.clipboard?.writeText(qualifiedName(engine, row))
                            }
                        >
                            Copy name
                        </Menu.Item>
                        {refresh}
                        {engine !== 'redis' && (
                            <>
                                <Menu.Divider />
                                {isTable && !mongo && (
                                    <Menu.Item color="red" onClick={() => actions.truncate(row)}>
                                        Delete all rows…
                                    </Menu.Item>
                                )}
                                <Menu.Item onClick={() => actions.rename(row)}>Rename…</Menu.Item>
                                <Menu.Item color="red" onClick={() => void actions.drop(row)}>
                                    {isView
                                        ? 'Drop view…'
                                        : mongo
                                          ? 'Drop collection…'
                                          : 'Drop table…'}
                                </Menu.Item>
                            </>
                        )}
                    </>
                )}
                {row.kind === 'routine' && (
                    <>
                        <Menu.Item onClick={() => actions.runRoutine(row)}>Run…</Menu.Item>
                        <Menu.Item onClick={onDefinition}>Show definition</Menu.Item>
                        <Menu.Item onClick={() => void actions.editDefinition(row)}>
                            Edit…
                        </Menu.Item>
                        <Menu.Divider />
                        <Menu.Item color="red" onClick={() => void actions.drop(row)}>
                            Drop…
                        </Menu.Item>
                    </>
                )}
                {row.kind === 'trigger' && (
                    <>
                        <Menu.Item onClick={() => actions.triggers(row)}>
                            Open trigger manager
                        </Menu.Item>
                        <Menu.Item onClick={onDefinition}>Show definition</Menu.Item>
                        <Menu.Item onClick={() => void actions.editDefinition(row)}>
                            Edit…
                        </Menu.Item>
                        <Menu.Divider />
                        <Menu.Item color="red" onClick={() => void actions.drop(row)}>
                            Drop trigger…
                        </Menu.Item>
                    </>
                )}
                {row.kind === 'event' && (
                    <>
                        <Menu.Item onClick={onDefinition}>Show definition</Menu.Item>
                        <Menu.Item onClick={() => void actions.editDefinition(row)}>
                            Edit…
                        </Menu.Item>
                    </>
                )}
            </Menu.Dropdown>
        </Menu>
    );
}
