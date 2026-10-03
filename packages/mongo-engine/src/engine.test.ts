// @vitest-environment node
/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
    isRelationalSession,
    type ConnectionConfig,
    type DbValue,
    type Execution,
    type RelationalSession,
    type ResultEvent,
} from '@httpreq/db-core';
import { MongoConnection } from '@httpreq/db-protocol-mongo';
import { findMongod, startMongo, type TestServer } from '@httpreq/test-servers';
import { mongoProvider } from './index';

const available = findMongod() !== null;

const connect = async (
    server: TestServer,
    extra: Partial<ConnectionConfig> = {},
): Promise<RelationalSession> => {
    const session = await mongoProvider
        .createConnector({
            engine: 'mongodb',
            host: server.host,
            port: server.port,
            database: 'shop',
            tls: { mode: 'disable' },
            connectTimeoutMs: 5000,
            queryTimeoutMs: 0,
            options: {},
            ...extra,
        })
        .connect();
    if (!isRelationalSession(session)) throw new Error('expected a statement session');
    return session;
};

interface Collected {
    columns: string[];
    rows: DbValue[][];
    pages: number;
    info?: string;
    affected?: number;
}

const collect = async (execution: Execution): Promise<Collected> => {
    const out: Collected = { columns: [], rows: [], pages: 0 };
    for await (const event of execution as AsyncIterable<ResultEvent>) {
        if (event.kind === 'columns') out.columns = event.columns.map((c) => c.name);
        else if (event.kind === 'rows') {
            out.rows.push(...event.rows);
            out.pages++;
        } else {
            if (event.info) out.info = event.info;
            if (event.affectedRows !== undefined) out.affected = event.affectedRows;
        }
    }
    return out;
};

describe.skipIf(!available)('against a real mongod', () => {
    let server: TestServer;
    let session: RelationalSession;
    const run = (statement: string) => collect(session.execute(statement));

    beforeAll(async () => {
        server = (await startMongo())!;
        session = await connect(server);
    }, 120_000);

    afterAll(async () => {
        await session?.close();
        await server?.stop();
    });

    it('reports the server', () => {
        expect(session.info.product).toBe('MongoDB');
        expect(session.info.version).toMatch(/^\d+\./);
    });

    it('inserts, reads, updates and deletes through the shell syntax', async () => {
        const inserted = await run(
            'db.people.insertOne({ name: "Ada", born: ISODate("1815-12-10"), langs: ["math"], address: { city: "London" } })',
        );
        expect(inserted.columns).toEqual(['acknowledged', 'insertedCount', 'insertedId']);
        expect(inserted.rows[0]![1]).toBe(1);
        const many = await run(
            'db.people.insertMany([{ name: "Alan", born: 1912 }, { name: "Grace", born: 1906 }])',
        );
        expect(many.columns).toContain('insertedIds');
        expect((many.rows[0]![2] as unknown[]).length).toBe(2);

        const found = await run('db.people.find({ born: { $gt: 1900 } }).sort({ born: 1 })');
        expect(found.columns[0]).toBe('_id');
        expect(found.rows.map((r) => r[found.columns.indexOf('name')])).toEqual(['Grace', 'Alan']);

        const updated = await run(
            'db.people.updateMany({ born: { $gt: 1900 } }, { $set: { modern: true } })',
        );
        expect(updated.columns).toEqual(['acknowledged', 'matchedCount', 'modifiedCount']);
        expect(updated.rows[0]!.slice(1)).toEqual([2, 2]);

        const upserted = await run(
            'db.people.updateOne({ name: "Linus" }, { $set: { born: 1969 } }, { upsert: true })',
        );
        expect(upserted.columns).toContain('upsertedId');

        const deleted = await run('db.people.deleteMany({ modern: true })');
        expect(deleted.rows[0]).toEqual([true, 2]);
        expect((await run('db.people.countDocuments({})')).rows).toEqual([[2]]);
        expect((await run('db.people.estimatedDocumentCount()')).rows).toEqual([[2]]);
        expect((await run('db.people.distinct("name")')).rows.map((r) => r[0]).sort()).toEqual([
            'Ada',
            'Linus',
        ]);
    });

    it('shows nested values as values and dates as dates', async () => {
        const result = await run('db.people.find({ name: "Ada" })');
        const row = result.rows[0]!;
        expect(row[result.columns.indexOf('born')]).toEqual(new Date('1815-12-10T00:00:00Z'));
        expect(row[result.columns.indexOf('address')]).toEqual({ city: 'London' });
        expect(row[result.columns.indexOf('langs')]).toEqual(['math']);
        expect(row[0]).toMatchObject({ $type: 'objectId' });
    });

    it('streams a large result in batches and stops reading when the consumer stops', async () => {
        const batch = Array.from(
            { length: 5000 },
            (_, i) => `{ n: ${i}, pad: "${'x'.repeat(200)}" }`,
        ).join(',');
        await run(`db.big.insertMany([${batch}])`);
        const all = await collect(
            session.execute('db.big.find({}).sort({ n: 1 })', { pageRows: 500 }),
        );
        expect(all.rows).toHaveLength(5000);
        expect(all.pages).toBeGreaterThanOrEqual(10);
        expect(all.rows[4999]![all.columns.indexOf('n')]).toBe(4999);

        // Reading a little and walking away must not leave a cursor open.
        const execution = session.execute('db.big.find({})', { pageRows: 100 });
        const iterator = (execution as AsyncIterable<ResultEvent>)[Symbol.asyncIterator]();
        await iterator.next(); // columns
        await iterator.next(); // first rows
        await iterator.return?.();
        await new Promise((resolve) => setTimeout(resolve, 300));
        const open = await run('db.adminCommand({ serverStatus: 1 })');
        const entries = Object.fromEntries(open.rows.map((r) => [String(r[0]), r[1]]));
        expect((entries.metrics as { cursor: { open: { total: number } } }).cursor.open.total).toBe(
            0,
        );
    });

    it('applies aggregation pipelines', async () => {
        const result = await run(
            'db.big.aggregate([{ $group: { _id: { $mod: ["$n", 3] }, count: { $sum: 1 } } }, { $sort: { _id: 1 } }])',
        );
        expect(result.columns).toEqual(['_id', 'count']);
        expect(result.rows.map((r) => r[1])).toEqual([1667, 1667, 1666]);
    });

    it('returns a document from findOneAndUpdate and says when nothing matched', async () => {
        const result = await run(
            'db.people.findOneAndUpdate({ name: "Ada" }, { $set: { checked: true } }, { returnDocument: "after" })',
        );
        expect(result.rows[0]![result.columns.indexOf('checked')]).toBe(true);
        expect((await run('db.people.findOneAndDelete({ name: "Nobody" })')).rows).toEqual([
            ['No document matched.'],
        ]);
    });

    it('shows commands that answer with one document as field and value', async () => {
        const result = await run('db.runCommand({ ping: 1 })');
        expect(result.columns).toEqual(['field', 'value']);
        const stats = await run('db.stats()');
        expect(stats.rows.map((r) => r[0])).toContain('collections');
    });

    it('switches database with use, and lists databases and collections', async () => {
        await run('use inventory');
        await run('db.parts.insertOne({ sku: "A1" })');
        expect((await run('show collections')).rows.map((row) => row[0])).toEqual(['parts']);
        const dbs = await run('show dbs');
        expect(dbs.rows.map((r) => r[0])).toEqual(
            expect.arrayContaining(['inventory', 'shop', 'admin']),
        );
        await run('use shop');
    });

    it('reports server errors with their meaning', async () => {
        await run('db.unique.createIndex({ k: 1 }, { unique: true })');
        await run('db.unique.insertOne({ k: 1 })');
        await expect(run('db.unique.insertOne({ k: 1 })')).rejects.toMatchObject({
            code: 'CONFLICT',
            message: expect.stringContaining('unique'),
        });
        await expect(run('db.people.find({ $badOperator: 1 })')).rejects.toMatchObject({
            code: 'QUERY_FAILED',
        });
        await expect(
            run('db.people.updateOne({}, { $set: { a: 1 }, $bogus: 1 })'),
        ).rejects.toMatchObject({ code: 'QUERY_FAILED' });
        // The session still works.
        expect((await run('db.people.countDocuments({})')).rows).toEqual([[2]]);
    });

    it('refuses statements it cannot parse before touching the server', () => {
        expect(() => session.execute('SELECT * FROM x')).toThrow(/starts with db\./);
        expect(() => session.execute('db.people.find({ a: })')).toThrow();
    });

    it('stops a statement on request, with the connection left usable', async () => {
        const execution = session.execute('db.big.find({ $where: "sleep(100) || true" })');
        const pending = collect(execution);
        setTimeout(() => void execution.cancel(), 500);
        await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
        expect(session.alive).toBe(true);
        expect((await run('db.people.countDocuments({})')).rows).toEqual([[2]]);
    }, 30_000);

    it('stops a statement that outlives the time limit', async () => {
        const started = Date.now();
        await expect(
            collect(
                session.execute('db.big.find({ $where: "sleep(100) || true" })', {
                    timeoutMs: 600,
                }),
            ),
        ).rejects.toMatchObject({ code: 'TIMEOUT' });
        expect(Date.now() - started).toBeLessThan(10_000);
        expect(session.alive).toBe(true);
    }, 30_000);

    it('lists databases, collections with counts, fields, indexes and a definition', async () => {
        expect((await session.listDatabases()).map((d) => [d.name, d.system])).toEqual(
            expect.arrayContaining([
                ['admin', true],
                ['shop', false],
            ]),
        );
        const tables = await session.listTables({ database: 'shop' });
        const people = tables.find((t) => t.name === 'people')!;
        expect(people).toMatchObject({ kind: 'table', rows: 2 });
        expect(people.bytes).toBeGreaterThan(0);

        const columns = await session.listColumns({ database: 'shop', name: 'people' });
        expect(columns[0]).toMatchObject({ name: '_id', primaryKey: true });
        const names = columns.map((c) => c.name);
        expect(names).toEqual(expect.arrayContaining(['name', 'born', 'address', 'address.city']));
        expect(columns.find((c) => c.name === 'checked')).toMatchObject({ nullable: true });

        await run('db.people.createIndex({ name: 1, born: -1 }, { unique: true })');
        const indexes = await session.listIndexes({ database: 'shop', name: 'people' });
        expect(indexes.map((i) => i.name)).toEqual(['_id_', 'name_1_born_-1']);
        expect(indexes[1]).toMatchObject({
            columns: ['name', 'born'],
            unique: true,
            primary: false,
        });

        const definition = await session.getDefinition({
            database: 'shop',
            name: 'people',
            kind: 'table',
        });
        expect(definition).toContain('db.createCollection("people")');
        expect(definition).toContain('createIndex({');
        await expect(
            session.getDefinition({ database: 'shop', name: 'ghost', kind: 'table' }),
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('lists views as views', async () => {
        await run(
            'db.runCommand({ create: "adults", viewOn: "people", pipeline: [{ $match: { born: { $lt: 1900 } } }] })',
        );
        const tables = await session.listTables({ database: 'shop' });
        expect(tables.find((t) => t.name === 'adults')!.kind).toBe('view');
        expect(
            await session.getDefinition({ database: 'shop', name: 'adults', kind: 'view' }),
        ).toContain('db.createView("adults", "people"');
    });

    it('explains a find', async () => {
        const plan = await session.explain('db.people.find({ name: "Ada" })');
        expect(plan.text).toContain('queryPlanner');
        expect(plan.tree).toBeTruthy();
        await expect(session.explain('db.people.createIndex({ a: 1 })')).rejects.toMatchObject({
            code: 'UNSUPPORTED',
        });
    });

    it('reads server status and the operations in progress', async () => {
        const status = await session.serverStatus();
        expect(Object.keys(status).length).toBeGreaterThan(20);
        expect(status['connections.current']).toBeDefined();
        const operations = await session.listSessions();
        expect(operations.length).toBeGreaterThanOrEqual(1);
    });

    it('reads permissions on a server without access control', async () => {
        expect(await session.getPermissions()).toMatchObject({
            read: true,
            write: true,
            schema: true,
        });
    });

    it('transactions need a replica set, and say so on a standalone', async () => {
        await session.begin();
        await expect(run('db.people.insertOne({ name: "txn" })')).rejects.toMatchObject({
            code: 'QUERY_FAILED',
        });
        await session.rollback();
        await expect(session.rollback()).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    });
});

describe.skipIf(!available)('a replica set member', () => {
    let server: TestServer;
    let session: RelationalSession;

    beforeAll(async () => {
        server = (await startMongo({ replSet: 'rs0' }))!;
        const admin = await MongoConnection.connect({
            host: server.host,
            port: server.port,
            tls: { mode: 'disable' },
            connectTimeoutMs: 5000,
        });
        await admin.command('admin', {
            replSetInitiate: {
                _id: 'rs0',
                members: [{ _id: 0, host: `${server.host}:${server.port}` }],
            },
        });
        for (let i = 0; i < 60; i++) {
            const hello = await admin.command('admin', { hello: 1 });
            if (hello.isWritablePrimary === true) break;
            await new Promise((resolve) => setTimeout(resolve, 500));
        }
        await admin.close();
        session = await connect(server);
        await collect(
            session.execute(
                'db.accounts.insertMany([{ _id: 1, balance: 100 }, { _id: 2, balance: 100 }])',
            ),
        );
    }, 180_000);

    afterAll(async () => {
        await session?.close();
        await server?.stop();
    });

    it('commits a transaction', async () => {
        await session.begin();
        await collect(
            session.execute('db.accounts.updateOne({ _id: 1 }, { $inc: { balance: -30 } })'),
        );
        await collect(
            session.execute('db.accounts.updateOne({ _id: 2 }, { $inc: { balance: 30 } })'),
        );
        await session.commit();
        const result = await collect(session.execute('db.accounts.find({}).sort({ _id: 1 })'));
        expect(result.rows.map((r) => r[result.columns.indexOf('balance')])).toEqual([70, 130]);
    });

    it('rolls a transaction back, and the changes are not visible meanwhile', async () => {
        await session.begin();
        await collect(
            session.execute('db.accounts.updateOne({ _id: 1 }, { $inc: { balance: -50 } })'),
        );
        const other = await connect(server);
        const outside = await collect(other.execute('db.accounts.find({ _id: 1 })'));
        expect(outside.rows[0]![outside.columns.indexOf('balance')]).toBe(70);
        await other.close();
        await session.rollback();
        const after = await collect(session.execute('db.accounts.find({ _id: 1 })'));
        expect(after.rows[0]![after.columns.indexOf('balance')]).toBe(70);
    });

    it('refuses to open a second transaction', async () => {
        await session.begin();
        await expect(session.begin()).rejects.toMatchObject({ code: 'CONFLICT' });
        await session.rollback();
    });
});

describe.skipIf(!available)('with access control', () => {
    let server: TestServer;

    beforeAll(async () => {
        server = (await startMongo({ auth: true }))!;
        const admin = await MongoConnection.connect({
            host: server.host,
            port: server.port,
            tls: { mode: 'disable' },
            connectTimeoutMs: 5000,
        });
        await admin.command('admin', {
            createUser: 'root',
            pwd: 'pw',
            roles: [{ role: 'root', db: 'admin' }],
        });
        await admin.close();
        const root = await MongoConnection.connect({
            host: server.host,
            port: server.port,
            username: 'root',
            password: 'pw',
            tls: { mode: 'disable' },
            connectTimeoutMs: 5000,
        });
        await root.command('shop', {
            createUser: 'reader',
            pwd: 'pw',
            roles: [{ role: 'read', db: 'shop' }],
        });
        await root.close();
    }, 180_000);

    afterAll(async () => {
        await server?.stop();
    });

    it('logs in against admin, and reports the roles', async () => {
        const session = await connect(server, {
            username: 'root',
            password: 'pw',
            database: undefined,
        });
        try {
            expect(session.info.user).toBe('root');
            expect(await session.getPermissions()).toMatchObject({
                read: true,
                write: true,
                schema: true,
            });
        } finally {
            await session.close();
        }
    });

    it('explains a wrong login, and where the user was looked for', async () => {
        const failure = await connect(server, {
            username: 'reader',
            password: 'pw',
            database: 'shop',
        }).then(
            async (s) => {
                await s.close();
                return null;
            },
            (error: unknown) => error,
        );
        expect(failure).toBeNull(); // defined in shop, so authSource defaults to shop

        await expect(
            connect(server, { username: 'root', password: 'pw', database: 'shop' }),
        ).rejects.toMatchObject({
            code: 'AUTH_FAILED',
            message: expect.stringContaining('Auth source'),
        });
        const session = await connect(server, {
            username: 'root',
            password: 'pw',
            database: 'shop',
            options: { authSource: 'admin' },
        });
        await session.close();
    });

    it('reads a read-only user’s permissions, and is refused writes', async () => {
        const session = await connect(server, {
            username: 'reader',
            password: 'pw',
            database: 'shop',
        });
        try {
            expect(await session.getPermissions()).toMatchObject({
                read: true,
                write: false,
                schema: false,
            });
            await expect(
                collect(session.execute('db.x.insertOne({ a: 1 })')),
            ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
        } finally {
            await session.close();
        }
    });
});
