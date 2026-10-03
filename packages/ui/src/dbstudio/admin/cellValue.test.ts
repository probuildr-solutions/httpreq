/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { mysqlDialect, postgresDialect } from '@httpreq/db-admin';
import { describe, expect, it } from 'vitest';
import {
    cellToSqlValue,
    editText,
    isEditableCell,
    rowsToCsv,
    rowsToInserts,
    rowsToJson,
    rowsToNdjson,
    rowsToTsv,
} from './cellValue';

describe('cell values', () => {
    it('writes grid values back as statement values', () => {
        expect(cellToSqlValue(null, 'int')).toEqual({ kind: 'null' });
        expect(cellToSqlValue(42, 'int')).toEqual({ kind: 'number', value: '42' });
        expect(cellToSqlValue(10n ** 20n, 'bigint')).toEqual({
            kind: 'number',
            value: '100000000000000000000',
        });
        expect(cellToSqlValue(1, 'tinyint(1)')).toEqual({ kind: 'boolean', value: true });
        expect(cellToSqlValue('x', 'varchar(5)')).toEqual({ kind: 'text', value: 'x' });
        expect(cellToSqlValue('{"a":1}', 'json')).toEqual({ kind: 'json', value: '{"a":1}' });
        expect(cellToSqlValue(new Date(Date.UTC(2026, 0, 31, 12, 5, 9)), 'datetime')).toEqual({
            kind: 'text',
            value: '2026-01-31 12:05:09',
        });
        expect(cellToSqlValue(new Uint8Array([0xde, 0xad]), 'blob')).toEqual({
            kind: 'binary',
            hex: 'dead',
        });
        expect(cellToSqlValue({ a: [1, { $type: 'objectId', $value: 'abc' }] }, 'jsonb')).toEqual({
            kind: 'json',
            value: '{"a":[1,"abc"]}',
        });
    });

    it('formats JSON for editing and hex for small binary values', () => {
        expect(editText('{"a":1}', 'json')).toBe('{\n  "a": 1\n}');
        expect(editText(new Uint8Array([1, 255]), 'bytea')).toBe('01ff');
        expect(editText(null, 'int')).toBe('');
    });

    it('refuses to edit a large binary value', () => {
        expect(isEditableCell(new Uint8Array(10), 'blob')).toBe(true);
        expect(isEditableCell(new Uint8Array(100_000), 'blob')).toBe(false);
        expect(isEditableCell('text', 'varchar')).toBe(true);
    });
});

describe('copy and export', () => {
    const columns = [
        { name: 'id', type: 'int' },
        { name: 'note', type: 'text' },
    ];
    const rows = [
        [1, 'plain'],
        [2, 'has, comma and "quotes"\nand a newline'],
        [3, null],
    ];

    it('quotes CSV fields and leaves NULL empty', () => {
        expect(rowsToCsv(columns, rows)).toBe(
            'id,note\r\n1,plain\r\n2,"has, comma and ""quotes""\nand a newline"\r\n3,\r\n',
        );
    });

    it('copies cells as tab-separated text without breaking the row structure', () => {
        expect(rowsToTsv(rows, [1])).toBe('plain\nhas, comma and "quotes" and a newline\n');
        expect(rowsToTsv(rows, [0, 1]).split('\n')).toHaveLength(3);
    });

    it('exports JSON and NDJSON with bigint and binary values as text', () => {
        const wide = [
            { name: 'big', type: 'bigint' },
            { name: 'bin', type: 'blob' },
        ];
        const data = [[123n, new Uint8Array([1, 2])]];
        expect(JSON.parse(rowsToJson(wide, data))).toEqual([{ big: '123', bin: '0102' }]);
        expect(rowsToNdjson(wide, data)).toBe('{"big":"123","bin":"0102"}\n');
    });

    it('writes INSERT statements for each dialect', () => {
        expect(rowsToInserts(mysqlDialect, { name: 't' }, columns, [[1, "it's"]])).toBe(
            "INSERT INTO `t` (`id`, `note`) VALUES (1, 'it''s');\n",
        );
        expect(
            rowsToInserts(postgresDialect, { schema: 's', name: 't' }, columns, [[1, null]]),
        ).toBe('INSERT INTO "s"."t" ("id", "note") VALUES (1, NULL);\n');
    });
});
