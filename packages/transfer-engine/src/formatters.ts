/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import type { ColumnMeta, DbValue } from '@httpreq/db-core';
import {
    dbValueToSqlValue,
    fromDbValue,
    toExtendedJson,
    toPlainJson,
    type ObjectName,
    type SqlDialect,
} from '@httpreq/db-admin';
import { encodeDocument, type BsonDocument } from '@httpreq/db-protocol-mongo';
import { csvLine } from './csv';

/**
 * Turning rows into the bytes of an export, a batch at a time. A formatter keeps only what it must
 * to continue (whether a comma goes before the next JSON element, how many rows are waiting to fill
 * an INSERT), so an export of any size is a series of small strings.
 */
export type ExportFormat = 'csv' | 'json' | 'ndjson' | 'sql' | 'bson';

export type Piece = string | Uint8Array;

export interface ExportFormatter {
    begin(columns: ColumnMeta[]): Piece;
    rows(rows: DbValue[][]): Piece;
    end(): Piece;
}

const NONE = '';

export interface CsvExportOptions {
    delimiter?: string;
    header?: boolean;
    /** Windows-style CRLF (the default, as RFC 4180 says) or LF. */
    eol?: '\r\n' | '\n';
    /** A UTF-8 byte order mark, which Excel needs to read accents correctly. */
    bom?: boolean;
    /**
     * What a NULL is written as. CSV cannot tell NULL from an empty string unless this is something
     * else (a backslash and N, or NULL); the importer's "text that means NULL" reads it back.
     */
    nullText?: string;
}

const csvText = (value: DbValue | undefined): string => {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'bigint' || typeof value === 'number' || typeof value === 'boolean')
        return String(value);
    if (value instanceof Date) return value.toISOString();
    const plain = toPlainJson(value);
    return typeof plain === 'string' ? plain : JSON.stringify(plain);
};

export const csvFormatter = (options: CsvExportOptions = {}): ExportFormatter => {
    const delimiter = options.delimiter ?? ',';
    const eol = options.eol ?? '\r\n';
    const nullText = options.nullText ?? '';
    return {
        begin: (columns) =>
            `${options.bom ? '﻿' : ''}${
                options.header === false
                    ? ''
                    : csvLine(
                          columns.map((c) => c.name),
                          delimiter,
                          eol,
                      )
            }`,
        rows: (rows) =>
            rows
                .map((row) =>
                    csvLine(
                        row.map((v) => (v === null || v === undefined ? nullText : csvText(v))),
                        delimiter,
                        eol,
                    ),
                )
                .join(''),
        end: () => NONE,
    };
};

const objectOf = (columns: ColumnMeta[], row: DbValue[]) =>
    Object.fromEntries(columns.map((column, i) => [column.name, toPlainJson(row[i] ?? null)]));

/** Documents (a single `document` column) as canonical extended JSON; rows as plain JSON objects. */
const jsonOf = (columns: ColumnMeta[], row: DbValue[], documents: boolean): string =>
    JSON.stringify(
        documents ? toExtendedJson(fromDbValue(row[0] ?? null)) : objectOf(columns, row),
    );

export const jsonFormatter = (options: { documents?: boolean } = {}): ExportFormatter => {
    let columns: ColumnMeta[] = [];
    let first = true;
    return {
        begin: (c) => {
            columns = c;
            return '[\n';
        },
        rows: (rows) => {
            let text = '';
            for (const row of rows) {
                text += `${first ? '' : ',\n'}  ${jsonOf(columns, row, !!options.documents)}`;
                first = false;
            }
            return text;
        },
        end: () => (first ? ']\n' : '\n]\n'),
    };
};

export const ndjsonFormatter = (options: { documents?: boolean } = {}): ExportFormatter => {
    let columns: ColumnMeta[] = [];
    return {
        begin: (c) => {
            columns = c;
            return NONE;
        },
        rows: (rows) =>
            rows.map((row) => `${jsonOf(columns, row, !!options.documents)}\n`).join(''),
        end: () => NONE,
    };
};

export interface SqlExportOptions {
    dialect: SqlDialect;
    table: ObjectName;
    /** Rows per INSERT statement. */
    rowsPerStatement?: number;
    /** The statement that creates the table, written first when given. */
    create?: string;
    /** Also write `DROP TABLE IF EXISTS` before it. */
    drop?: boolean;
}

export const sqlFormatter = (options: SqlExportOptions): ExportFormatter => {
    const { dialect, table } = options;
    const per = Math.max(1, options.rowsPerStatement ?? 100);
    let columns: ColumnMeta[] = [];
    let pending: string[] = [];
    const target = dialect.qualify(table);
    const flush = (): string => {
        if (pending.length === 0) return '';
        const list = columns.map((c) => dialect.quote(c.name)).join(', ');
        const text = `INSERT INTO ${target} (${list}) VALUES\n${pending.join(',\n')};\n`;
        pending = [];
        return text;
    };
    return {
        begin: (c) => {
            columns = c;
            let head = `-- Exported from ${target}\n`;
            if (options.drop) head += `DROP TABLE IF EXISTS ${target};\n`;
            if (options.create) head += `${options.create.replace(/;\s*$/, '')};\n`;
            return `${head}\n`;
        },
        rows: (rows) => {
            let text = '';
            for (const row of rows) {
                pending.push(
                    `(${columns.map((column, i) => dialect.literal(dbValueToSqlValue(row[i], column.type))).join(', ')})`,
                );
                if (pending.length >= per) text += flush();
            }
            return text;
        },
        end: () => flush(),
    };
};

/** MongoDB's BSON dump layout: documents one after another, each with its own length prefix. */
export const bsonFormatter = (): ExportFormatter => ({
    begin: () => NONE,
    rows: (rows) => {
        const parts = rows.map((row) => encodeDocument((row[0] ?? {}) as BsonDocument));
        return new Uint8Array(Buffer.concat(parts));
    },
    end: () => NONE,
});

export const pieceLength = (piece: Piece): number =>
    typeof piece === 'string' ? Buffer.byteLength(piece) : piece.length;
