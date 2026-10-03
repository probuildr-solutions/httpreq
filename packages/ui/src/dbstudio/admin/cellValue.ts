/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import {
    categoryOfType,
    dbValueToSqlValue,
    hexOfBytes,
    toPlainJson,
    type ObjectName,
    type SqlDialect,
    type SqlValue,
} from '@httpreq/db-admin';
import type { DbValue } from '@httpreq/db-core';
import type { DbCell } from '@httpreq/shared';
import { formatCell } from '../db/cells';

/**
 * Turning what a grid holds into what a statement needs, and into text for copying and exporting.
 * Pure, so the rules (how a date is written, what a binary value looks like, how a CSV field is
 * quoted) are tested without a window.
 */

const hexOf = hexOfBytes;

const plainJson = (value: DbCell): unknown => toPlainJson(value as DbValue);

/** A value as read from a result, written back as the value of a statement. */
export const cellToSqlValue = (cell: DbCell | undefined, type: string): SqlValue =>
    dbValueToSqlValue(cell as DbValue | undefined, type);

/** The text a cell is edited as. A JSON column is shown formatted. */
export const editText = (cell: DbCell | undefined, type: string): string => {
    if (cell === null || cell === undefined) return '';
    if (categoryOfType(type) === 'json') {
        const text = typeof cell === 'string' ? cell : JSON.stringify(plainJson(cell));
        try {
            return JSON.stringify(JSON.parse(text), null, 2);
        } catch {
            return text;
        }
    }
    if (cell instanceof Uint8Array) return hexOf(cell);
    return formatCell(cell);
};

/** Whether a cell can be edited in the grid: binary values only when they are small enough to type. */
export const MAX_EDITABLE_BINARY_BYTES = 4096;
export const isEditableCell = (cell: DbCell | undefined, type: string): boolean => {
    if (cell instanceof Uint8Array) return cell.length <= MAX_EDITABLE_BINARY_BYTES;
    return categoryOfType(type) !== 'binary' || cell === null || cell === undefined;
};

/* ---------- Copy and export ---------- */

export interface ExportColumn {
    name: string;
    type: string;
}

const csvField = (text: string): string =>
    /[",\r\n]/.test(text) || text !== text.trim() ? `"${text.replace(/"/g, '""')}"` : text;

const cellText = (cell: DbCell | undefined): string =>
    cell === null || cell === undefined ? '' : formatCell(cell);

export const rowsToCsv = (columns: ExportColumn[], rows: DbCell[][], header = true): string => {
    const lines = rows.map((row) => columns.map((_, i) => csvField(cellText(row[i]))).join(','));
    return `${[...(header ? [columns.map((c) => csvField(c.name)).join(',')] : []), ...lines].join('\r\n')}\r\n`;
};

/** Tab-separated, the format pasted into a spreadsheet. NULL stays empty. */
export const rowsToTsv = (rows: DbCell[][], columns: number[]): string =>
    rows
        .map((row) => columns.map((i) => cellText(row[i]).replace(/[\t\r\n]+/g, ' ')).join('\t'))
        .join('\n');

const jsonObject = (columns: ExportColumn[], row: DbCell[]) =>
    Object.fromEntries(columns.map((c, i) => [c.name, plainJson(row[i] ?? null)]));

export const rowsToJson = (columns: ExportColumn[], rows: DbCell[][]): string =>
    `[\n${rows.map((row) => `  ${JSON.stringify(jsonObject(columns, row))}`).join(',\n')}\n]\n`;

export const rowsToNdjson = (columns: ExportColumn[], rows: DbCell[][]): string =>
    rows.map((row) => `${JSON.stringify(jsonObject(columns, row))}\n`).join('');

export const rowsToInserts = (
    dialect: SqlDialect,
    table: ObjectName,
    columns: ExportColumn[],
    rows: DbCell[][],
): string => {
    const names = columns.map((c) => dialect.quote(c.name)).join(', ');
    return rows
        .map(
            (row) =>
                `INSERT INTO ${dialect.qualify(table)} (${names}) VALUES (${columns
                    .map((c, i) => dialect.literal(cellToSqlValue(row[i], c.type)))
                    .join(', ')});`,
        )
        .join('\n')
        .concat(rows.length ? '\n' : '');
};
