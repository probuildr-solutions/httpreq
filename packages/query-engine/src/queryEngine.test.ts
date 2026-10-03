/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

// @vitest-environment node
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    DbError,
    type DbValue,
    type Execution,
    type RelationalSession,
    type ResultEvent,
} from '@httpreq/db-core';
import { ChunkReader, MemorySource } from '@httpreq/file-engine';
import { QueryRun, ScriptRun, splitStatements, statementAt, streamStatements } from './index';

let directory: string;
beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'hr-query-'));
});
afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
});

/** A session that plays back scripted events, and records how far the run pulled. */
class FakeSession {
    pulled = 0;
    cancelled = 0;
    executed: string[] = [];
    /** Resolves when a statement is cancelled, like a server ending a killed statement. */
    private release: () => void = () => undefined;
    readonly stopped = new Promise<void>((resolve) => (this.release = resolve));
    constructor(
        private readonly script: (sql: string) => AsyncGenerator<ResultEvent> | ResultEvent[],
    ) {}

    execute(sql: string): Execution {
        this.executed.push(sql);
        const source = this.script(sql);
        // eslint-disable-next-line @typescript-eslint/no-this-alias -- used inside a generator function
        const self = this;
        let stopped = false;
        const iterate = async function* (): AsyncGenerator<ResultEvent> {
            for await (const event of source as AsyncIterable<ResultEvent>) {
                if (stopped) throw new DbError('CANCELLED', 'cancelled');
                if (event.kind === 'rows') self.pulled += event.rows.length;
                yield event;
            }
            if (stopped) throw new DbError('CANCELLED', 'cancelled');
        };
        return Object.assign(iterate(), {
            cancel: async () => {
                stopped = true;
                self.cancelled++;
                self.release();
            },
        });
    }
}

const asSession = (fake: FakeSession) => fake as unknown as RelationalSession;

async function* rowsOf(total: number, pageRows = 100): AsyncGenerator<ResultEvent> {
    yield { kind: 'columns', columns: [{ name: 'n', type: 'int' }] };
    for (let at = 0; at < total; at += pageRows) {
        yield {
            kind: 'rows',
            rows: Array.from({ length: Math.min(pageRows, total - at) }, (_, i): DbValue[] => [
                at + i,
            ]),
        };
        await new Promise((resolve) => setImmediate(resolve));
    }
    yield { kind: 'end', rowCount: total };
}

const settle = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));
const end = (extra: Partial<Extract<ResultEvent, { kind: 'end' }>> = {}): ResultEvent => ({
    kind: 'end',
    ...extra,
});

describe('splitStatements', () => {
    it('gives character offsets, strips the terminator and leaves out client commands', () => {
        const text =
            "SELECT 'é日本';\nDELIMITER $$\nCREATE PROCEDURE p() BEGIN SELECT 1; END$$\nDELIMITER ;\nSELECT 2";
        const statements = splitStatements(text, 'mysql');
        expect(statements.map((s) => s.sql)).toEqual([
            "SELECT 'é日本'",
            'CREATE PROCEDURE p() BEGIN SELECT 1; END',
            'SELECT 2',
        ]);
        // The offsets index the original text, whatever the characters' byte widths.
        expect(text.slice(statements[0]!.start, statements[0]!.end)).toBe("SELECT 'é日本';");
        expect(text.slice(statements[2]!.start, statements[2]!.end).trim()).toBe('SELECT 2');
    });

    it('finds the statement at the cursor, or the nearest one before it', () => {
        const text = 'SELECT 1;\n\nSELECT 2;\n-- tail';
        expect(statementAt(text, 3, 'mysql')?.sql).toBe('SELECT 1');
        expect(statementAt(text, 12, 'mysql')?.sql).toBe('SELECT 2');
        expect(statementAt(text, text.length, 'mysql')?.sql).toBe('SELECT 2');
        expect(statementAt('   ', 1, 'mysql')).toBeNull();
    });
});

describe('streamStatements', () => {
    const script = [
        'CREATE TABLE a (x INT);',
        'INSERT INTO a VALUES (1), (2); -- trailing ; comment',
        'DELIMITER //',
        'CREATE PROCEDURE p() BEGIN SELECT 1; END//',
        'DELIMITER ;',
        "INSERT INTO a VALUES ('é;日本');",
        'SELECT * FROM a',
    ].join('\n');

    const collect = async (chunkSize: number, start?: number) => {
        const reader = new ChunkReader(MemorySource.text(script), chunkSize);
        const out = [];
        for await (const statement of streamStatements(reader, 'mysql', { start })) {
            out.push(statement);
        }
        return out;
    };

    it('yields the same statements for every chunk size, with lines and delimiters handled', async () => {
        const whole = await collect(1_000_000);
        expect(whole.map((s) => s.sql)).toEqual([
            'CREATE TABLE a (x INT)',
            'INSERT INTO a VALUES (1), (2)',
            'CREATE PROCEDURE p() BEGIN SELECT 1; END',
            "INSERT INTO a VALUES ('é;日本')",
            'SELECT * FROM a',
        ]);
        expect(whole.map((s) => s.line)).toEqual([1, 2, 4, 6, 7]);
        expect(whole.map((s) => s.index)).toEqual([0, 1, 2, 3, 4]);
        for (const chunkSize of [1, 2, 5, 13, 64]) {
            const got = await collect(chunkSize);
            expect(
                got.map((s) => [s.sql, s.line]),
                `chunk ${chunkSize}`,
            ).toEqual(whole.map((s) => [s.sql, s.line]));
        }
    });

    it('can start part-way through, at the beginning of a statement', async () => {
        const second = script.indexOf('INSERT INTO a VALUES (1)');
        const got = await collect(7, second);
        expect(got.map((s) => s.sql)[0]).toBe('INSERT INTO a VALUES (1), (2)');
        expect(got).toHaveLength(4);
    });

    it('flags a script that ends inside a quote', async () => {
        const reader = new ChunkReader(MemorySource.text("SELECT 1; SELECT 'oops"), 8);
        const out = [];
        for await (const statement of streamStatements(reader, 'mysql')) out.push(statement);
        expect(out.map((s) => s.malformed)).toEqual([false, true]);
    });

    it('is cancellable', async () => {
        const reader = new ChunkReader(MemorySource.text('SELECT 1;'.repeat(1000)), 16);
        const controller = new AbortController();
        const run = (async () => {
            let count = 0;
            for await (const statement of streamStatements(reader, 'mysql', {
                signal: controller.signal,
            })) {
                void statement;
                if (++count === 5) controller.abort();
            }
        })();
        await expect(run).rejects.toMatchObject({ code: 'CANCELLED' });
    });
});

describe('QueryRun', () => {
    it('reads only a little beyond what the window asked for', async () => {
        const fake = new FakeSession(() => rowsOf(1_000_000));
        const run = new QueryRun(asSession(fake), 'SELECT n', { spoolDirectory: directory });
        await settle(300);
        const snapshot = run.snapshot();
        expect(snapshot.state).toBe('running');
        // Initial demand (2,000) plus the two-page lookahead (2,000), give or take one batch.
        expect(snapshot.results[0]!.rowCount).toBeLessThan(4_500);
        expect(snapshot.results[0]!.rowCount).toBeGreaterThanOrEqual(4_000);
        expect(fake.pulled).toBeLessThan(5_000);

        // Showing a page far down asks for it.
        run.demand(0, 20_000);
        await settle(300);
        expect(run.snapshot().results[0]!.rowCount).toBeGreaterThanOrEqual(20_000);
        expect(run.snapshot().results[0]!.rowCount).toBeLessThan(25_000);
        await run.dispose();
    });

    it('serves pages while the statement is still running, and lets the window fetch everything', async () => {
        const fake = new FakeSession(() => rowsOf(30_000));
        const run = new QueryRun(asSession(fake), 'SELECT n', { spoolDirectory: directory });
        await settle(100);
        const first = (await run.page(0, 0))!;
        expect(first.rows).toHaveLength(1_000);
        expect(first.rows[0]).toEqual([0]);
        expect(first.firstRow).toBe(0);
        run.fetchAll(0);
        await run.finished;
        const snapshot = run.snapshot();
        expect(snapshot).toMatchObject({ state: 'done' });
        expect(snapshot.results[0]).toMatchObject({
            rowCount: 30_000,
            complete: true,
            capped: false,
        });
        expect((await run.page(0, 29))!.rows.at(-1)).toEqual([29_999]);
        expect(await run.page(0, 30)).toBeNull();
        expect(await run.cell(0, 12_345, 0)).toBe(12_345);
        await run.dispose();
    });

    it('records statements that return no rows, and several result sets', async () => {
        const fake = new FakeSession((sql) =>
            sql === 'write'
                ? [end({ affectedRows: 3, insertId: '9', info: 'Rows matched: 3' })]
                : (async function* () {
                      yield* rowsOf(5);
                      yield* rowsOf(2);
                      yield end({ affectedRows: 0 });
                  })(),
        );
        const write = new QueryRun(asSession(fake), 'write', { spoolDirectory: directory });
        await write.finished;
        expect(write.snapshot().results).toEqual([
            expect.objectContaining({
                columns: [],
                affectedRows: 3,
                insertId: '9',
                info: 'Rows matched: 3',
                complete: true,
            }),
        ]);

        const multi = new QueryRun(asSession(fake), 'multi', { spoolDirectory: directory });
        await multi.finished;
        expect(multi.snapshot().results.map((r) => [r.rowCount, r.complete])).toEqual([
            [5, true],
            [2, true],
            [0, true],
        ]);
        await write.dispose();
        await multi.dispose();
    });

    it('reports a failure with what was read before it', async () => {
        const fake = new FakeSession(() =>
            (async function* () {
                yield { kind: 'columns', columns: [{ name: 'n', type: 'int' }] } as ResultEvent;
                yield { kind: 'rows', rows: [[1], [2]] } as ResultEvent;
                throw new DbError('QUERY_FAILED', 'division by zero');
            })(),
        );
        const run = new QueryRun(asSession(fake), 'SELECT 1/0', { spoolDirectory: directory });
        await run.finished;
        const snapshot = run.snapshot();
        expect(snapshot.state).toBe('failed');
        expect(snapshot.error).toEqual({ code: 'QUERY_FAILED', message: 'division by zero' });
        expect(snapshot.results[0]!.rowCount).toBe(2);
        expect((await run.page(0, 0))!.rows).toEqual([[1], [2]]);
        await run.dispose();
    });

    it('can be cancelled while it waits for the window, and tells the server', async () => {
        const fake = new FakeSession(() => rowsOf(1_000_000));
        const run = new QueryRun(asSession(fake), 'SELECT n', { spoolDirectory: directory });
        await settle(200);
        await run.cancel();
        await run.finished;
        expect(run.snapshot().state).toBe('cancelled');
        expect(fake.cancelled).toBeGreaterThan(0);
        await run.dispose();
    });

    it('stops at the disk limit instead of dropping rows quietly', async () => {
        const fake = new FakeSession(() => rowsOf(1_000_000, 500));
        const run = new QueryRun(asSession(fake), 'SELECT n', {
            spoolDirectory: directory,
            maxSpoolBytes: 30_000,
            lookaheadPages: 1_000,
        });
        run.fetchAll(0);
        await run.finished;
        const snapshot = run.snapshot();
        expect(snapshot.results[0]!.capped).toBe(true);
        expect(snapshot.state).toBe('cancelled');
        expect(fake.cancelled).toBeGreaterThan(0);
        await run.dispose();
    });

    it('removes its result files when disposed', async () => {
        const fake = new FakeSession(() => rowsOf(5_000));
        const run = new QueryRun(asSession(fake), 'SELECT n', { spoolDirectory: directory });
        run.fetchAll(0);
        await run.finished;
        expect((await readdir(directory)).length).toBe(1);
        await run.dispose();
        expect(await readdir(directory)).toEqual([]);
    });

    it('reports changes as they happen', async () => {
        const fake = new FakeSession(() => rowsOf(3_000));
        const run = new QueryRun(asSession(fake), 'SELECT n', { spoolDirectory: directory });
        const states: string[] = [];
        run.onChange((snapshot) => states.push(snapshot.state));
        run.fetchAll(0);
        await run.finished;
        expect(states.at(-1)).toBe('done');
        await run.dispose();
    });
});

describe('ScriptRun', () => {
    const readerOf = (text: string, chunk = 64) => new ChunkReader(MemorySource.text(text), chunk);

    it('runs every statement of a script in order and counts what they did', async () => {
        const fake = new FakeSession((sql) =>
            sql.startsWith('SELECT') ? rowsOf(7) : [end({ affectedRows: 2 })],
        );
        const script =
            'INSERT INTO t VALUES (1); INSERT INTO t VALUES (2);\nSELECT * FROM t;\nDELIMITER //\nCREATE PROCEDURE p() BEGIN SELECT 1; END//\nDELIMITER ;\n';
        const run = new ScriptRun(asSession(fake), readerOf(script), 'mysql', { onError: 'stop' });
        await run.finished;
        expect(fake.executed).toEqual([
            'INSERT INTO t VALUES (1)',
            'INSERT INTO t VALUES (2)',
            'SELECT * FROM t',
            'CREATE PROCEDURE p() BEGIN SELECT 1; END',
        ]);
        expect(run.snapshot()).toMatchObject({
            state: 'done',
            executed: 4,
            failed: 0,
            affectedRows: 6,
            rowsReturned: 7,
        });
    });

    it('stops at the first failure, or carries on, as asked', async () => {
        const make = () =>
            new FakeSession((sql) => {
                if (sql.includes('BAD')) throw new DbError('QUERY_FAILED', 'syntax error');
                return [end({ affectedRows: 1 })];
            });
        const script = 'A1;\nBAD1;\nA2;\nBAD2;\nA3;';

        const stop = make();
        const stopped = new ScriptRun(asSession(stop), readerOf(script), 'mysql', {
            onError: 'stop',
        });
        await stopped.finished;
        expect(stop.executed).toEqual(['A1', 'BAD1']);
        expect(stopped.snapshot()).toMatchObject({ state: 'failed', failed: 1 });
        expect(stopped.snapshot().errors[0]).toMatchObject({
            statement: 1,
            line: 2,
            preview: 'BAD1',
            error: { code: 'QUERY_FAILED' },
        });

        const carry = make();
        const carried = new ScriptRun(asSession(carry), readerOf(script), 'mysql', {
            onError: 'continue',
        });
        await carried.finished;
        expect(carry.executed).toEqual(['A1', 'BAD1', 'A2', 'BAD2', 'A3']);
        expect(carried.snapshot()).toMatchObject({ state: 'done', failed: 2, executed: 5 });
        expect(carried.snapshot().errors.map((e) => e.line)).toEqual([2, 4]);
    });

    it('can be cancelled, stopping the running statement', async () => {
        const fake: FakeSession = new FakeSession((sql) =>
            sql === 'SLOW'
                ? // eslint-disable-next-line require-yield -- waits, then ends without a row
                  (async function* () {
                      await Promise.race([settle(5_000), fake.stopped]);
                  })()
                : [end()],
        );
        const run = new ScriptRun(asSession(fake), readerOf('ONE;\nSLOW;\nTHREE;'), 'mysql', {
            onError: 'stop',
        });
        await settle(150);
        await run.cancel();
        await run.finished;
        expect(run.snapshot().state).toBe('cancelled');
        expect(fake.executed).toEqual(['ONE', 'SLOW']);
        expect(fake.cancelled).toBeGreaterThan(0);
    });

    it('runs a part of a file, and reports progress in bytes', async () => {
        const text = 'ONE;\nTWO;\nTHREE;\nFOUR;\n';
        const fake = new FakeSession(() => [end()]);
        const start = text.indexOf('TWO');
        const stop = text.indexOf('FOUR');
        const run = new ScriptRun(asSession(fake), readerOf(text, 4), 'mysql', {
            onError: 'stop',
            start,
            end: stop,
        });
        await run.finished;
        expect(fake.executed).toEqual(['TWO', 'THREE']);
        expect(run.snapshot().totalBytes).toBe(stop - start);
    });

    it('runs a large script in constant memory', async () => {
        const fake = new FakeSession(() => [end({ affectedRows: 1 })]);
        const text = 'INSERT INTO t VALUES (1);\n'.repeat(60_000);
        const before = process.memoryUsage().heapUsed;
        const run = new ScriptRun(asSession(fake), readerOf(text, 64 * 1024), 'mysql', {
            onError: 'stop',
        });
        await run.finished;
        expect(run.snapshot()).toMatchObject({ executed: 60_000, affectedRows: 60_000 });
        expect(process.memoryUsage().heapUsed - before).toBeLessThan(120 * 1024 * 1024);
    }, 60_000);
});
