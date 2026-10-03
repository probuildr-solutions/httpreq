/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import {
    IconBraces,
    IconBolt,
    IconCalendarEvent,
    IconColumns,
    IconDatabase,
    IconFileCode,
    IconFolder,
    IconFunction,
    IconKey,
    IconLink,
    IconListDetails,
    IconListNumbers,
    IconPackage,
    IconSchema,
    IconServer,
    IconShieldCheck,
    IconSitemap,
    IconTable,
    IconTableOptions,
    IconTerminal2,
    IconTool,
    IconEye,
    IconStack2,
    IconPlug,
    type Icon,
} from '@tabler/icons-react';
import { cx } from '../kit';

/**
 * One icon per kind of database object, used by the explorer, the tab strip and the dialogs, so a
 * table looks like a table wherever it appears. Each has its own hue, picked to be told apart at
 * 14 px and to stay readable on both the light and the dark surface (a darker shade for light, a
 * lighter one for dark); the hues are muted enough that a tree of hundreds of rows is not noisy.
 */
export type ObjectKind =
    | 'server'
    | 'connection'
    | 'database'
    | 'schema'
    | 'table'
    | 'view'
    | 'materializedView'
    | 'column'
    | 'primaryKey'
    | 'foreignKey'
    | 'index'
    | 'constraint'
    | 'function'
    | 'procedure'
    | 'trigger'
    | 'event'
    | 'sequence'
    | 'extension'
    | 'collection'
    | 'document'
    | 'folder'
    | 'query'
    | 'file'
    | 'design'
    | 'diagram';

interface Look {
    icon: Icon;
    color: string;
    label: string;
}

const LOOKS: Record<ObjectKind, Look> = {
    server: { icon: IconServer, color: 'text-slate-600 dark:text-slate-300', label: 'Server' },
    connection: {
        icon: IconPlug,
        color: 'text-emerald-600 dark:text-emerald-400',
        label: 'Connection',
    },
    database: {
        icon: IconDatabase,
        color: 'text-amber-600 dark:text-amber-400',
        label: 'Database',
    },
    schema: { icon: IconSchema, color: 'text-orange-600 dark:text-orange-400', label: 'Schema' },
    table: { icon: IconTable, color: 'text-sky-600 dark:text-sky-400', label: 'Table' },
    view: { icon: IconEye, color: 'text-teal-600 dark:text-teal-400', label: 'View' },
    materializedView: {
        icon: IconStack2,
        color: 'text-cyan-600 dark:text-cyan-400',
        label: 'Materialized view',
    },
    column: { icon: IconColumns, color: 'text-slate-500 dark:text-slate-400', label: 'Column' },
    primaryKey: {
        icon: IconKey,
        color: 'text-yellow-600 dark:text-yellow-400',
        label: 'Primary key',
    },
    foreignKey: { icon: IconLink, color: 'text-rose-600 dark:text-rose-400', label: 'Foreign key' },
    index: { icon: IconListNumbers, color: 'text-indigo-600 dark:text-indigo-400', label: 'Index' },
    constraint: {
        icon: IconShieldCheck,
        color: 'text-fuchsia-600 dark:text-fuchsia-400',
        label: 'Constraint',
    },
    function: {
        icon: IconFunction,
        color: 'text-violet-600 dark:text-violet-400',
        label: 'Function',
    },
    procedure: {
        icon: IconTerminal2,
        color: 'text-purple-600 dark:text-purple-400',
        label: 'Stored procedure',
    },
    trigger: { icon: IconBolt, color: 'text-red-600 dark:text-red-400', label: 'Trigger' },
    event: { icon: IconCalendarEvent, color: 'text-pink-600 dark:text-pink-400', label: 'Event' },
    sequence: {
        icon: IconListDetails,
        color: 'text-lime-600 dark:text-lime-400',
        label: 'Sequence',
    },
    extension: {
        icon: IconPackage,
        color: 'text-stone-600 dark:text-stone-300',
        label: 'Extension',
    },
    collection: {
        icon: IconTableOptions,
        color: 'text-green-600 dark:text-green-400',
        label: 'Collection',
    },
    document: { icon: IconBraces, color: 'text-green-700 dark:text-green-300', label: 'Document' },
    folder: { icon: IconFolder, color: 'text-yellow-700 dark:text-yellow-500', label: 'Folder' },
    query: { icon: IconTerminal2, color: 'text-blue-600 dark:text-blue-400', label: 'Query' },
    file: { icon: IconFileCode, color: 'text-slate-600 dark:text-slate-300', label: 'File' },
    design: {
        icon: IconTool,
        color: 'text-orange-600 dark:text-orange-400',
        label: 'Table design',
    },
    diagram: { icon: IconSitemap, color: 'text-cyan-600 dark:text-cyan-400', label: 'Diagram' },
};

export function ObjectIcon({
    kind,
    size = 14,
    className,
}: {
    kind: ObjectKind;
    size?: number;
    className?: string;
}) {
    const { icon: Glyph, color, label } = LOOKS[kind];
    return (
        <Glyph
            size={size}
            stroke={1.7}
            aria-label={label}
            role="img"
            className={cx('flex-none', color, className)}
        />
    );
}
