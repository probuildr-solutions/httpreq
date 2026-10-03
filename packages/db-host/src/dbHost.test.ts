/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

// @vitest-environment node
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DbValue } from '@httpreq/db-core';
import { mysqlProvider } from '@httpreq/mysql-engine';
import { startMysql, type TestServer } from '@httpreq/test-servers';
import { DbHostService, type QueryStateEvent, type ScriptProgressEvent } from './index';

let server: TestServer | null = null;
let work: string;
let host: DbHostService;
const events: { topic: string; payload: unknown }[] = [];

const call = <T>(op: string, payload: object = {}): Promise<T> =>
    host.handle(op, payload, {
        emit: (topic, body) => events.push({ topic, payload: body }),
        signal: new AbortController().signal,
    }) as Promise<T>;

const hex = (n: number) => n.toString(16).padStart(16, '0');
let next = 1;
const newId = () => hex(next++);

const config = (extra: Record<string, unknown> = {}) => ({
    engine: 'mysql',
    host: server!.host,
    port: server!.port,
    username: 'app',
    password: 'secret',
    tls: { mode: 'disable' },
    ...extra,
});

const lastState = (queryId: string): QueryStateEvent['snapshot'] | undefined => {
    for (let i = events.length - 1; i >= 0; i--) {
        const event = events[i]!;
        if (
            event.topic === 'query.state' &&
            (event.payload as QueryStateEvent).queryId === queryId
        ) {
            return (event.payload as QueryStateEvent).snapshot;
        }
    }
    return undefined;
};

const until = async <T>(read: () => T | undefined, ms = 20_000): Promise<T> => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        const value = read();
        if (value) return value;
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('timed out');
};

beforeAll(async () => {
    server = await startMysql();
    work = await mkdtemp(join(tmpdir(), 'hr-dbhost-'));
    host = new DbHostService({
        providers: [mysqlProvider],
        spoolDirectory: join(work, 'spool'),
        keepAliveMs: 0,
    });
}, 180_000);
afterAll(async () => {
    await host?.dispose();
    await server?.stop();
    await rm(work, { recursive: true, force: true });
});

const live = (name: string, body: () => Promise<void>, timeout = 60_000) =>
    it(
        name,
        async (context) => {
            if (!server) return context.skip();
            await body();
        },
        timeout,
    );

describe('requests', () => {
    it('lists the engines it can talk to', async () => {
        expect(await call('engines.list')).toEqual([
            expect.objectContaining({
                id: 'mysql',
                defaultPort: 3306,
                capabilities: expect.arrayContaining(['sql', 'events']),
            }),
        ]);
    });

    it('refuses malformed requests before doing anything', async () => {
        await expect(call('conn.test', { config: 'nope' })).rejects.toMatchObject({
            code: 'INVALID_REQUEST',
        });
        await expect(
            call('conn.test', { config: { engine: 'mysql', host: 'h', port: 99999 } }),
        ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
        await expect(
            call('conn.test', {
                config: { engine: 'mysql', host: 'h', port: 1, tls: { mode: 'sometimes' } },
            }),
        ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
        await expect(
            call('conn.open', { connectionId: 'not-an-id', config: {} }),
        ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
        await expect(
            call('query.page', { queryId: newId(), result: 0, page: 0 }),
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
        await expect(call('no.such.op')).rejects.toMatchObject({ code: 'UNSUPPORTED' });
        await expect(
            call('conn.test', { config: { engine: 'oracle', host: 'h', port: 1 } }),
        ).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    });

    it('splits SQL text into statements, and finds the one at the cursor', async () => {
        const text = 'SELECT 1;\nSELECT 2;';
        const statements = await call<{ sql: string }[]>('sql.split', { text, dialect: 'mysql' });
        expect(statements.map((s) => s.sql)).toEqual(['SELECT 1', 'SELECT 2']);
        expect(await call('sql.statementAt', { text, offset: 14, dialect: 'mysql' })).toMatchObject(
            { sql: 'SELECT 2' },
        );
        await expect(call('sql.split', { text, dialect: 'cobol' })).rejects.toMatchObject({
            code: 'INVALID_REQUEST',
        });
    });
});

describe('against a real server', () => {
    live(
        'tests a connection, reporting the server and permissions, and a wrong password',
        async () => {
            const ok = await call<{
                ok: boolean;
                server: { product: string };
                permissions: { write: boolean };
            }>('conn.test', { config: config() });
            expect(ok).toMatchObject({ ok: true, permissions: { read: true, write: true } });
            await expect(
                call('conn.test', { config: config({ password: 'nope' }) }),
            ).rejects.toMatchObject({ code: 'AUTH_FAILED' });
        },
    );

    live('opens a connection and browses its schema', async () => {
        const connectionId = newId();
        const status = await call<{ state: string }>('conn.open', {
            connectionId,
            config: config(),
        });
        expect(status.state).toBe('connected');
        expect(events.some((e) => e.topic === 'conn.status')).toBe(true);
        await call('query.start', {
            connectionId,
            queryId: newId(),
            sql: 'CREATE TABLE IF NOT EXISTS shop.things (id INT PRIMARY KEY, label VARCHAR(40))',
        });
        await until(() => events.filter((e) => e.topic === 'query.state').at(-1) && true);
        await new Promise((resolve) => setTimeout(resolve, 300));
        const tables = await call<{ name: string }[]>('meta.list', {
            connectionId,
            kind: 'tables',
            scope: { database: 'shop' },
        });
        expect(tables.map((t) => t.name)).toContain('things');
        const columns = await call<{ name: string }[]>('meta.list', {
            connectionId,
            kind: 'columns',
            scope: { database: 'shop', name: 'things' },
        });
        expect(columns.map((c) => c.name)).toEqual(['id', 'label']);
        expect(await call('meta.list', { connectionId, kind: 'databases' })).toEqual(
            expect.arrayContaining([{ name: 'shop', system: false }]),
        );
        await expect(call('meta.list', { connectionId, kind: 'planets' })).rejects.toMatchObject({
            code: 'INVALID_REQUEST',
        });
        const definition = await call<{ text: string }>('meta.definition', {
            connectionId,
            object: { database: 'shop', name: 'things', kind: 'table' },
        });
        expect(definition.text).toMatch(/CREATE TABLE/);
        await call('conn.close', { connectionId });
        await expect(call('meta.list', { connectionId, kind: 'tables' })).rejects.toMatchObject({
            code: 'NOT_FOUND',
        });
    });

    live(
        'runs a large query, pages through it, and reads only as far as the window looks',
        async () => {
            const connectionId = newId();
            await call('conn.open', { connectionId, config: config() });
            await call('query.start', {
                connectionId,
                queryId: newId(),
                sql: 'SET SESSION cte_max_recursion_depth = 2000000',
            });
            await new Promise((resolve) => setTimeout(resolve, 300));

            const queryId = newId();
            await call('query.start', {
                connectionId,
                queryId,
                sql: "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1000000) SELECT i, REPEAT('x', 20) AS pad FROM n",
            });
            const first = await until(() => {
                const snapshot = lastState(queryId);
                return snapshot && snapshot.results[0]?.rowCount ? snapshot : undefined;
            });
            expect(first.state).toBe('running');
            await new Promise((resolve) => setTimeout(resolve, 500));
            const waiting = lastState(queryId)!;
            // A million rows were not read: it waits for the window.
            expect(waiting.results[0]!.rowCount).toBeLessThan(10_000);
            expect(waiting.results[0]!.columns.map((c) => c.name)).toEqual(['i', 'pad']);

            const page = await call<{ rows: DbValue[][]; firstRow: number }>('query.page', {
                queryId,
                result: 0,
                page: 0,
            });
            expect(page.rows[0]).toEqual([1, 'xxxxxxxxxxxxxxxxxxxx']);
            expect(page.rows).toHaveLength(1_000);

            // Scrolling far down asks for the rows in between.
            await call('query.demand', { queryId, result: 0, rows: 50_000 });
            await until(() =>
                lastState(queryId)!.results[0]!.rowCount >= 50_000 ? true : undefined,
            );
            const deep = await call<{ rows: DbValue[][]; firstRow: number }>('query.page', {
                queryId,
                result: 0,
                page: 49,
            });
            expect(deep.rows[0]![0]).toBe(49_001);
            expect(
                await call('query.cell', { queryId, result: 0, row: 12_345, column: 0 }),
            ).toEqual({ value: 12_346 });

            await call('query.cancel', { queryId });
            const done = await until(() =>
                lastState(queryId)!.state !== 'running' ? lastState(queryId) : undefined,
            );
            expect(done.state).toBe('cancelled');
            // What was read is still there to look at.
            expect(
                (await call<{ rows: DbValue[][] }>('query.page', { queryId, result: 0, page: 3 }))
                    .rows,
            ).toHaveLength(1_000);
            await call('query.close', { queryId });
            await expect(call('query.page', { queryId, result: 0, page: 0 })).rejects.toMatchObject(
                { code: 'NOT_FOUND' },
            );
            await call('conn.close', { connectionId });
        },
        120_000,
    );

    live(
        'replaces a run that is only waiting for the window, but not one that is working',
        async () => {
            const connectionId = newId();
            await call('conn.open', { connectionId, config: config() });
            await call('query.start', {
                connectionId,
                queryId: newId(),
                sql: 'SET SESSION cte_max_recursion_depth = 2000000',
            });
            await new Promise((resolve) => setTimeout(resolve, 300));
            const big = newId();
            await call('query.start', {
                connectionId,
                queryId: big,
                sql: 'WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 500000) SELECT i FROM n',
            });
            await new Promise((resolve) => setTimeout(resolve, 800));
            expect(lastState(big)!.state).toBe('running'); // waiting for the window

            const small = newId();
            await call('query.start', { connectionId, queryId: small, sql: 'SELECT 42 AS answer' });
            const finished = await until(() =>
                lastState(small)?.state === 'done' ? lastState(small) : undefined,
            );
            expect(finished.results[0]!.rowCount).toBe(1);
            expect(lastState(big)!.state).toBe('cancelled');

            // A statement that is really working blocks another from starting.
            const slow = newId();
            await call('query.start', { connectionId, queryId: slow, sql: 'SELECT SLEEP(3)' });
            await new Promise((resolve) => setTimeout(resolve, 300));
            await expect(
                call('query.start', { connectionId, queryId: newId(), sql: 'SELECT 1' }),
            ).rejects.toMatchObject({ code: 'CONFLICT' });
            await call('query.cancel', { queryId: slow });
            await call('conn.close', { connectionId });
        },
        120_000,
    );

    live('reports a failing statement and a data-changing one', async () => {
        const connectionId = newId();
        await call('conn.open', { connectionId, config: config() });
        const bad = newId();
        await call('query.start', { connectionId, queryId: bad, sql: 'SELEC 1' });
        const failed = await until(() =>
            lastState(bad)?.state === 'failed' ? lastState(bad) : undefined,
        );
        expect(failed.error).toMatchObject({ code: 'QUERY_FAILED' });
        const write = newId();
        await call('query.start', {
            connectionId,
            queryId: write,
            sql: "INSERT INTO shop.things VALUES (1, 'a'), (2, 'b') ON DUPLICATE KEY UPDATE label = VALUES(label)",
        });
        const wrote = await until(() =>
            lastState(write)?.state === 'done' ? lastState(write) : undefined,
        );
        expect(wrote.results[0]).toMatchObject({ columns: [], affectedRows: expect.any(Number) });
        await call('conn.close', { connectionId });
    });

    live('explains a statement and runs transactions', async () => {
        const connectionId = newId();
        await call('conn.open', { connectionId, config: config() });
        const plan = await call<{ text: string }>('query.explain', {
            connectionId,
            sql: 'SELECT * FROM shop.things',
        });
        expect(plan.text.length).toBeGreaterThan(0);
        await call('tx.begin', { connectionId });
        await call('tx.rollback', { connectionId });
        await call('tx.begin', { connectionId });
        await call('tx.commit', { connectionId });
        await call('conn.close', { connectionId });
    });

    live(
        'runs a script file statement by statement and reports progress',
        async () => {
            const connectionId = newId();
            await call('conn.open', { connectionId, config: config() });
            const path = join(work, 'seed.sql');
            const rows = Array.from(
                { length: 2_000 },
                (_, i) =>
                    `INSERT INTO shop.things VALUES (${1000 + i}, 'row ${i}; with semicolon');`,
            ).join('\n');
            await writeFile(
                path,
                `DELETE FROM shop.things WHERE id >= 1000;\n${rows}\nDELIMITER $$\nCREATE PROCEDURE shop.count_things() BEGIN SELECT COUNT(*) FROM shop.things; END$$\nDELIMITER ;\nINSERT INTO shop.things VALUES (99999, 'bad');\nINSERT INTO shop.things VALUES (99999, 'duplicate key');\nINSERT INTO shop.things VALUES (100000, 'after the failure');\n`,
            );

            const stop = newId();
            await call('script.start', {
                connectionId,
                scriptId: stop,
                path,
                dialect: 'mysql',
                onError: 'stop',
            });
            const stopped = await until(() => {
                const last = [...events]
                    .reverse()
                    .find(
                        (e) =>
                            e.topic === 'script.progress' &&
                            (e.payload as ScriptProgressEvent).scriptId === stop,
                    )?.payload as ScriptProgressEvent | undefined;
                return last && last.progress.state !== 'running' ? last.progress : undefined;
            });
            expect(stopped.state).toBe('failed');
            expect(stopped.executed).toBe(1 + 2_000 + 1 + 1 + 1); // delete, inserts, procedure, then the good and the duplicate
            expect(stopped.errors[0]).toMatchObject({
                error: { code: 'QUERY_FAILED' },
                preview: expect.stringContaining('duplicate key'),
            });

            const carry = newId();
            await call('script.start', {
                connectionId,
                scriptId: carry,
                path,
                dialect: 'mysql',
                onError: 'continue',
            });
            const carried = await until(() => {
                const last = [...events]
                    .reverse()
                    .find(
                        (e) =>
                            e.topic === 'script.progress' &&
                            (e.payload as ScriptProgressEvent).scriptId === carry,
                    )?.payload as ScriptProgressEvent | undefined;
                return last && last.progress.state !== 'running' ? last.progress : undefined;
            });
            expect(carried.state).toBe('done');
            expect(carried.failed).toBeGreaterThanOrEqual(2); // the procedure already exists, and the duplicate
            expect(carried.executed).toBeGreaterThan(2_000);
            await call('script.close', { scriptId: stop });
            await call('script.close', { scriptId: carry });
            await call('conn.close', { connectionId });
        },
        120_000,
    );

    live('removes every result file when the host shuts down', async () => {
        const connectionId = newId();
        await call('conn.open', { connectionId, config: config() });
        const queryId = newId();
        await call('query.start', { connectionId, queryId, sql: 'SELECT 1 UNION SELECT 2' });
        await until(() => (lastState(queryId)?.state === 'done' ? true : undefined));
        await host.dispose();
        const leftovers: string[] = [];
        for (const folder of await readdir(join(work, 'spool')).catch(() => [])) {
            leftovers.push(...(await readdir(join(work, 'spool', folder))));
        }
        expect(leftovers).toEqual([]);
        expect(await call('host.stats')).toEqual({ connections: 0, queries: 0, scripts: 0 });
    });
});
