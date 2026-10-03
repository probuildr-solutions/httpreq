/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

// @vitest-environment node
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DbError } from '@httpreq/db-core';
import { mysqlDialect, postgresDialect } from '@httpreq/db-admin';
import { CsvParser } from './csv';
import { runExport } from './exportRun';
import {
    bsonFormatter,
    csvFormatter,
    jsonFormatter,
    ndjsonFormatter,
    sqlFormatter,
    type ExportFormatter,
} from './formatters';
import { FakeSession, recordingContext } from './testing';

let directory: string;
beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'httpreq-export-'));
});
afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
});

const columns = [
    { name: 'id', type: 'int' },
    { name: 'name', type: 'varchar(20)' },
    { name: 'note', type: 'text' },
];
const row = (i: number) => [i + 1, `name ${i}`, i % 3 === 0 ? null : `line ${i}, "quoted"\nnext`];

const exportTo = async (
    formatter: ExportFormatter,
    file: string,
    rowCount = 5,
    extra: Partial<Parameters<typeof runExport>[0]> = {},
) => {
    const session = new FakeSession({ columns, rowCount, row, pageRows: 2 });
    const context = recordingContext();
    const destination = join(directory, file);
    const result = await runExport({
        session: session.asSession(),
        statement: 'SELECT * FROM t',
        formatter,
        destination,
        context,
        ...extra,
    });
    return { result, text: await readFile(destination, 'utf8'), context, session };
};

describe('export formats', () => {
    it('writes CSV that the CSV parser reads back, with a header', async () => {
        const { result, text } = await exportTo(csvFormatter(), 'out.csv');
        expect(result.rows).toBe(5);
        const records: string[][] = [];
        const parser = new CsvParser({ onRecord: (f) => void records.push(f) });
        parser.feed(text);
        parser.finish();
        expect(records[0]).toEqual(['id', 'name', 'note']);
        expect(records).toHaveLength(6);
        expect(records[2]).toEqual(['2', 'name 1', 'line 1, "quoted"\nnext']);
        expect(records[1]![2]).toBe('');
    });

    it('writes CSV with another delimiter, no header and a byte order mark', async () => {
        const { text } = await exportTo(
            csvFormatter({ delimiter: ';', header: false, bom: true, eol: '\n' }),
            'o.csv',
            2,
        );
        expect(text.startsWith('﻿1;name 0;\n2;')).toBe(true);
    });

    it('writes a JSON array of objects, with an empty table as []', async () => {
        const { text } = await exportTo(jsonFormatter(), 'out.json');
        const parsed = JSON.parse(text);
        expect(parsed).toHaveLength(5);
        expect(parsed[0]).toEqual({ id: 1, name: 'name 0', note: null });
        const empty = await exportTo(jsonFormatter(), 'empty.json', 0);
        expect(JSON.parse(empty.text)).toEqual([]);
    });

    it('writes NDJSON, one object per line', async () => {
        const { text } = await exportTo(ndjsonFormatter(), 'out.ndjson');
        const lines = text.trimEnd().split('\n');
        expect(lines).toHaveLength(5);
        expect(JSON.parse(lines[4]!)).toEqual({
            id: 5,
            name: 'name 4',
            note: 'line 4, "quoted"\nnext',
        });
    });

    it('writes SQL INSERT statements, batched, with the table definition first', async () => {
        const { text } = await exportTo(
            sqlFormatter({
                dialect: mysqlDialect,
                table: { database: 'shop', name: 'people' },
                rowsPerStatement: 2,
                create: 'CREATE TABLE `people` (`id` int)',
                drop: true,
            }),
            'out.sql',
        );
        expect(text).toContain('DROP TABLE IF EXISTS `shop`.`people`;');
        expect(text).toContain('CREATE TABLE `people` (`id` int);');
        expect(text.match(/^INSERT INTO/gm)).toHaveLength(3);
        expect(text).toContain("(2, 'name 1', 'line 1, \"quoted\"\nnext')");
        expect(text).toContain("(1, 'name 0', NULL)");
        const pg = await exportTo(
            sqlFormatter({ dialect: postgresDialect, table: { schema: 's', name: 't' } }),
            'pg.sql',
            1,
        );
        expect(pg.text).toContain('INSERT INTO "s"."t" ("id", "name", "note") VALUES');
    });

    it('writes BSON documents back to back with length prefixes', async () => {
        const session = new FakeSession({
            columns: [{ name: 'document', type: 'object' }],
            rowCount: 3,
            row: (i) => [{ n: i, s: 'x' }],
            pageRows: 2,
        });
        const destination = join(directory, 'out.bson');
        await runExport({
            session: session.asSession(),
            statement: 'find',
            formatter: bsonFormatter(),
            destination,
            context: recordingContext(),
        });
        const bytes = await readFile(destination);
        let offset = 0;
        let count = 0;
        while (offset < bytes.length) {
            offset += bytes.readInt32LE(offset);
            count++;
        }
        expect(count).toBe(3);
        expect(offset).toBe(bytes.length);
    });
});

describe('export behaviour', () => {
    it('reports progress and leaves no temporary file behind', async () => {
        const { context } = await exportTo(csvFormatter(), 'p.csv', 10_000);
        expect(context.reports.at(-1)).toMatchObject({ rowsProcessed: 10_000 });
        expect(await readdir(directory)).toEqual(['p.csv']);
    });

    it('streams a million rows without holding them: the producer never runs ahead of the writer', async () => {
        const session = new FakeSession({ columns, rowCount: 1_000_000, row, pageRows: 1000 });
        const destination = join(directory, 'big.ndjson');
        const before = process.memoryUsage().heapUsed;
        const result = await runExport({
            session: session.asSession(),
            statement: 'SELECT *',
            formatter: ndjsonFormatter(),
            destination,
            context: recordingContext(),
        });
        const growth = process.memoryUsage().heapUsed - before;
        expect(result.rows).toBe(1_000_000);
        expect(session.maxAhead).toBeLessThanOrEqual(1000);
        // The file is large; the heap is not.
        expect((await stat(destination)).size).toBeGreaterThan(50_000_000);
        expect(growth).toBeLessThan(80 * 1024 * 1024);
        let lines = 0;
        for await (const line of createInterface({ input: createReadStream(destination) }))
            lines += line.length > 0 ? 1 : 0;
        expect(lines).toBe(1_000_000);
    }, 120_000);

    it('removes the partial file and stops the statement when cancelled', async () => {
        const session = new FakeSession({ columns, rowCount: 1_000_000, row, pageRows: 100 });
        const context = recordingContext();
        const destination = join(directory, 'cancelled.csv');
        const running = runExport({
            session: session.asSession(),
            statement: 'SELECT *',
            formatter: csvFormatter(),
            destination,
            context,
        });
        await new Promise((resolve) => setTimeout(resolve, 20));
        context.abort();
        await expect(running).rejects.toMatchObject({ code: 'CANCELLED' });
        expect(session.cancelled).toBe(true);
        expect(await readdir(directory)).toEqual([]);
        expect(session.produced).toBeLessThan(1_000_000);
    });

    it('explains a lost connection with the row count, and removes the file', async () => {
        const session = new FakeSession({
            columns,
            rowCount: 10_000,
            row,
            pageRows: 100,
            failAfter: { rows: 1500, error: new DbError('CONNECTION_FAILED', 'socket closed') },
        });
        await expect(
            runExport({
                session: session.asSession(),
                statement: 'SELECT *',
                formatter: csvFormatter(),
                destination: join(directory, 'lost.csv'),
                context: recordingContext(),
                fetchSize: 100,
            }),
        ).rejects.toThrow(/lost after 1,500 rows. The incomplete file was removed/);
        expect(await readdir(directory)).toEqual([]);
    });

    it('fails at the start when the destination folder is gone or too small', async () => {
        const session = new FakeSession({ columns, rowCount: 10, row });
        await expect(
            runExport({
                session: session.asSession(),
                statement: 's',
                formatter: csvFormatter(),
                destination: join(directory, 'nope', 'x.csv'),
                context: recordingContext(),
            }),
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
        expect(session.statements).toEqual([]);
        await expect(
            runExport({
                session: session.asSession(),
                statement: 's',
                formatter: csvFormatter(),
                destination: join(directory, 'x.csv'),
                context: recordingContext(),
                estimatedBytes: Number.MAX_SAFE_INTEGER / 2,
            }),
        ).rejects.toThrow(/not enough free space/);
    });

    it('rejects a statement that returns no rows', async () => {
        const session = new FakeSession({ columns: [], rowCount: 0, row });
        session.execute = () => ({
            [Symbol.asyncIterator]: async function* () {
                yield { kind: 'end' as const, affectedRows: 3 };
            },
            cancel: async () => undefined,
        });
        await expect(
            runExport({
                session: session.asSession(),
                statement: 'UPDATE t SET a=1',
                formatter: csvFormatter(),
                destination: join(directory, 'n.csv'),
                context: recordingContext(),
            }),
        ).rejects.toThrow(/does not return rows/);
        expect(await readdir(directory)).toEqual([]);
    });
});
