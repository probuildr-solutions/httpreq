/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

// @vitest-environment node
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ConnectionManager } from '@httpreq/connection-manager';
import type { Execution, ExecuteOptions, RelationalSession, TaskSnapshot } from '@httpreq/db-core';
import { FakeSession } from '@httpreq/transfer-engine';
import { TaskService } from './taskService';

/** A connection manager with one open connection per id, backed by whatever session a test gives. */
const connections = (engine: string, make: () => unknown): ConnectionManager =>
    ({
        engineOf: (id: string) => (id === 'c'.repeat(16) ? engine : undefined),
        openDedicated: async () => make(),
    }) as unknown as ConnectionManager;

const CONN = 'c'.repeat(16);
const ids = { a: '1'.repeat(16), b: '2'.repeat(16), c: '3'.repeat(16), d: '4'.repeat(16) };

let directory: string;
beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'httpreq-tasks-'));
});
afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
});

const service = (engine: string, make: () => unknown) => {
    const events: { topic: string; payload: { snapshot: TaskSnapshot } }[] = [];
    const tasks = new TaskService(
        connections(engine, make),
        () => (topic, payload) => void events.push({ topic, payload: payload as never }),
        {
            minIntervalMs: 20,
        },
    );
    return { tasks, events };
};

describe('task service', () => {
    it('exports a table to a file as a task, with progress events and no paths in the snapshot', async () => {
        const session = new FakeSession({
            columns: [
                { name: 'id', type: 'int' },
                { name: 'name', type: 'text' },
            ],
            rowCount: 25_000,
            row: (i) => [i, `n${i}`],
            pageRows: 1000,
        });
        const { tasks, events } = service('mysql', () => ({
            ...session.asSession(),
            close: async () => undefined,
            execute: session.execute.bind(session),
        }));
        const path = join(directory, 'people.csv');
        await tasks.handle('task.export', {
            taskId: ids.a,
            connectionId: CONN,
            source: { kind: 'table', database: 'shop', name: 'people' },
            format: 'csv',
            path,
        });
        const final = await tasks.tasks.settled(ids.a);
        expect(final).toMatchObject({
            state: 'COMPLETED',
            type: 'export',
            rowsProcessed: 25_000,
            file: 'people.csv',
            target: 'people',
            message: '25,000 rows written.',
        });
        expect(JSON.stringify(final)).not.toContain(directory);
        expect(session.statements[0]).toBe('SELECT * FROM `shop`.`people`');
        expect((await readFile(path, 'utf8')).split('\r\n')).toHaveLength(25_002);
        const states = events.map((e) => e.payload.snapshot.state);
        expect(states[0]).toBe('PENDING');
        expect(states.at(-1)).toBe('COMPLETED');
        // far fewer events than rows or pages
        expect(events.length).toBeLessThan(30);
        await tasks.dispose();
    });

    it('exports a MongoDB collection as whole documents', async () => {
        const session = new FakeSession({
            columns: [{ name: 'document', type: 'object' }],
            rowCount: 3,
            row: (i) => [
                { _id: { $type: 'objectId', $value: '507f1f77bcf86cd79943901' + i }, n: i },
            ],
        });
        const { tasks } = service('mongodb', () => ({
            execute: session.execute.bind(session),
            close: async () => undefined,
        }));
        const path = join(directory, 'docs.ndjson');
        await tasks.handle('task.export', {
            taskId: ids.a,
            connectionId: CONN,
            source: { kind: 'table', database: 'shop', name: 'orders' },
            format: 'ndjson',
            path,
        });
        await tasks.tasks.settled(ids.a);
        expect(session.statements[0]).toBe(
            'db.getSiblingDB("shop").getCollection("orders").find({}).asDocuments()',
        );
        const lines = (await readFile(path, 'utf8'))
            .trim()
            .split('\n')
            .map((l) => JSON.parse(l));
        expect(lines[1]).toEqual({
            _id: { $oid: '507f1f77bcf86cd799439011' },
            n: { $numberInt: '1' },
        });
    });

    it('cancels an export, stops the statement and removes the partial file', async () => {
        const session = new FakeSession({
            columns: [{ name: 'id', type: 'int' }],
            rowCount: 50_000_000,
            row: (i) => [i],
            pageRows: 100,
        });
        const { tasks } = service('postgresql', () => ({
            execute: session.execute.bind(session),
            close: async () => undefined,
        }));
        const path = join(directory, 'big.csv');
        await tasks.handle('task.export', {
            taskId: ids.a,
            connectionId: CONN,
            source: { kind: 'table', schema: 'public', name: 't' },
            format: 'csv',
            path,
        });
        await new Promise((resolve) => setTimeout(resolve, 50));
        await tasks.handle('task.cancel', { taskId: ids.a });
        const final = await tasks.tasks.settled(ids.a);
        expect(final?.state).toBe('CANCELLED');
        expect(session.cancelled).toBe(true);
        expect(await readdir(directory)).toEqual([]);
    });

    it('refuses invalid requests before starting anything', async () => {
        const { tasks } = service('mysql', () => ({}));
        await expect(
            tasks.handle('task.export', {
                taskId: 'bad',
                connectionId: CONN,
                source: { kind: 'table', name: 't' },
                format: 'csv',
                path: 'x',
            }),
        ).rejects.toThrow(/task is invalid/);
        await expect(
            tasks.handle('task.export', {
                taskId: ids.a,
                connectionId: CONN,
                source: { kind: 'table', name: 't' },
                format: 'xml',
                path: 'x',
            }),
        ).rejects.toThrow(/format/);
        await expect(
            tasks.handle('task.export', {
                taskId: ids.a,
                connectionId: 'f'.repeat(16),
                source: { kind: 'table', name: 't' },
                format: 'csv',
                path: 'x',
            }),
        ).rejects.toThrow(/not open/);
        await expect(
            tasks.handle('task.export', {
                taskId: ids.a,
                connectionId: CONN,
                source: { kind: 'table', name: 't' },
                format: 'bson',
                path: 'x',
            }),
        ).rejects.toThrow(/only for MongoDB/);
        expect(tasks.tasks.list()).toHaveLength(0);
    });

    it('imports a CSV file into a table on its own session, and reports rows and rejects', async () => {
        const statements: string[] = [];
        const session = {
            listColumns: async () => [
                { name: 'id', position: 1, type: 'int', nullable: false, primaryKey: true },
                {
                    name: 'name',
                    position: 2,
                    type: 'varchar(20)',
                    nullable: true,
                    primaryKey: false,
                },
            ],
            execute: (sql: string, options?: ExecuteOptions): Execution => {
                void options;
                statements.push(sql);
                const generator = (async function* () {
                    yield { kind: 'end' as const };
                })();
                return { [Symbol.asyncIterator]: () => generator, cancel: async () => undefined };
            },
            close: async () => undefined,
        } as unknown as RelationalSession;
        const { tasks } = service('mysql', () => session);
        const file = join(directory, 'in.csv');
        await writeFile(file, 'id,name\n1,Ada\nx,Bad\n3,Cy\n');
        await tasks.handle('task.import', {
            taskId: ids.b,
            connectionId: CONN,
            path: file,
            rejectsPath: join(directory, 'in.rejects.ndjson'),
            saveRejects: true,
            format: 'csv',
            target: { database: 'shop', name: 'people' },
            onError: 'skip',
            transaction: 'none',
        });
        const final = await tasks.tasks.settled(ids.b);
        expect(final).toMatchObject({
            state: 'COMPLETED',
            type: 'import',
            message: '2 rows imported, 1 rejected.',
            errorCount: 1,
            file: 'in.csv',
        });
        expect(final?.issues[0]).toMatchObject({ record: 3, line: 3 });
        expect(statements.join('\n')).toContain("(1, 'Ada')");
        const rejects = (await readFile(join(directory, 'in.rejects.ndjson'), 'utf8')).trim();
        expect(JSON.parse(rejects)).toMatchObject({ record: 3, data: ['x', 'Bad'] });
    });

    it('runs a script file as a task, in one transaction when asked, and rolls it back on failure', async () => {
        const log: string[] = [];
        let failOn: string | null = null;
        const session = {
            begin: async () => void log.push('BEGIN'),
            commit: async () => void log.push('COMMIT'),
            rollback: async () => void log.push('ROLLBACK'),
            execute: (sql: string): Execution => {
                log.push(sql);
                const generator = (async function* () {
                    if (failOn && sql.includes(failOn))
                        throw Object.assign(new Error('boom'), { code: 'QUERY_FAILED' });
                    yield { kind: 'end' as const, affectedRows: 1 };
                })();
                return { [Symbol.asyncIterator]: () => generator, cancel: async () => undefined };
            },
            close: async () => undefined,
        };
        const { tasks } = service('mysql', () => session);
        const file = join(directory, 'dump.sql');
        await writeFile(
            file,
            'INSERT INTO a VALUES (1);\nINSERT INTO a VALUES (2);\nINSERT INTO a VALUES (3);\n',
        );
        await tasks.handle('task.script', {
            taskId: ids.c,
            connectionId: CONN,
            path: file,
            dialect: 'mysql',
            onError: 'stop',
            transaction: 'single',
        });
        expect(await tasks.tasks.settled(ids.c)).toMatchObject({
            state: 'COMPLETED',
            message: '3 statements run.',
        });
        expect(log[0]).toBe('BEGIN');
        expect(log.at(-1)).toBe('COMMIT');

        log.length = 0;
        failOn = '(2)';
        await tasks.handle('task.script', {
            taskId: ids.d,
            connectionId: CONN,
            path: file,
            dialect: 'mysql',
            onError: 'stop',
            transaction: 'single',
        });
        const failed = await tasks.tasks.settled(ids.d);
        expect(failed).toMatchObject({ state: 'FAILED' });
        expect(failed?.message).toMatch(/Everything was rolled back/);
        expect(log.at(-1)).toBe('ROLLBACK');
    });
});
