/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import {
    deleteRowSql,
    insertRowSql,
    updateRowSql,
    type ColumnValue,
    type ObjectName,
    type SqlDialect,
    type SqlValue,
} from '@httpreq/db-admin';
import type { DbCell } from '@httpreq/shared';
import { cellToSqlValue } from './cellValue';

/**
 * The edits staged in the table editor, and the statements that write them. Edits are staged, not
 * sent: the person sees what will run, applies it once and can discard it. Each changed row is
 * addressed by its key as it was when it was read, so editing a key column still finds the row.
 */
export interface StagedCellEdit {
    value: SqlValue;
    /** What the grid shows for it. */
    text: string;
}

export interface StagedChanges {
    /** Edits to rows that were read, keyed `row:column`. */
    edits: Map<string, StagedCellEdit>;
    /** Rows (by index) to delete. */
    deleted: Set<number>;
    /** Rows to insert: column index to edit. A column left out takes its default. */
    inserts: Map<number, StagedCellEdit>[];
}

export const emptyChanges = (): StagedChanges => ({
    edits: new Map(),
    deleted: new Set(),
    inserts: [],
});

export const editKey = (row: number, column: number) => `${row}:${column}`;

export const changeCount = (changes: StagedChanges): number => {
    const rows = new Set<number>();
    for (const key of changes.edits.keys()) rows.add(Number(key.split(':')[0]));
    return rows.size + changes.deleted.size + changes.inserts.length;
};

export interface TableColumn {
    name: string;
    type: string;
    primaryKey: boolean;
    autoIncrement?: boolean;
    nullable?: boolean;
}

export interface ChangeStatements {
    statements: string[];
    /** Why some changes cannot be written; the rest are still listed. */
    problems: string[];
}

export const buildChangeStatements = (
    dialect: SqlDialect,
    table: ObjectName,
    columns: TableColumn[],
    keyColumns: number[],
    rows: DbCell[][],
    changes: StagedChanges,
): ChangeStatements => {
    const statements: string[] = [];
    const problems: string[] = [];
    const keyOf = (row: number): ColumnValue[] =>
        keyColumns.map((index) => ({
            column: columns[index]!.name,
            value: cellToSqlValue(rows[row]?.[index], columns[index]!.type),
        }));
    const needsKey = changes.edits.size > 0 || changes.deleted.size > 0;
    if (needsKey && keyColumns.length === 0) {
        problems.push(
            'This table has no primary key or unique key, so a single row cannot be identified. Rows cannot be changed or deleted here.',
        );
    } else {
        const byRow = new Map<number, ColumnValue[]>();
        for (const [key, edit] of changes.edits) {
            const [rowText, columnText] = key.split(':');
            const row = Number(rowText);
            if (changes.deleted.has(row)) continue;
            const list = byRow.get(row) ?? [];
            list.push({ column: columns[Number(columnText)]!.name, value: edit.value });
            byRow.set(row, list);
        }
        for (const [row, edits] of [...byRow].sort((a, b) => a[0] - b[0]))
            statements.push(updateRowSql(dialect, table, keyOf(row), edits));
        for (const row of [...changes.deleted].sort((a, b) => a - b))
            statements.push(deleteRowSql(dialect, table, keyOf(row)));
    }
    for (const insert of changes.inserts) {
        const values: ColumnValue[] = [...insert]
            .sort((a, b) => a[0] - b[0])
            .map(([index, edit]) => ({ column: columns[index]!.name, value: edit.value }));
        statements.push(insertRowSql(dialect, table, values));
    }
    return { statements, problems };
};

/** The columns that identify a row: the primary key, else the first unique key of non-null columns. */
export const keyColumnsOf = (
    columns: TableColumn[],
    uniqueIndexes: { columns: string[] }[] = [],
): number[] => {
    const primary = columns.flatMap((c, i) => (c.primaryKey ? [i] : []));
    if (primary.length) return primary;
    for (const index of uniqueIndexes) {
        const positions = index.columns.map((name) => columns.findIndex((c) => c.name === name));
        if (
            positions.length > 0 &&
            positions.every((p) => p >= 0 && columns[p]!.nullable === false)
        )
            return positions;
    }
    return [];
};
