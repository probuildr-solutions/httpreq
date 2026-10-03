/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
    isRelationalSession,
    type ConnectionConfig,
    type RelationalSession,
    type ResultEvent,
} from '@httpreq/db-core';
import { startMysql, type TestServer } from '@httpreq/test-servers';
import { mysqlProvider, MysqlSession } from './index';

let server: TestServer | null = null;
let session: MysqlSession;

const config = (user: string, extra: Partial<ConnectionConfig> = {}): ConnectionConfig => ({
    engine: 'mysql',
    host: server!.host,
    port: server!.port,
    username: user,
    password: server!.users[user],
    tls: { mode: 'disable' },
    connectTimeoutMs: 10_000,
    queryTimeoutMs: 0,
    options: {},
    ...extra,
});

const open = async (user = 'app', extra: Partial<ConnectionConfig> = {}) =>
    (await mysqlProvider.createConnector(config(user, extra)).connect()) as MysqlSession;

const all = async (target: RelationalSession, sql: string) => {
    const events: ResultEvent[] = [];
    for await (const event of target.execute(sql)) events.push(event);
    return events;
};

const rows = (events: ResultEvent[]) => events.flatMap((e) => (e.kind === 'rows' ? e.rows : []));

beforeAll(async () => {
    server = await startMysql();
    if (!server) return;
    session = await open('app');
    for (const sql of [
        'USE shop',
        `CREATE TABLE customers (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(80) NOT NULL COMMENT 'Full name', email VARCHAR(120) UNIQUE, created DATETIME DEFAULT CURRENT_TIMESTAMP) COMMENT='People'`,
        `CREATE TABLE orders (id INT AUTO_INCREMENT PRIMARY KEY, customer_id INT NOT NULL, total DECIMAL(10,2) NOT NULL DEFAULT 0.00,
            KEY idx_customer (customer_id), CONSTRAINT fk_customer FOREIGN KEY (customer_id) REFERENCES customers(id), CONSTRAINT chk_total CHECK (total >= 0))`,
        'CREATE VIEW big_orders AS SELECT * FROM orders WHERE total > 100',
        'CREATE PROCEDURE add_customer(IN n VARCHAR(80)) INSERT INTO customers (name) VALUES (n)',
        'CREATE FUNCTION double_it(x INT) RETURNS INT DETERMINISTIC RETURN x * 2',
        'CREATE TRIGGER orders_bi BEFORE INSERT ON orders FOR EACH ROW SET NEW.total = ABS(NEW.total)',
        'CREATE EVENT nightly ON SCHEDULE EVERY 1 DAY DO SELECT 1',
    ]) {
        await all(session, sql === 'USE shop' ? 'USE shop' : sql);
    }
}, 180_000);
afterAll(async () => {
    await session?.close();
    await server?.stop();
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

describe('provider', () => {
    it('describes itself and declares its capabilities', () => {
        expect(mysqlProvider.id).toBe('mysql');
        expect(mysqlProvider.defaultPort).toBe(3306);
        expect(mysqlProvider.capabilities.has('sql')).toBe(true);
        expect(mysqlProvider.capabilities.has('documents')).toBe(false);
        expect(mysqlProvider.capabilities.has('events')).toBe(true);
    });

    it('needs a user name', async () => {
        const connector = mysqlProvider.createConnector({
            engine: 'mysql',
            host: '127.0.0.1',
            port: 1,
            tls: { mode: 'disable' },
            connectTimeoutMs: 1000,
            queryTimeoutMs: 0,
            options: {},
        });
        await expect(connector.connect()).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    });
});

describe('session', () => {
    live('reports the server, the user and that it is a relational session', async () => {
        expect(isRelationalSession(session)).toBe(true);
        expect(session.info.product).toMatch(/MySQL|MariaDB/);
        expect(session.info.version).toMatch(/^\d+\.\d+/);
        expect(session.info.user).toMatch(/^app@/);
        expect(session.info.secure).toBe(false);
        await session.ping();
    });

    live('lists databases, putting system ones in their own group', async () => {
        const databases = await session.listDatabases();
        expect(databases.find((d) => d.name === 'shop')).toEqual({ name: 'shop', system: false });
        expect(databases.find((d) => d.name === 'mysql')?.system).toBe(true);
        expect(await session.listSchemas()).toEqual([]);
    });

    live('lists tables and views with their statistics', async () => {
        const tables = await session.listTables({ database: 'shop' });
        expect(tables.map((t) => [t.name, t.kind])).toEqual([
            ['big_orders', 'view'],
            ['customers', 'table'],
            ['orders', 'table'],
        ]);
        expect(tables.find((t) => t.name === 'customers')?.comment).toBe('People');
    });

    live('describes columns, indexes and constraints', async () => {
        const columns = await session.listColumns({ database: 'shop', name: 'customers' });
        expect(columns.map((c) => [c.name, c.type, c.nullable, c.primaryKey])).toEqual([
            ['id', 'int', false, true],
            ['name', 'varchar(80)', false, false],
            ['email', 'varchar(120)', true, false],
            ['created', 'datetime', true, false],
        ]);
        expect(columns[0]).toMatchObject({ autoIncrement: true, position: 1 });
        expect(columns[1]!.comment).toBe('Full name');
        expect(columns[3]!.default).toMatch(/CURRENT_TIMESTAMP/i);

        const indexes = await session.listIndexes({ database: 'shop', name: 'customers' });
        expect(indexes.find((i) => i.primary)).toMatchObject({ columns: ['id'], unique: true });
        expect(indexes.find((i) => i.name === 'email')).toMatchObject({
            columns: ['email'],
            unique: true,
            method: 'BTREE',
        });

        const constraints = await session.listConstraints({ database: 'shop', name: 'orders' });
        const fk = constraints.find((c) => c.kind === 'FOREIGN KEY')!;
        expect(fk).toMatchObject({
            name: 'fk_customer',
            columns: ['customer_id'],
            references: { table: 'customers', columns: ['id'] },
        });
        expect(constraints.some((c) => c.kind === 'PRIMARY KEY')).toBe(true);
    });

    live('lists routines, triggers and events, and shows definitions', async () => {
        expect(
            (await session.listRoutines({ database: 'shop' })).map((r) => [r.name, r.kind]),
        ).toEqual([
            ['add_customer', 'procedure'],
            ['double_it', 'function'],
        ]);
        expect(await session.listTriggers({ database: 'shop' })).toEqual([
            {
                database: 'shop',
                name: 'orders_bi',
                table: 'orders',
                timing: 'BEFORE',
                event: 'INSERT',
            },
        ]);
        expect(await session.listEvents({ database: 'shop' })).toEqual([
            { name: 'nightly', status: 'ENABLED', schedule: 'every 1 DAY' },
        ]);

        expect(
            await session.getDefinition({ database: 'shop', name: 'customers', kind: 'table' }),
        ).toMatch(/CREATE TABLE `customers`/);
        expect(
            await session.getDefinition({ database: 'shop', name: 'big_orders', kind: 'view' }),
        ).toMatch(/VIEW `shop`\.`big_orders`/);
        expect(
            await session.getDefinition({ database: 'shop', name: 'double_it', kind: 'function' }),
        ).toMatch(/FUNCTION `double_it`/);
        expect(
            await session.getDefinition({ database: 'shop', name: 'orders_bi', kind: 'trigger' }),
        ).toMatch(/TRIGGER `orders_bi`/);
        await expect(session.getDefinition({ name: 'x', kind: 'galaxy' })).rejects.toMatchObject({
            code: 'INVALID_REQUEST',
        });
    });

    live('shows what the account may do', async () => {
        const full = await session.getPermissions();
        expect(full).toMatchObject({ read: true, write: true, schema: true });
        const limited = await open('limited');
        expect(await limited.getPermissions()).toMatchObject({
            read: true,
            write: false,
            schema: false,
        });
        // The database permission is enforced by the server, not just reported.
        await expect(all(limited, 'CREATE TABLE shop.nope (a INT)')).rejects.toMatchObject({
            code: 'PERMISSION_DENIED',
        });
        await limited.close();
    });

    live('lists sessions and the server status, and can kill another session', async () => {
        const other = await open('app');
        const sessions = await session.listSessions();
        expect(sessions.some((s) => s.id === other.info.connectionId)).toBe(true);
        const status = await session.serverStatus();
        expect(Number(status.Uptime)).toBeGreaterThan(0);
        await session.killSession(other.info.connectionId!);
        await expect(session.killSession('1; DROP TABLE x')).rejects.toMatchObject({
            code: 'INVALID_REQUEST',
        });
        await other.close();
    });

    live('explains a query as text and as a tree', async () => {
        const plan = await session.explain('SELECT * FROM shop.orders WHERE customer_id = 1');
        expect(plan.text.length).toBeGreaterThan(0);
        expect(plan.tree).toBeTruthy();
    });
});

describe('quoting', () => {
    live('quotes identifiers with backticks, doubling embedded ones', () => {
        expect(session.quoteIdentifier('a`b')).toBe('`a``b`');
        return Promise.resolve();
    });

    live('round-trips awkward text through a statement built with quoteLiteral', async () => {
        await all(session, 'CREATE TABLE IF NOT EXISTS shop.quotes (v TEXT)');
        const awkward = [
            "it's",
            'back\\slash',
            'line\nbreak',
            'nul\0byte',
            '"dq"',
            "'; DROP TABLE shop.quotes; --",
            'üñíçødé 日本',
            '\x1a',
        ];
        for (const value of awkward) {
            await all(session, `INSERT INTO shop.quotes VALUES (${session.quoteLiteral(value)})`);
        }
        const stored = rows(await all(session, 'SELECT v FROM shop.quotes')).map((r) => r[0]);
        expect(stored).toEqual(awkward);
        await all(session, 'DROP TABLE shop.quotes');
    });
});

describe('executing', () => {
    live('streams events and supports transactions', async () => {
        const writer = await open('app', { database: 'shop' });
        await writer.begin();
        await all(writer, "INSERT INTO customers (name, email) VALUES ('Ada', 'ada@example.com')");
        expect(rows(await all(writer, 'SELECT COUNT(*) FROM customers'))[0]).toEqual([1]);
        await writer.rollback();
        expect(rows(await all(writer, 'SELECT COUNT(*) FROM customers'))[0]).toEqual([0]);
        await writer.begin();
        await all(writer, "INSERT INTO customers (name) VALUES ('Grace')");
        await writer.commit();
        expect(rows(await all(writer, 'SELECT name FROM customers'))[0]).toEqual(['Grace']);
        await writer.close();
    });

    live('stops a statement on request and keeps the session usable', async () => {
        const worker = await open('app');
        const started = Date.now();
        const execution = worker.execute('SELECT SLEEP(30)');
        const outcome = (async () => {
            for await (const event of execution) void event;
        })();
        await new Promise((resolve) => setTimeout(resolve, 400));
        await execution.cancel();
        await expect(outcome).rejects.toMatchObject({ code: 'CANCELLED' });
        expect(Date.now() - started).toBeLessThan(10_000);
        expect(rows(await all(worker, 'SELECT 5'))[0]).toEqual([5]);
        await worker.close();
    });

    live('stops a statement that runs past its time limit', async () => {
        const worker = await open('app', { queryTimeoutMs: 600 });
        const started = Date.now();
        await expect(all(worker, 'SELECT SLEEP(30)')).rejects.toMatchObject({ code: 'TIMEOUT' });
        expect(Date.now() - started).toBeLessThan(10_000);
        // A statement given its own, longer limit is not affected by the connection's.
        const quick = worker.execute('SELECT SLEEP(0.1)', { timeoutMs: 5_000 });
        for await (const event of quick) void event;
        await worker.close();
    });

    live('stops a statement when the caller aborts', async () => {
        const worker = await open('app');
        const controller = new AbortController();
        const execution = worker.execute('SELECT SLEEP(30)', { signal: controller.signal });
        const outcome = (async () => {
            for await (const event of execution) void event;
        })();
        setTimeout(() => controller.abort(), 300);
        await expect(outcome).rejects.toMatchObject({ code: 'CANCELLED' });
        await worker.close();
    });

    live('browses the schema while a long statement is running', async () => {
        const worker = await open('app');
        const running = (async () => {
            for await (const event of worker.execute('SELECT SLEEP(2)')) void event;
        })();
        await new Promise((resolve) => setTimeout(resolve, 200));
        const started = Date.now();
        expect((await worker.listTables({ database: 'shop' })).length).toBeGreaterThan(0); // second connection
        expect(Date.now() - started).toBeLessThan(1_500);
        await running;
        await worker.close();
    });

    live('reports a failing statement', async () => {
        await expect(all(session, 'SELECT * FROM shop.missing_table')).rejects.toMatchObject({
            code: 'QUERY_FAILED',
            server: { number: 1146, state: '42S02' },
        });
    });
});
