/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { mysqlDialect, postgresDialect } from '@httpreq/db-admin';
import { describe, expect, it } from 'vitest';
import {
    buildChangeStatements,
    changeCount,
    editKey,
    emptyChanges,
    keyColumnsOf,
    type TableColumn,
} from './tableChanges';

const columns: TableColumn[] = [
    { name: 'id', type: 'int', primaryKey: true, nullable: false },
    { name: 'name', type: 'varchar(20)', primaryKey: false, nullable: true },
    { name: 'age', type: 'int', primaryKey: false, nullable: true },
];
const rows = [
    [1, 'Ada', 36],
    [2, 'Bob', null],
];

describe('staged table changes', () => {
    it('writes updates, deletes and inserts addressed by the original key', () => {
        const changes = emptyChanges();
        changes.edits.set(editKey(0, 1), {
            value: { kind: 'text', value: "Ada L'" },
            text: "Ada L'",
        });
        changes.edits.set(editKey(0, 2), { value: { kind: 'null' }, text: 'NULL' });
        changes.deleted.add(1);
        changes.inserts.push(
            new Map([[1, { value: { kind: 'text', value: 'New' }, text: 'New' }]]),
        );
        const { statements, problems } = buildChangeStatements(
            mysqlDialect,
            { database: 'shop', name: 'people' },
            columns,
            [0],
            rows,
            changes,
        );
        expect(problems).toEqual([]);
        expect(statements).toEqual([
            "UPDATE `shop`.`people`\nSET `name` = 'Ada L''', `age` = NULL\nWHERE `id` = 1\nLIMIT 1;",
            'DELETE FROM `shop`.`people`\nWHERE `id` = 2\nLIMIT 1;',
            "INSERT INTO `shop`.`people` (`name`)\nVALUES ('New');",
        ]);
        expect(changeCount(changes)).toBe(3);
    });

    it('skips the edits of a row that is deleted', () => {
        const changes = emptyChanges();
        changes.edits.set(editKey(1, 1), { value: { kind: 'text', value: 'x' }, text: 'x' });
        changes.deleted.add(1);
        const { statements } = buildChangeStatements(
            postgresDialect,
            { schema: 'public', name: 't' },
            columns,
            [0],
            rows,
            changes,
        );
        expect(statements).toEqual(['DELETE FROM "public"."t"\nWHERE "id" = 2;']);
    });

    it('refuses to change rows of a table without a key, but still inserts', () => {
        const changes = emptyChanges();
        changes.edits.set(editKey(0, 1), { value: { kind: 'text', value: 'x' }, text: 'x' });
        changes.inserts.push(new Map());
        const { statements, problems } = buildChangeStatements(
            mysqlDialect,
            { name: 't' },
            columns,
            [],
            rows,
            changes,
        );
        expect(problems[0]).toMatch(/no primary key/);
        expect(statements).toEqual(['INSERT INTO `t` () VALUES ();']);
    });

    it('finds the key: the primary key, else a unique index of non-null columns', () => {
        expect(keyColumnsOf(columns)).toEqual([0]);
        const loose: TableColumn[] = columns.map((c) => ({ ...c, primaryKey: false }));
        expect(keyColumnsOf(loose, [{ columns: ['name'] }])).toEqual([]);
        expect(keyColumnsOf(loose, [{ columns: ['name'] }, { columns: ['id'] }])).toEqual([0]);
    });
});
