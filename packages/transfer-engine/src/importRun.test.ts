/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    DbError,
    type ExecuteOptions,
    type Execution,
    type RelationalSession,
} from '@httpreq/db-core';
import { encodeDocument } from '@httpreq/db-protocol-mongo';
import { mysqlDialect, postgresDialect } from '@httpreq/db-admin';
import {
    ChunkReader,
    FileSink,
    MemorySource,
    PatternSource,
    type ByteSource,
} from '@httpreq/file-engine';
import {
    runImport,
    fieldToSqlValue,
    type ImportCheckpoint,
    type ImportRunOptions,
} from './importRun';
import { recordingContext } from './testing';

/** A session that records statements, and fails the ones a test says should fail. */
class ImportSession {
    statements: string[] = [];
    failWhen: (sql: string) => Error | null = () => null;
    delayMs = 0;
    execute(sql: string, options?: ExecuteOptions): Execution {
        void options;
        this.statements.push(sql);
        const failure = this.failWhen(sql);
        const delay = this.delayMs;
        const generator = (async function* () {
            if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
            if (failure) throw failure;
            yield { kind: 'end' as const, affectedRows: 1 };
        })();
        return { [Symbol.asyncIterator]: () => generator, cancel: async () => undefined };
    }
    asSession(): RelationalSession {
        return this as unknown as RelationalSession;
    }
    /** Rows written by INSERTs (VALUES lines) and documents by insertMany. */
    get insertedRows(): number {
        return this.statements
            .filter((s) => s.startsWith('INSERT'))
            .reduce((n, s) => n + (s.match(/^\(/gm)?.length ?? 0), 0);
    }
    get inserts(): string[] {
        return this.statements.filter((s) => s.startsWith('INSERT') || s.includes('insertMany'));
    }
}

const people = {
    kind: 'table' as const,
    dialect: mysqlDialect,
    table: { database: 'shop', name: 'people' },
    columns: [
        { name: 'id', type: 'int' },
        { name: 'Name', type: 'varchar(50)' },
        { name: 'score', type: 'decimal(5,2)' },
        { name: 'meta', type: 'json' },
    ],
};

const reader = (text: string) => new ChunkReader(MemorySource.text(text), 16);

let directory: string;
beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'httpreq-import-'));
});
afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
});

const run = (session: ImportSession, text: string, extra: Partial<ImportRunOptions> = {}) => {
    const context = recordingContext();
    const promise = runImport({
        session: session.asSession(),
        reader: reader(text),
        format: 'csv',
        target: people,
        context,
        batchSize: 2,
        ...extra,
    });
    return { promise, context };
};

describe('field conversion', () => {
    it('reads each field for the type of its column', () => {
        expect(fieldToSqlValue('int', ' 42 ')).toEqual({ kind: 'number', value: '42' });
        expect(() => fieldToSqlValue('int', 'abc')).toThrow(/is not a number/);
        expect(fieldToSqlValue('int', '')).toEqual({ kind: 'null' });
        expect(fieldToSqlValue('varchar(5)', '')).toEqual({ kind: 'text', value: '' });
        expect(fieldToSqlValue('varchar(5)', '', { emptyAsNull: true })).toEqual({ kind: 'null' });
        expect(fieldToSqlValue('varchar(5)', 'NULL', { nullToken: 'NULL' })).toEqual({
            kind: 'null',
        });
        expect(fieldToSqlValue('boolean', 'Yes')).toEqual({ kind: 'boolean', value: true });
        expect(() => fieldToSqlValue('boolean', 'maybe')).toThrow();
        expect(() => fieldToSqlValue('json', '{oops')).toThrow(/JSON/);
        expect(fieldToSqlValue('blob', '0xDEAD')).toEqual({ kind: 'binary', hex: 'DEAD' });
        expect(() => fieldToSqlValue('blob', 'xyz')).toThrow();
    });
});

describe('CSV into a table', () => {
    const csv = 'ID,name,score,ignored\n1,Ada,9.5,x\n2,"Bob, Jr.",,y\n3,Cy,7,z\n';

    it('batches rows into multi-row INSERTs, mapping columns by name and typing the values', async () => {
        const session = new ImportSession();
        const { promise, context } = run(session, csv);
        const result = await promise;
        expect(result).toMatchObject({ imported: 3, rejected: 0 });
        // `ignored` has no column; batch 1 has two rows, batch 2 has one; each its own transaction
        expect(session.statements).toEqual([
            'START TRANSACTION',
            "INSERT INTO `shop`.`people` (`id`, `Name`, `score`) VALUES\n(1, 'Ada', 9.5),\n(2, 'Bob, Jr.', NULL)",
            'COMMIT',
            'START TRANSACTION',
            "INSERT INTO `shop`.`people` (`id`, `Name`, `score`) VALUES\n(3, 'Cy', 7)",
            'COMMIT',
        ]);
        expect(context.reports.at(-1)).toMatchObject({ rowsProcessed: 3 });
    });

    it('truncates first when asked, and works without transactions', async () => {
        const session = new ImportSession();
        await run(session, csv, { mode: 'truncate', transaction: 'none' }).promise;
        expect(session.statements[0]).toBe('TRUNCATE TABLE `shop`.`people`');
        expect(session.statements.filter((s) => /TRANSACTION|COMMIT|BEGIN/.test(s))).toEqual([]);
    });

    it('reports records it cannot read with record and line, and keeps importing when told to skip', async () => {
        const text = 'id,name,score\n1,Ada,9.5\nx,Bad,1\n3,"multi\nline",2\n4,Short\n5,Eve,3\n';
        const session = new ImportSession();
        const rejects = await FileSink.create(join(directory, 'rejects.ndjson'));
        const { promise, context } = run(session, text, { onError: 'skip', rejects });
        const result = await promise;
        await rejects.commit();
        expect(result).toMatchObject({ imported: 3, rejected: 2 });
        expect(context.issues).toEqual([
            { record: 3, line: 3, message: '“x” is not a number (column type int).' },
            { record: 5, line: 6, message: 'Expected 3 fields but found 2.' },
        ]);
        const lines = (await readFile(join(directory, 'rejects.ndjson'), 'utf8'))
            .trim()
            .split('\n')
            .map((l) => JSON.parse(l));
        expect(lines[0]).toMatchObject({ record: 3, line: 3, data: ['x', 'Bad', '1'] });
        expect(session.insertedRows).toBe(3);
    });

    it('stops at the first bad record when told to stop, naming it', async () => {
        const session = new ImportSession();
        const { promise } = run(session, 'id,name,score\n1,Ada,1\nx,Bad,1\n', { onError: 'stop' });
        await expect(promise).rejects.toThrow(/stopped at record 3 \(line 3\)/);
    });

    it('refuses a file whose columns match nothing in the table', async () => {
        const { promise } = run(new ImportSession(), 'foo,bar\n1,2\n');
        await expect(promise).rejects.toThrow(/None of the columns in the file match/);
    });

    it('applies an explicit column mapping', async () => {
        const session = new ImportSession();
        await run(session, 'ident,who\n1,Ada\n', {
            csv: { columnMap: { ident: 'id', who: 'Name' } },
            transaction: 'none',
        }).promise;
        expect(session.inserts[0]).toContain('(`id`, `Name`)');
    });

    it('imports a file with no header into the table’s columns in order', async () => {
        const session = new ImportSession();
        await run(session, '1,Ada,5\n', { csv: { header: false }, transaction: 'none' }).promise;
        expect(session.inserts[0]).toBe(
            "INSERT INTO `shop`.`people` (`id`, `Name`, `score`) VALUES\n(1, 'Ada', 5)",
        );
    });

    it('reads a file with a byte order mark, Windows line endings and another delimiter', async () => {
        const session = new ImportSession();
        const result = await run(session, '﻿id;name\r\n1;Ada\r\n2;Bob\r\n', { transaction: 'none' })
            .promise;
        expect(result.imported).toBe(2);
    });
});

describe('failures at the database', () => {
    const text = 'id,name,score\n1,A,1\n2,BAD,1\n3,C,1\n4,D,1\n';

    it('finds the failing row by writing the failed batch one row at a time', async () => {
        const session = new ImportSession();
        session.failWhen = (sql) =>
            sql.includes("'BAD'") && sql.startsWith('INSERT')
                ? new DbError('QUERY_FAILED', 'Data too long for column')
                : null;
        const { promise, context } = run(session, text, { onError: 'skip', transaction: 'none' });
        const result = await promise;
        expect(result).toMatchObject({ imported: 3, rejected: 1 });
        expect(context.issues[0]).toMatchObject({
            record: 3,
            line: 3,
            message: 'Data too long for column',
        });
    });

    it('rolls a failed batch back before retrying it row by row', async () => {
        const session = new ImportSession();
        session.failWhen = (sql) =>
            sql.includes("'BAD'") && sql.includes('),\n(')
                ? new DbError('QUERY_FAILED', 'duplicate')
                : null;
        await run(session, text, { onError: 'skip', transaction: 'batch' }).promise;
        const first = session.statements.slice(0, 4);
        expect(first[0]).toBe('START TRANSACTION');
        expect(first[2]).toBe('ROLLBACK');
    });

    it('stops with the range of records when told to stop', async () => {
        const session = new ImportSession();
        session.failWhen = (sql) =>
            sql.includes("'BAD'") && sql.startsWith('INSERT')
                ? new DbError('QUERY_FAILED', 'boom')
                : null;
        await expect(
            run(session, text, { onError: 'stop', transaction: 'none' }).promise,
        ).rejects.toThrow(/records 2 to 3: boom/);
    });

    it('rolls the whole import back in single-transaction mode', async () => {
        const session = new ImportSession();
        session.failWhen = (sql) =>
            sql.includes("'BAD'") ? new DbError('QUERY_FAILED', 'boom') : null;
        await expect(
            run(session, text, { transaction: 'all', onError: 'skip' }).promise,
        ).rejects.toThrow(/Everything was rolled back/);
        expect(session.statements[0]).toBe('START TRANSACTION');
        expect(session.statements.at(-1)).toBe('ROLLBACK');
        expect(session.statements).not.toContain('COMMIT');
    });

    it('commits once at the end in single-transaction mode', async () => {
        const session = new ImportSession();
        await run(session, text, { transaction: 'all' }).promise;
        expect(session.statements.filter((s) => s === 'START TRANSACTION')).toHaveLength(1);
        expect(session.statements.at(-1)).toBe('COMMIT');
    });

    it('uses BEGIN on PostgreSQL', async () => {
        const session = new ImportSession();
        await run(session, text, {
            target: {
                ...people,
                dialect: postgresDialect,
                table: { schema: 'public', name: 'people' },
            },
        }).promise;
        expect(session.statements[0]).toBe('BEGIN');
        expect(session.inserts[0]).toContain('INSERT INTO "public"."people"');
    });
});

describe('JSON, NDJSON and BSON', () => {
    it('imports a JSON array and NDJSON into a table, ignoring unknown keys and defaulting missing ones', async () => {
        const array =
            '[{"id":1,"Name":"Ada","extra":true},{"id":2,"meta":{"a":[1,2]}},{"nothing":1},[1],"x"]';
        const session = new ImportSession();
        const { promise, context } = run(session, array, {
            format: 'json',
            onError: 'skip',
            transaction: 'none',
            batchSize: 10,
        });
        const result = await promise;
        expect(result).toMatchObject({ imported: 2, rejected: 3 });
        expect(session.inserts[0]).toBe(
            "INSERT INTO `shop`.`people` (`id`, `Name`, `meta`) VALUES\n(1, 'Ada', DEFAULT),\n(2, DEFAULT, '{\"a\":[1,2]}')",
        );
        expect(context.issues.map((i) => i.record)).toEqual([3, 4, 5]);

        const nd = new ImportSession();
        await run(nd, '{"id":1}\n{"id":2}\n', {
            format: 'ndjson',
            transaction: 'none',
            batchSize: 10,
        }).promise;
        expect(nd.insertedRows).toBe(2);
    });

    it('reports malformed JSON with its record and line and carries on', async () => {
        const session = new ImportSession();
        const { promise, context } = run(session, '{"id":1}\n{"id": oops}\n{"id":3}\n', {
            format: 'ndjson',
            onError: 'skip',
            transaction: 'none',
        });
        expect(await promise).toMatchObject({ imported: 2, rejected: 1 });
        expect(context.issues[0]).toMatchObject({ record: 2, line: 2 });
        expect(context.issues[0]!.message).toMatch(/Not valid JSON/);
    });

    it('imports documents into a collection as insertMany, keeping BSON types written as extended JSON', async () => {
        const session = new ImportSession();
        const text =
            '[{"_id":{"$oid":"507f1f77bcf86cd799439011"},"when":{"$date":"2026-01-01T00:00:00Z"},"n":{"$numberLong":"5"}},{"name":"x"}]';
        const { promise } = run(session, text, {
            format: 'json',
            target: { kind: 'collection', database: 'shop', collection: 'orders' },
            batchSize: 10,
        });
        await promise;
        expect(session.inserts).toHaveLength(1);
        expect(session.inserts[0]).toContain(
            'db.getSiblingDB("shop").getCollection("orders").insertMany([',
        );
        expect(session.inserts[0]).toContain('ObjectId("507f1f77bcf86cd799439011")');
        expect(session.inserts[0]).toContain('ISODate("2026-01-01T00:00:00.000Z")');
        expect(session.inserts[0]).toContain('NumberLong("5")');
        expect(session.inserts[0]).toContain('{ ordered: false }');
    });

    it('imports a BSON file, one document per record', async () => {
        const docs = [{ a: 1, s: 'x' }, { a: 2, s: 'y' }, { a: 3 }];
        const bytes = new Uint8Array(Buffer.concat(docs.map((d) => encodeDocument(d as never))));
        const session = new ImportSession();
        const context = recordingContext();
        const result = await runImport({
            session: session.asSession(),
            reader: new ChunkReader(new MemorySource(bytes), 7),
            format: 'bson',
            target: { kind: 'collection', collection: 'c' },
            context,
            batchSize: 2,
        });
        expect(result.imported).toBe(3);
        expect(session.inserts).toHaveLength(2);
        expect(session.inserts[0]).toContain('{ a: 1, s: "x" }');
    });

    it('rejects CSV into a collection and BSON into a table', async () => {
        await expect(
            run(new ImportSession(), 'a\n1\n', { target: { kind: 'collection', collection: 'c' } })
                .promise,
        ).rejects.toThrow(/only be imported into a table/);
        await expect(run(new ImportSession(), 'x', { format: 'bson' }).promise).rejects.toThrow(
            /only be imported into a collection/,
        );
    });
});

describe('resuming, progress and cancelling', () => {
    const rows = Array.from({ length: 50 }, (_, i) => `${i + 1},name ${i + 1},${i}`);
    const text = `id,name,score\n${rows.join('\n')}\n`;

    it('resumes from the last checkpoint without repeating or skipping a record', async () => {
        const first = new ImportSession();
        let batches = 0;
        first.failWhen = (sql) =>
            sql.startsWith('INSERT') && ++batches === 4
                ? new DbError('CONNECTION_FAILED', 'lost')
                : null;
        const one = run(first, text, { batchSize: 5, transaction: 'none' });
        await expect(one.promise).rejects.toThrow(/lost/);
        const checkpoint = one.context.checkpoints.at(-1) as ImportCheckpoint;
        expect(checkpoint).toMatchObject({ record: 17, header: ['id', 'name', 'score'] });

        const second = new ImportSession();
        const two = run(second, text, { batchSize: 5, transaction: 'none', resume: checkpoint });
        const result = await two.promise;
        expect(first.insertedRows - 5 /* the failed batch */ + second.insertedRows).toBe(50);
        expect(result.imported).toBe(35);
        expect(second.inserts[0]).toContain("(16, 'name 16', 15)");
        expect(second.inserts[0]).not.toContain("(15, 'name 15'");
    });

    it('does not resume a single-transaction import', async () => {
        await expect(
            run(new ImportSession(), text, {
                transaction: 'all',
                resume: { byteOffset: 5, record: 2, line: 2 },
            }).promise,
        ).rejects.toThrow(/cannot be resumed/);
    });

    it('reports bytes read and rows written, ending at the size of the file', async () => {
        const { promise, context } = run(new ImportSession(), text, {
            batchSize: 10,
            transaction: 'none',
        });
        await promise;
        const bytes = context.reports
            .map((r) => r.bytesProcessed)
            .filter((n): n is number => typeof n === 'number');
        expect(bytes).toEqual([...bytes].sort((a, b) => a - b));
        expect(bytes.at(-1)).toBe(Buffer.byteLength(text));
        expect(context.reports.find((r) => r.totalBytes)).toMatchObject({
            totalBytes: Buffer.byteLength(text),
        });
    });

    it('stops when cancelled and imports no more', async () => {
        const session = new ImportSession();
        session.delayMs = 5;
        const { promise, context } = run(session, text, { batchSize: 5, transaction: 'none' });
        setTimeout(() => context.abort(), 12);
        await expect(promise).rejects.toMatchObject({ code: 'CANCELLED' });
        expect(session.insertedRows).toBeLessThan(50);
    });
});

/** A header followed by a repeating row, as a file of any size. */
class SyntheticCsv implements ByteSource {
    readonly mtimeMs = 1;
    private readonly head = Buffer.from('id,name,score\n');
    private readonly inner: PatternSource;
    readonly size: number;
    constructor(rowBytes: number, pattern: Uint8Array) {
        this.inner = new PatternSource(rowBytes, pattern);
        this.size = this.head.length + rowBytes;
    }
    async readInto(target: Uint8Array, length: number, position: number): Promise<number> {
        let written = 0;
        if (position < this.head.length) {
            const part = this.head.subarray(position, position + length);
            target.set(part);
            written = part.length;
        }
        if (written < length) {
            const read = await this.inner.readInto(
                target.subarray(written),
                length - written,
                Math.max(0, position - this.head.length),
            );
            written += read;
        }
        return written;
    }
    async close() {}
}

describe('large inputs', () => {
    const row = Buffer.from('7,some name here,12.5\n');

    it('moves millions of rows through bounded memory', async () => {
        const rowsWanted = 2_000_000;
        const source = new SyntheticCsv(row.length * rowsWanted, row);
        const session = new ImportSession();
        // The session keeps no statements, only counts, as a database would not keep them either.
        let rowsSeen = 0;
        let largest = 0;
        session.execute = (sql: string) => {
            largest = Math.max(largest, sql.length);
            if (sql.startsWith('INSERT')) rowsSeen += sql.split('\n').length - 1;
            return {
                [Symbol.asyncIterator]: async function* () {
                    yield { kind: 'end' as const };
                },
                cancel: async () => undefined,
            } as Execution;
        };
        const before = process.memoryUsage().heapUsed;
        const result = await runImport({
            session: session.asSession(),
            reader: new ChunkReader(source),
            format: 'csv',
            target: people,
            context: recordingContext(),
            batchSize: 1000,
            transaction: 'none',
        });
        const growth = process.memoryUsage().heapUsed - before;
        expect(result.imported).toBe(rowsWanted);
        expect(rowsSeen).toBe(rowsWanted);
        expect(largest).toBeLessThan(4 * 1024 * 1024);
        expect(growth).toBeLessThan(150 * 1024 * 1024);
    }, 300_000);

    it.skipIf(!process.env.HTTPREQ_HEAVY)(
        'moves gigabytes through the pipeline (HTTPREQ_HEAVY=1, HTTPREQ_HEAVY_GB=n)',
        async () => {
            const gigabytes = Number(process.env.HTTPREQ_HEAVY_GB ?? 1);
            const rowsWanted = Math.floor((gigabytes * 1024 * 1024 * 1024) / row.length);
            let peakRss = 0;
            const sampler = setInterval(
                () => (peakRss = Math.max(peakRss, process.memoryUsage().rss)),
                500,
            );
            const source = new SyntheticCsv(row.length * rowsWanted, row);
            const session = new ImportSession();
            let count = 0;
            session.execute = (sql: string) => {
                if (sql.startsWith('INSERT')) count += sql.split('\n').length - 1;
                return {
                    [Symbol.asyncIterator]: async function* () {
                        yield { kind: 'end' as const };
                    },
                    cancel: async () => undefined,
                } as Execution;
            };
            const started = Date.now();
            const result = await runImport({
                session: session.asSession(),
                reader: new ChunkReader(source),
                format: 'csv',
                target: people,
                context: recordingContext(),
                batchSize: 1000,
                transaction: 'none',
            });
            clearInterval(sampler);
            console.info(
                `${gigabytes} GB CSV: ${result.imported} rows in ${((Date.now() - started) / 1000).toFixed(1)} s, peak resident ${(peakRss / 1048576).toFixed(0)} MB`,
            );
            expect(count).toBe(rowsWanted);
        },
        7_200_000,
    );
});
