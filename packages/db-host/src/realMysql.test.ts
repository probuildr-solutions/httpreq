/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
    alterTableSql,
    callStatements,
    createIndexSql,
    createRoutineSql,
    createTableSql,
    createTriggerSql,
    createViewSql,
    deleteRowSql,
    designFromMetadata,
    dropTableSql,
    emptyDesign,
    insertRowSql,
    mysqlDialect,
    newColumnId,
    parametersFromDefinition,
    selectPageSql,
    updateRowSql,
    type TableDesign,
} from '@httpreq/db-admin';
import { isRelationalSession, type RelationalSession, type ResultEvent } from '@httpreq/db-core';
import { ChunkReader, FileSink, openFileSource } from '@httpreq/file-engine';
import { mysqlProvider } from '@httpreq/mysql-engine';
import { ScriptRun } from '@httpreq/query-engine';
import { startMysql, type TestServer } from '@httpreq/test-servers';
import {
    csvFormatter,
    jsonFormatter,
    ndjsonFormatter,
    recordingContext,
    runExport,
    runImport,
    sqlFormatter,
} from '@httpreq/transfer-engine';

/**
 * The generators and the transfer engine against a real MySQL server (skipped when none is
 * installed): every statement they produce is run, and what the server then reports is compared
 * with what was asked for.
 */
let server: TestServer | null = null;
let session: RelationalSession;
let dir: string;

const run = async (sql: string) => {
    const events: ResultEvent[] = [];
    for await (const event of session.execute(sql)) events.push(event);
    return events;
};
const rowsOf = async (sql: string) =>
    (await run(sql)).flatMap((e) => (e.kind === 'rows' ? e.rows : []));
const runAll = async (statements: string[]) => {
    for (const statement of statements) await run(statement);
};

beforeAll(async () => {
    server = await startMysql();
    if (!server) return;
    const connected = await mysqlProvider
        .createConnector({
            engine: 'mysql',
            host: server.host,
            port: server.port,
            username: 'app',
            password: server.users.app,
            tls: { mode: 'disable' },
            connectTimeoutMs: 10_000,
            queryTimeoutMs: 0,
            options: {},
        })
        .connect();
    if (!isRelationalSession(connected)) throw new Error('not relational');
    session = connected;
    await run('USE shop');
    dir = await mkdtemp(join(tmpdir(), 'httpreq-real-'));
}, 180_000);
afterAll(async () => {
    await session?.close();
    await server?.stop();
    if (dir) await rm(dir, { recursive: true, force: true });
});

const live = (name: string, body: () => Promise<void>, timeout = 120_000) =>
    it(
        name,
        async (context) => {
            if (!server) return context.skip();
            await body();
        },
        timeout,
    );

const describeTable = async (name: string): Promise<TableDesign> => {
    const ref = { database: 'shop', name };
    const listed = (await session.listTables({ database: 'shop' })).find((t) => t.name === name);
    return designFromMetadata({
        dialect: 'mysql',
        ...ref,
        comment: listed?.comment,
        columns: await session.listColumns(ref),
        indexes: await session.listIndexes(ref),
        constraints: await session.listConstraints(ref),
    });
};

describe('table designer against MySQL', () => {
    live(
        'creates a table, reads it back as the same design, and changes it with ALTER',
        async () => {
            await run('DROP TABLE IF EXISTS d_items');
            await run('DROP TABLE IF EXISTS d_owners');
            const owners: TableDesign = {
                ...emptyDesign('d_owners'),
                database: 'shop',
                columns: [
                    {
                        id: newColumnId(),
                        name: 'id',
                        type: 'int',
                        nullable: false,
                        autoIncrement: true,
                    },
                    {
                        id: newColumnId(),
                        name: 'name',
                        type: 'varchar',
                        length: '60',
                        nullable: false,
                    },
                ],
                primaryKey: ['id'],
            };
            await runAll(createTableSql(mysqlDialect, owners));

            const items: TableDesign = {
                ...emptyDesign('d_items'),
                database: 'shop',
                comment: 'Things',
                columns: [
                    { id: 'a', name: 'id', type: 'int', nullable: false, autoIncrement: true },
                    { id: 'b', name: 'owner_id', type: 'int', nullable: true },
                    {
                        id: 'c',
                        name: 'label',
                        type: 'varchar',
                        length: '40',
                        nullable: false,
                        default: "'none'",
                        comment: 'shown',
                    },
                    {
                        id: 'd',
                        name: 'price',
                        type: 'decimal',
                        length: '10,2',
                        nullable: false,
                        default: '0.00',
                    },
                    {
                        id: 'e',
                        name: 'qty',
                        type: 'int',
                        unsigned: true,
                        nullable: false,
                        default: '1',
                    },
                ],
                primaryKey: ['id'],
                uniques: [{ name: 'uq_label', columns: ['label'] }],
                checks: [{ name: 'ck_price', expression: '`price` >= 0' }],
                foreignKeys: [
                    {
                        name: 'fk_owner',
                        columns: ['owner_id'],
                        refTable: 'd_owners',
                        refColumns: ['id'],
                        onDelete: 'SET NULL',
                    },
                ],
                indexes: [
                    { name: 'idx_qty', columns: [{ name: 'qty', order: 'DESC' }], unique: false },
                ],
            };
            await runAll(createTableSql(mysqlDialect, items));

            const read = await describeTable('d_items');
            expect(
                read.columns.map((c) => [
                    c.name,
                    c.type,
                    c.length,
                    c.unsigned,
                    c.nullable,
                    c.autoIncrement,
                ]),
            ).toEqual([
                ['id', 'int', undefined, undefined, false, true],
                ['owner_id', 'int', undefined, undefined, true, undefined],
                ['label', 'varchar', '40', undefined, false, undefined],
                ['price', 'decimal', '10,2', undefined, false, undefined],
                ['qty', 'int', undefined, true, false, undefined],
            ]);
            expect(read.primaryKey).toEqual(['id']);
            expect(read.foreignKeys[0]).toMatchObject({
                name: 'fk_owner',
                refTable: 'd_owners',
                onDelete: 'SET NULL',
            });
            expect(read.uniques.map((u) => u.name)).toContain('uq_label');
            expect(read.comment).toBe('Things');
            // the design read back differs from the one written only in ids: no statements are needed
            expect(alterTableSql(mysqlDialect, read, structuredClone(read))).toEqual([]);

            // change it: rename a column, widen another, drop one, add a column and an index
            const after = structuredClone(read);
            const label = after.columns.find((c) => c.name === 'label')!;
            label.name = 'title';
            label.length = '80';
            after.uniques = after.uniques.map((u) => ({ ...u, columns: ['title'] }));
            after.columns = after.columns.filter((c) => c.name !== 'qty');
            after.indexes = [];
            after.columns.push({
                id: newColumnId(),
                name: 'created',
                type: 'datetime',
                nullable: true,
            });
            after.indexes.push({
                name: 'idx_created',
                columns: [{ name: 'created' }],
                unique: false,
            });
            const statements = alterTableSql(mysqlDialect, read, after);
            await runAll(statements);
            const changed = await describeTable('d_items');
            expect(changed.columns.map((c) => c.name)).toEqual([
                'id',
                'owner_id',
                'title',
                'price',
                'created',
            ]);
            expect(changed.columns.find((c) => c.name === 'title')!.length).toBe('80');
            expect(changed.indexes.map((i) => i.name)).toEqual(['idx_created']);
            expect(changed.uniques[0]!.columns).toEqual(['title']);
            expect(changed.foreignKeys).toHaveLength(1);

            await runAll([
                dropTableSql(mysqlDialect, { database: 'shop', name: 'd_items' }),
                dropTableSql(mysqlDialect, { database: 'shop', name: 'd_owners' }),
            ]);
        },
    );
});

describe('row editing against MySQL', () => {
    live(
        'inserts, reads with filters, updates by key and deletes one row, with awkward values',
        async () => {
            await run('DROP TABLE IF EXISTS r_people');
            await run(
                'CREATE TABLE r_people (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(80), note TEXT, meta JSON, bin BLOB)',
            );
            const table = { database: 'shop', name: 'r_people' };
            await run(
                insertRowSql(mysqlDialect, table, [
                    {
                        column: 'name',
                        value: { kind: 'text', value: "O'Brien \\ back\\slash 100%" },
                    },
                    { column: 'meta', value: { kind: 'json', value: '{"a":[1,2]}' } },
                    { column: 'bin', value: { kind: 'binary', hex: 'DEADBEEF' } },
                ]),
            );
            await run(
                insertRowSql(mysqlDialect, table, [
                    { column: 'name', value: { kind: 'text', value: 'Ünïcode ☃' } },
                ]),
            );
            await run(insertRowSql(mysqlDialect, table, []));
            const all = await rowsOf(
                'SELECT id, name, JSON_EXTRACT(meta, "$.a[1]"), HEX(bin) FROM `shop`.`r_people` ORDER BY id',
            );
            expect(all[0]).toEqual([1, "O'Brien \\ back\\slash 100%", '2', 'DEADBEEF']);
            expect(all[1]![1]).toBe('Ünïcode ☃');
            expect(all[2]![1]).toBeNull();

            const filtered = await rowsOf(
                selectPageSql(mysqlDialect, {
                    table,
                    columns: ['id'],
                    filters: [{ column: 'name', operator: 'contains', value: '100%' }],
                    sort: [{ column: 'id', direction: 'desc' }],
                    limit: 10,
                    offset: 0,
                }),
            );
            expect(filtered).toEqual([[1]]);
            // a percent sign typed as text matches only itself, not "anything"
            expect(
                await rowsOf(
                    selectPageSql(mysqlDialect, {
                        table,
                        columns: ['id'],
                        filters: [{ column: 'name', operator: 'contains', value: '%' }],
                        sort: [],
                        limit: 10,
                        offset: 0,
                    }),
                ),
            ).toEqual([[1]]);

            await run(
                updateRowSql(
                    mysqlDialect,
                    table,
                    [{ column: 'id', value: { kind: 'number', value: '2' } }],
                    [{ column: 'name', value: { kind: 'null' } }],
                ),
            );
            expect(await rowsOf('SELECT name FROM `shop`.`r_people` WHERE id = 2')).toEqual([
                [null],
            ]);
            await run(
                deleteRowSql(mysqlDialect, table, [
                    { column: 'id', value: { kind: 'number', value: '3' } },
                ]),
            );
            expect(await rowsOf('SELECT COUNT(*) FROM `shop`.`r_people`')).toEqual([[2]]);
            await run('DROP TABLE r_people');
        },
    );
});

describe('views, routines and triggers against MySQL', () => {
    live(
        'creates a view, a function, a procedure with OUT parameters and a trigger, and runs the routines',
        async () => {
            await run('DROP TABLE IF EXISTS o_log');
            await run('DROP TABLE IF EXISTS o_src');
            await run('CREATE TABLE o_src (id INT PRIMARY KEY, v INT)');
            await run('CREATE TABLE o_log (n INT)');
            await run(
                createViewSql(
                    mysqlDialect,
                    {
                        database: 'shop',
                        name: 'o_view',
                        query: 'SELECT id FROM o_src WHERE v > 1;',
                    },
                    { replace: true },
                ),
            );
            await run(
                createViewSql(
                    mysqlDialect,
                    {
                        database: 'shop',
                        name: 'o_view',
                        query: 'SELECT id FROM o_src WHERE v > 2;',
                    },
                    { replace: true },
                ),
            );
            const [fn] = createRoutineSql(mysqlDialect, {
                database: 'shop',
                name: 'o_twice',
                kind: 'function',
                parameters: [{ name: 'x', mode: 'IN', type: 'int' }],
                returns: 'int',
                body: 'RETURN x * 2;',
                deterministic: true,
            });
            await run('DROP FUNCTION IF EXISTS o_twice');
            await run(fn!);
            const procedure = createRoutineSql(
                mysqlDialect,
                {
                    database: 'shop',
                    name: 'o_sum',
                    kind: 'procedure',
                    parameters: [
                        { name: 'a', mode: 'IN', type: 'int' },
                        { name: 'total', mode: 'OUT', type: 'int' },
                        { name: 'tag', mode: 'INOUT', type: 'varchar(10)' },
                    ],
                    body: "SET total = a + 10; SET tag = CONCAT(tag, '!');",
                },
                { replace: true },
            );
            for (const statement of procedure) await run(statement);
            await run('DROP TRIGGER IF EXISTS o_trg');
            await runAll(
                createTriggerSql(mysqlDialect, {
                    database: 'shop',
                    name: 'o_trg',
                    table: 'o_src',
                    timing: 'AFTER',
                    events: ['INSERT'],
                    body: 'INSERT INTO o_log VALUES (NEW.v);',
                }),
            );

            await run('INSERT INTO o_src VALUES (1, 1), (2, 5), (3, 9)');
            expect(await rowsOf('SELECT id FROM `shop`.`o_view` ORDER BY id')).toEqual([[2], [3]]);
            expect(await rowsOf('SELECT COUNT(*) FROM o_log')).toEqual([[3]]);
            expect(
                await rowsOf(
                    callStatements(
                        mysqlDialect,
                        {
                            database: 'shop',
                            name: 'o_twice',
                            kind: 'function',
                            parameters: [{ name: 'x', mode: 'IN', type: 'int' }],
                        },
                        { x: { kind: 'number', value: '21' } },
                    )[0]!,
                ),
            ).toEqual([[42]]);

            const definition = await session.getDefinition({
                database: 'shop',
                name: 'o_sum',
                kind: 'procedure',
            });
            const parameters = parametersFromDefinition(mysqlDialect, definition);
            expect(parameters.map((p) => [p.name, p.mode])).toEqual([
                ['a', 'IN'],
                ['total', 'OUT'],
                ['tag', 'INOUT'],
            ]);
            const statements = callStatements(
                mysqlDialect,
                { database: 'shop', name: 'o_sum', kind: 'procedure', parameters },
                { a: { kind: 'number', value: '5' }, tag: { kind: 'text', value: 'hi' } },
            );
            let last: unknown[][] = [];
            for (const statement of statements) last = await rowsOf(statement);
            expect(last).toEqual([[15, 'hi!']]);

            await run(
                createIndexSql(
                    mysqlDialect,
                    { database: 'shop', name: 'o_src' },
                    { name: 'idx_v', columns: [{ name: 'v', order: 'DESC' }], unique: false },
                ),
            );
            expect(
                (await session.listIndexes({ database: 'shop', name: 'o_src' })).map((i) => i.name),
            ).toContain('idx_v');
            await runAll([
                'DROP VIEW o_view',
                'DROP FUNCTION o_twice',
                'DROP PROCEDURE o_sum',
                'DROP TRIGGER o_trg',
                'DROP TABLE o_src',
                'DROP TABLE o_log',
            ]);
        },
    );
});

describe('export and import against MySQL', () => {
    const fill = async (name: string, rows: number) => {
        await run(`DROP TABLE IF EXISTS ${name}`);
        await run(
            `CREATE TABLE ${name} (id INT PRIMARY KEY, name VARCHAR(60), note TEXT, score DECIMAL(8,2), born DATE, flag TINYINT(1), meta JSON)`,
        );
        for (let start = 1; start <= rows; start += 1000) {
            const values: string[] = [];
            for (let i = start; i < Math.min(rows + 1, start + 1000); i++) {
                values.push(
                    `(${i}, 'name ${i}', ${i % 7 === 0 ? 'NULL' : `'line, ${i} "q"\\nnext'`}, ${(i / 4).toFixed(2)}, '2026-01-${String((i % 28) + 1).padStart(2, '0')}', ${i % 2}, '{"i":${i}}')`,
                );
            }
            await run(`INSERT INTO ${name} VALUES ${values.join(',')}`);
        }
    };

    const exportTo = async (
        table: string,
        formatter: Parameters<typeof runExport>[0]['formatter'],
        file: string,
        statement = `SELECT * FROM \`shop\`.\`${table}\``,
    ) => {
        const context = recordingContext();
        const result = await runExport({
            session,
            statement,
            formatter,
            destination: join(dir, file),
            context,
            fetchSize: 500,
        });
        return { result, context };
    };

    const importFrom = async (
        format: 'csv' | 'json' | 'ndjson',
        file: string,
        table: string,
        extra: Partial<Parameters<typeof runImport>[0]> = {},
    ) => {
        const { source } = await openFileSource(join(dir, file));
        const reader = new ChunkReader(source);
        const context = recordingContext();
        try {
            const columns = await session.listColumns({ database: 'shop', name: table });
            const result = await runImport({
                session,
                reader,
                format,
                target: {
                    kind: 'table',
                    dialect: mysqlDialect,
                    table: { database: 'shop', name: table },
                    columns: columns.map((c) => ({ name: c.name, type: c.type })),
                },
                context,
                batchSize: 300,
                ...extra,
            });
            return { result, context };
        } finally {
            await reader.close();
        }
    };

    const snapshot = (table: string) =>
        rowsOf(
            `SELECT id, name, note, CAST(score AS CHAR), CAST(born AS CHAR), flag, CAST(meta AS CHAR) FROM \`shop\`.\`${table}\` ORDER BY id`,
        );

    live('exports a table to CSV, NDJSON and JSON and imports each back unchanged', async () => {
        await fill('t_src', 2500);
        const original = await snapshot('t_src');
        for (const [format, formatter, file] of [
            ['csv', csvFormatter({ nullText: '\\N' }), 'src.csv'],
            ['ndjson', ndjsonFormatter(), 'src.ndjson'],
            ['json', jsonFormatter(), 'src.json'],
        ] as const) {
            const { result } = await exportTo('t_src', formatter, file);
            expect(result.rows).toBe(2500);
            await run('DROP TABLE IF EXISTS t_dst');
            await run('CREATE TABLE t_dst LIKE t_src');
            const imported = await importFrom(
                format,
                file,
                't_dst',
                format === 'csv' ? { csv: { nullToken: '\\N' } } : {},
            );
            expect(imported.result).toMatchObject({ imported: 2500, rejected: 0 });
            const copy = await snapshot('t_dst');
            // JSON text may be re-spaced by the server; everything else must be equal
            const normal = (rows: unknown[][]) =>
                rows.map((r) =>
                    r.map((v) =>
                        typeof v === 'string' && v.startsWith('{')
                            ? JSON.stringify(JSON.parse(v))
                            : v,
                    ),
                );
            expect(normal(copy)).toEqual(normal(original));
        }
        await runAll(['DROP TABLE t_dst', 'DROP TABLE t_src']);
    });

    live('exports a table as SQL and runs the file back through the script executor', async () => {
        await fill('s_src', 750);
        const create = await session.getDefinition({
            database: 'shop',
            name: 's_src',
            kind: 'table',
        });
        await exportTo(
            's_src',
            sqlFormatter({
                dialect: mysqlDialect,
                table: { database: 'shop', name: 's_copy' },
                rowsPerStatement: 100,
                create: create.replace('`s_src`', '`s_copy`'),
                drop: true,
            }),
            's.sql',
        );
        const { source } = await openFileSource(join(dir, 's.sql'));
        const reader = new ChunkReader(source);
        const script = new ScriptRun(session, reader, 'mysql', { onError: 'stop' });
        await script.finished;
        await reader.close();
        expect(script.snapshot()).toMatchObject({ state: 'done', failed: 0 });
        expect(await rowsOf('SELECT COUNT(*) FROM `shop`.`s_copy`')).toEqual([[750]]);
        expect(await rowsOf('SELECT note FROM `shop`.`s_copy` WHERE id = 1')).toEqual([
            ['line, 1 "q"\nnext'],
        ]);
        await runAll(['DROP TABLE s_copy', 'DROP TABLE s_src']);
    });

    live('skips the bad records of a CSV, saves them, and reports record and line', async () => {
        await run('DROP TABLE IF EXISTS c_in');
        await run('CREATE TABLE c_in (id INT PRIMARY KEY, name VARCHAR(5), score DECIMAL(4,1))');
        await writeFile(
            join(dir, 'bad.csv'),
            'id,name,score\n1,ok,1.5\n2,toolongname,2.5\n3,fine,abc\n1,dup,3.5\n4,"a\nb",4.5\n5,good,5.5\n',
        );
        const rejects = await FileSink.create(join(dir, 'bad.rejects.ndjson'));
        const { result, context } = await importFrom('csv', 'bad.csv', 'c_in', {
            onError: 'skip',
            rejects,
            batchSize: 10,
        });
        await rejects.commit();
        expect(result).toMatchObject({ imported: 3, rejected: 3 });
        // Records the parser rejects come first, those the server rejects as their batch is retried:
        // sorted, each bad record is named once with its record number and line.
        expect(
            context.issues
                .map((i) => [i.record, i.line])
                .sort((x, y) => (x[0] as number) - (y[0] as number)),
        ).toEqual([
            [3, 3],
            [4, 4],
            [5, 5],
        ]);
        expect(await rowsOf('SELECT id FROM c_in ORDER BY id')).toEqual([[1], [4], [5]]);
        const messages = context.issues.map((i) => i.message).join(' | ');
        expect(messages).toMatch(/not a number/);
        expect(messages).toMatch(/Data too long|Duplicate entry/);
        const saved = (await readFile(join(dir, 'bad.rejects.ndjson'), 'utf8')).trim().split('\n');
        expect(saved).toHaveLength(3);
        await run('DROP TABLE c_in');
    });

    live('imports in one transaction and rolls everything back when a row fails', async () => {
        await run('DROP TABLE IF EXISTS tx_in');
        await run('CREATE TABLE tx_in (id INT PRIMARY KEY)');
        await writeFile(join(dir, 'tx.csv'), 'id\n1\n2\n2\n3\n');
        await expect(
            importFrom('csv', 'tx.csv', 'tx_in', { transaction: 'all', batchSize: 1 }),
        ).rejects.toThrow(/rolled back/);
        expect(await rowsOf('SELECT COUNT(*) FROM tx_in')).toEqual([[0]]);
        const ok = await importFrom('csv', 'tx.csv', 'tx_in', {
            transaction: 'batch',
            onError: 'skip',
            batchSize: 2,
        });
        expect(ok.result.imported).toBe(3);
        await run('DROP TABLE tx_in');
    });

    live('streams a large table out and back in without holding it', async () => {
        await fill('big_src', 120_000);
        const before = process.memoryUsage().heapUsed;
        const { result } = await exportTo('big_src', csvFormatter(), 'big.csv');
        expect(result.rows).toBe(120_000);
        await run('DROP TABLE IF EXISTS big_dst');
        await run('CREATE TABLE big_dst LIKE big_src');
        const imported = await importFrom('csv', 'big.csv', 'big_dst', { batchSize: 1000 });
        expect(imported.result.imported).toBe(120_000);
        expect(await rowsOf('SELECT COUNT(*), SUM(id) FROM big_dst')).toEqual([
            [120_000, '7200060000'],
        ]);
        expect(process.memoryUsage().heapUsed - before).toBeLessThan(300 * 1024 * 1024);
        await runAll(['DROP TABLE big_dst', 'DROP TABLE big_src']);
    });
});
