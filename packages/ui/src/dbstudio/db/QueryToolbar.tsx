/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import {
    IconArrowBackUp,
    IconCheck,
    IconDeviceFloppy,
    IconDownload,
    IconPlayerPlay,
    IconPlayerStop,
    IconPlayerTrackNext,
    IconRoute,
    IconTransactionBitcoin,
} from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { Button, Select, Tooltip } from '../../kit';
import type { ConnectionProfile } from './profiles';
import { toolbarActions, type ToolbarActionId, type ToolbarState } from './toolbarActions';

const ICON: Record<ToolbarActionId, ReactNode> = {
    run: <IconPlayerPlay size={13} />,
    runAll: <IconPlayerTrackNext size={13} />,
    stop: <IconPlayerStop size={13} />,
    explain: <IconRoute size={13} />,
    save: <IconDeviceFloppy size={13} />,
    export: <IconDownload size={13} />,
    begin: <IconTransactionBitcoin size={13} />,
    commit: <IconCheck size={13} />,
    rollback: <IconArrowBackUp size={13} />,
};

export interface QueryToolbarProps {
    state: ToolbarState;
    profiles: ConnectionProfile[];
    connectionId: string | null;
    database: string | null;
    schema: string | null;
    databases: string[];
    schemas: string[];
    /** Whether the engine has schemas inside databases. */
    withSchemas: boolean;
    /** Shown at the right: "Not connected · connects when you run". */
    note: string;
    onConnection: (id: string | null) => void;
    onDatabase: (name: string | null) => void;
    onSchema: (name: string | null) => void;
    onAction: (id: ToolbarActionId) => void;
}

/**
 * The query toolbar: the connection, database and schema pickers (the compact picker size of the
 * workspace switcher) and the actions of `toolbarActions`. Run, Run all and Stop are always
 * present and only switch between enabled and disabled, so starting a query never changes the
 * toolbar's width and nothing beside or below it moves. Long names truncate inside fixed widths.
 */
export function QueryToolbar({
    state,
    profiles,
    connectionId,
    database,
    schema,
    databases,
    schemas,
    withSchemas,
    note,
    onConnection,
    onDatabase,
    onSchema,
    onAction,
}: QueryToolbarProps) {
    const actions = toolbarActions(state);
    return (
        <div
            role="toolbar"
            aria-label="Query"
            className="box-border flex h-9 flex-none items-center gap-1.5 overflow-x-auto overflow-y-hidden border-b border-line bg-chrome px-2 whitespace-nowrap"
        >
            <Select
                size="toolbar"
                aria-label="Connection"
                placeholder="Choose a connection"
                value={connectionId}
                data={profiles.map((p) => ({ value: p.id, label: p.name }))}
                onChange={onConnection}
                className="w-40 min-w-24 shrink"
                menuWidth={220}
            />
            {databases.length > 0 && (
                <Select
                    size="toolbar"
                    aria-label="Database"
                    placeholder="Database"
                    clearable
                    value={database}
                    data={databases.map((name) => ({ value: name, label: name }))}
                    onChange={onDatabase}
                    className="w-32 min-w-20 shrink"
                    menuWidth={200}
                />
            )}
            {withSchemas && schemas.length > 0 && (
                <Select
                    size="toolbar"
                    aria-label="Schema"
                    placeholder="Schema"
                    clearable
                    value={schema}
                    data={schemas.map((name) => ({ value: name, label: name }))}
                    onChange={onSchema}
                    className="w-28 min-w-20 shrink"
                    menuWidth={180}
                />
            )}
            {actions.map((action, index) => (
                <ToolbarItem
                    key={action.id}
                    // A divider where the group changes.
                    divider={index > 0 && actions[index - 1]!.group !== action.group}
                >
                    <Tooltip label={action.tooltip}>
                        <Button
                            size="compact-sm"
                            variant={action.variant}
                            color={action.color}
                            leftSection={ICON[action.id]}
                            disabled={action.disabled}
                            data-action={action.id}
                            onClick={() => onAction(action.id)}
                        >
                            {action.label}
                        </Button>
                    </Tooltip>
                </ToolbarItem>
            ))}
            <span className="ml-auto flex-none text-xs text-dimmed">{note}</span>
        </div>
    );
}

function ToolbarItem({ divider, children }: { divider: boolean; children: ReactNode }) {
    return (
        <>
            {divider && <span aria-hidden className="mx-0.5 h-4 w-px flex-none bg-line" />}
            {children}
        </>
    );
}
