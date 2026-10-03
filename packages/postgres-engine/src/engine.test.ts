// @vitest-environment node
/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

/*
 * These tests run against a scripted server (`startFakePostgres`), because no PostgreSQL is
 * installed on the machine they were written on. They prove how the engine reads the protocol and
 * maps catalog rows, cancels, times out, pools browsing connections and quotes. They do NOT prove
 * that the catalog SQL the engine sends is valid on a real server: the fake does not parse SQL.
 * Run the same flows against a real PostgreSQL before relying on the browsing queries.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
    isRelationalSession,
    type ConnectionConfig,
    type DbValue,
    type Execution,
    type RelationalSession,
    type ResultEvent,
} from '@httpreq/db-core';
import { startFakePostgres, type FakePostgres, type PgColumnSpec } from '@httpreq/test-servers';
import { postgresProvider } from './index';

let servers: FakePostgres[] = [];
let sessions: RelationalSession[] = [];

afterEach(async () => {
    for (const session of sessions) await session.close().catch(() => undefined);
    sessions = [];
    await Promise.all(servers.map((s) => s.stop()));
    servers = [];
});

const TEXT = 25;
const INT8 = 20;
const INT4 = 23;
const BOOL = 16;
const col = (name: string, oid: number, modifier?: number): PgColumnSpec => ({
    name,
    oid,
    ...(modifier !== undefined ? { modifier } : {}),
});

const open = async (
    config: Partial<ConnectionConfig> = {},
    options: Parameters<typeof startFakePostgres>[0] = { auth: 'scram' },
    prepare?: (server: FakePostgres) => void,
) => {
    const server = await startFakePostgres(options);
    servers.push(server);
    server.on(/^SELECT version\(\)$/, {
        columns: [col('version', TEXT)],
        rows: [['PostgreSQL 16.3 on x86_64-pc-linux-gnu']],
    });
    prepare?.(server);
    const session = await postgresProvider
        .createConnector({
            engine: 'postgresql',
            host: server.host,
            port: server.port,
            username: 'postgres',
            password: 'secret',
            database: 'shop',
            tls: { mode: 'disable' },
            connectTimeoutMs: 3000,
            queryTimeoutMs: 0,
            options: {},
            ...config,
        })
        .connect();
    if (!isRelationalSession(session)) throw new Error('expected a SQL session');
    sessions.push(session);
    return { server, session };
};

const collect = async (execution: Execution) => {
    const out: {
        columns: { name: string; type: string }[];
        rows: DbValue[][];
        ends: Extract<ResultEvent, { kind: 'end' }>[];
    } = {
        columns: [],
        rows: [],
        ends: [],
    };
    for await (const event of execution as AsyncIterable<ResultEvent>) {
        if (event.kind === 'columns') out.columns = event.columns;
        else if (event.kind === 'rows') out.rows.push(...event.rows);
        else out.ends.push(event);
    }
    return out;
};

describe('connecting', () => {
    it('reports the product, version, user and encryption', async () => {
        const { session } = await open({}, { auth: 'scram', version: '16.3 (Debian 16.3-1)' });
        expect(session.info).toMatchObject({
            product: 'PostgreSQL',
            version: '16.3',
            user: 'postgres',
            secure: false,
        });
        expect(Number(session.info.connectionId)).toBeGreaterThan(0);
    });

    it('recognises CockroachDB from its banner', async () => {
        const server = await startFakePostgres({ auth: 'trust' });
        servers.push(server);
        server.on(/^SELECT version\(\)$/, {
            columns: [col('version', TEXT)],
            rows: [['CockroachDB CCL v23.2.4 (x86_64-pc-linux-gnu)']],
        });
        const session = await postgresProvider
            .createConnector({
                engine: 'postgresql',
                host: server.host,
                port: server.port,
                username: 'root',
                tls: { mode: 'disable' },
                connectTimeoutMs: 3000,
                queryTimeoutMs: 0,
                options: {},
            })
            .connect();
        sessions.push(session as RelationalSession);
        expect(session.info).toMatchObject({ product: 'CockroachDB', version: '23.2.4' });
    });

    it('needs a user name, and reports a wrong password', async () => {
        await expect(open({ username: undefined })).rejects.toMatchObject({
            code: 'INVALID_REQUEST',
        });
        await expect(open({ password: 'wrong' })).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    });

    it('connects to the database named, or the user’s own', async () => {
        const { server } = await open({ database: 'shop' });
        expect(server.startups[0]).toMatchObject({
            user: 'postgres',
            database: 'shop',
            client_encoding: 'UTF8',
        });
        const second = await open({ database: undefined });
        expect(second.server.startups[0]!.database).toBe('postgres');
    });
});

describe('running statements', () => {
    it('labels columns with their types, including length and precision', async () => {
        const { session } = await open({}, { auth: 'trust' }, (server) => {
            server.on(/SELECT typed/, {
                columns: [
                    col('id', INT8),
                    col('name', 1043, 68),
                    col('price', 1700, ((10 << 16) | 2) + 4),
                    col('tags', 1009),
                    col('ok', BOOL),
                    col('code', 1042, 8),
                ],
                rows: [['1', 'Ada', '12.50', '{a,b}', 't', 'AB  ']],
            });
        });
        const result = await collect(session.execute('SELECT typed'));
        expect(result.columns.map((c) => [c.name, c.type])).toEqual([
            ['id', 'bigint'],
            ['name', 'varchar(64)'],
            ['price', 'numeric(10,2)'],
            ['tags', 'text[]'],
            ['ok', 'boolean'],
            ['code', 'char(4)'],
        ]);
        expect(result.rows).toEqual([[1, 'Ada', '12.50', ['a', 'b'], true, 'AB  ']]);
        expect(result.ends[0]).toMatchObject({ rowCount: 1 });
    });

    it('asks the server for the name of a type it does not know, once', async () => {
        const { session, server } = await open({}, { auth: 'trust' }, (s) => {
            s.on(/SELECT custom/, { columns: [col('mood', 99001)], rows: [['happy']] });
            s.on(/FROM pg_type/, {
                columns: [col('oid', INT8), col('format_type', TEXT)],
                rows: [['99001', 'mood']],
            });
        });
        expect((await collect(session.execute('SELECT custom'))).columns[0]).toEqual({
            name: 'mood',
            type: 'mood',
        });
        await collect(session.execute('SELECT custom'));
        expect(server.queries.filter((q) => q.includes('pg_type'))).toHaveLength(1);
    });

    it('reports row counts, affected rows and notices', async () => {
        const { session } = await open({}, { auth: 'trust' }, (server) => {
            server.on(/^INSERT/, { many: [{ notice: 'inserting' }, { tag: 'INSERT 0 3' }] });
            server.on(/^CREATE/, { tag: 'CREATE TABLE' });
        });
        const insert = await collect(session.execute('INSERT INTO t VALUES (1),(2),(3)'));
        expect(insert.ends.at(-1)).toMatchObject({ affectedRows: 3 });
        expect(insert.ends.at(-1)!.info).toContain('INSERT 0 3');
        expect((await collect(session.execute('CREATE TABLE x (a int)'))).ends[0]).toMatchObject({
            info: 'CREATE TABLE',
        });
    });

    it('passes a server error through with its meaning, and keeps working', async () => {
        const { session } = await open({}, { auth: 'trust' }, (server) => {
            server.on(/missing/, {
                error: {
                    code: '42P01',
                    message: 'relation "missing" does not exist',
                    position: 15,
                },
            });
            server.on(/^SELECT 1$/, { columns: [col('n', INT4)], rows: [['1']] });
        });
        await expect(collect(session.execute('SELECT * FROM missing'))).rejects.toMatchObject({
            code: 'QUERY_FAILED',
            server: { state: '42P01' },
        });
        expect((await collect(session.execute('SELECT 1'))).rows).toEqual([[1]]);
    });

    it('cancels a running statement through a second connection', async () => {
        const { session, server } = await open({}, { auth: 'trust' }, (s) =>
            s.on(/sleep/, { hang: true }),
        );
        const execution = session.execute('SELECT pg_sleep(60)');
        const pending = collect(execution).then(
            () => null,
            (error: unknown) => error,
        );
        setTimeout(() => void execution.cancel(), 100);
        expect(await pending).toMatchObject({ code: 'CANCELLED' });
        expect(server.cancels()).toBe(1);
    });

    it('stops a statement that outlives the time limit', async () => {
        const { session } = await open({}, { auth: 'trust' }, (s) => s.on(/sleep/, { hang: true }));
        const started = Date.now();
        await expect(
            collect(session.execute('SELECT pg_sleep(60)', { timeoutMs: 200 })),
        ).rejects.toMatchObject({ code: 'TIMEOUT' });
        expect(Date.now() - started).toBeLessThan(5000);
        expect(session.alive).toBe(true);
    });

    it('streams a large result in pages', async () => {
        const { session } = await open({}, { auth: 'trust' }, (s) =>
            s.on(/big/, {
                generate: { columns: [col('n', INT4)], count: 50_000, row: (i) => [String(i)] },
            }),
        );
        let pages = 0;
        let rows = 0;
        for await (const event of session.execute('SELECT big', { pageRows: 500 })) {
            if (event.kind === 'rows') {
                pages++;
                rows += event.rows.length;
            }
        }
        expect(rows).toBe(50_000);
        expect(pages).toBeGreaterThanOrEqual(100);
    });

    it('begins, commits and rolls back with the server’s own statements', async () => {
        const { session, server } = await open({}, { auth: 'trust' }, (s) =>
            s.on(/^(BEGIN|COMMIT|ROLLBACK)$/, { tag: 'OK' }),
        );
        await session.begin();
        await session.commit();
        await session.begin();
        await session.rollback();
        expect(server.queries.filter((q) => /^(BEGIN|COMMIT|ROLLBACK)$/.test(q))).toEqual([
            'BEGIN',
            'COMMIT',
            'BEGIN',
            'ROLLBACK',
        ]);
    });

    it('explains a statement with the structured plan and the text', async () => {
        const { session } = await open({}, { auth: 'trust' }, (s) => {
            s.on(/^EXPLAIN \(FORMAT JSON\)/, {
                columns: [col('QUERY PLAN', 114)],
                rows: [['[{"Plan": {"Node Type": "Seq Scan", "Relation Name": "t"}}]']],
            });
            s.on(/^EXPLAIN SELECT/, {
                columns: [col('QUERY PLAN', TEXT)],
                rows: [['Seq Scan on t  (cost=0.00..1.01 rows=1 width=4)']],
            });
        });
        const plan = await session.explain('SELECT * FROM t');
        expect(plan.text).toContain('Seq Scan on t');
        expect(plan.tree).toEqual([{ Plan: { 'Node Type': 'Seq Scan', 'Relation Name': 't' } }]);
    });
});

describe('quoting', () => {
    it('quotes identifiers and literals', async () => {
        const { session } = await open({}, { auth: 'trust' });
        expect(session.quoteIdentifier('Odd "name"')).toBe('"Odd ""name"""');
        expect(session.quoteLiteral("it's")).toBe("'it''s'");
        expect(session.quoteLiteral('a\\b')).toBe("'a\\b'");
    });

    it('escapes backslashes when the server does not use standard strings', async () => {
        const { session } = await open(
            {},
            { auth: 'trust', parameters: { standard_conforming_strings: 'off' } },
        );
        expect(session.quoteLiteral("a\\b'c")).toBe("E'a\\\\b''c'");
    });
});

describe('browsing', () => {
    it('lists databases, schemas and tables with estimates', async () => {
        const { session, server } = await open({}, { auth: 'trust' }, (s) => {
            s.on(/FROM pg_database/, {
                columns: [col('datname', TEXT)],
                rows: [['postgres'], ['shop']],
            });
            s.on(/FROM pg_namespace WHERE nspname !~/, {
                columns: [col('nspname', TEXT)],
                rows: [['information_schema'], ['pg_catalog'], ['public'], ['sales']],
            });
            s.on(/FROM pg_class c JOIN pg_namespace n/, {
                columns: [
                    col('relname', TEXT),
                    col('relkind', TEXT),
                    col('reltuples', INT8),
                    col('size', INT8),
                    col('comment', TEXT),
                ],
                rows: [
                    ['orders', 'r', '1200', '65536', 'All orders'],
                    ['v_sales', 'v', '-1', '0', null],
                    ['events', 'p', '-1', '8192', null],
                ],
            });
        });
        expect(await session.listDatabases()).toEqual([
            { name: 'postgres', system: false },
            { name: 'shop', system: false },
        ]);
        expect(await session.listSchemas()).toEqual([
            { name: 'information_schema', system: true },
            { name: 'pg_catalog', system: true },
            { name: 'public', system: false },
            { name: 'sales', system: false },
        ]);
        const tables = await session.listTables({ schema: 'sales' });
        expect(tables).toEqual([
            {
                database: undefined,
                schema: 'sales',
                name: 'orders',
                kind: 'table',
                rows: 1200,
                bytes: 65536,
                comment: 'All orders',
            },
            { database: undefined, schema: 'sales', name: 'v_sales', kind: 'view', bytes: 0 },
            { database: undefined, schema: 'sales', name: 'events', kind: 'table', bytes: 8192 },
        ]);
        expect(server.queries.find((q) => q.includes('FROM pg_class'))).toContain(
            "n.nspname = 'sales'",
        );
    });

    it('opens a separate connection to browse another database, and reuses it', async () => {
        const { session, server } = await open({}, { auth: 'trust' }, (s) =>
            s.on(/FROM pg_namespace WHERE nspname !~/, {
                columns: [col('nspname', TEXT)],
                rows: [['public']],
            }),
        );
        await session.listSchemas();
        const before = server.startups.length;
        await session.listSchemas('analytics');
        await session.listSchemas('analytics');
        expect(server.startups.length).toBe(before + 1);
        expect(server.startups.at(-1)!.database).toBe('analytics');
    });

    it('keeps the number of browsing connections bounded', async () => {
        const { session, server } = await open({}, { auth: 'trust' }, (s) =>
            s.on(/FROM pg_namespace WHERE nspname !~/, {
                columns: [col('nspname', TEXT)],
                rows: [['public']],
            }),
        );
        for (const name of ['a', 'b', 'c', 'd', 'e', 'f']) await session.listSchemas(name);
        await new Promise((resolve) => setTimeout(resolve, 100));
        // The session itself, plus at most four for browsing; the dropped ones were closed.
        expect(server.startups.length).toBeGreaterThanOrEqual(6);
        expect(
            (session as unknown as { browsing: Map<string, unknown> }).browsing.size,
        ).toBeLessThanOrEqual(4);
    });

    it('maps columns, indexes and constraints', async () => {
        const { session } = await open({}, { auth: 'trust' }, (s) => {
            s.on(/FROM pg_attribute a/, {
                columns: [
                    col('attname', TEXT),
                    col('attnum', INT4),
                    col('type', TEXT),
                    col('nullable', BOOL),
                    col('default', TEXT),
                    col('pk', BOOL),
                    col('auto', BOOL),
                    col('comment', TEXT),
                ],
                rows: [
                    [
                        'id',
                        '1',
                        'integer',
                        'f',
                        "nextval('orders_id_seq'::regclass)",
                        't',
                        't',
                        null,
                    ],
                    ['note', '2', 'text', 't', null, 'f', 'f', 'free text'],
                ],
            });
            s.on(/FROM pg_index ix JOIN pg_class i/, {
                columns: [
                    col('relname', TEXT),
                    col('unique', BOOL),
                    col('primary', BOOL),
                    col('am', TEXT),
                    col('cols', 1009),
                ],
                rows: [
                    ['orders_pkey', 't', 't', 'btree', '{id}'],
                    [
                        'orders_note_idx',
                        'f',
                        'f',
                        'gin',
                        '{"to_tsvector(\'english\'::regconfig, note)"}',
                    ],
                ],
            });
            s.on(/FROM pg_constraint c/, {
                columns: [
                    col('conname', TEXT),
                    col('contype', TEXT),
                    col('cols', 1009),
                    col('ref', TEXT),
                    col('refcols', 1009),
                    col('def', TEXT),
                ],
                rows: [
                    ['orders_pkey', 'p', '{id}', '-', null, 'PRIMARY KEY (id)'],
                    [
                        'orders_customer_fk',
                        'f',
                        '{customer_id}',
                        'customers',
                        '{id}',
                        'FOREIGN KEY (customer_id) REFERENCES customers(id)',
                    ],
                ],
            });
        });
        const table = { schema: 'public', name: 'orders' };
        const columns = await session.listColumns(table);
        expect(columns[0]).toEqual({
            name: 'id',
            position: 1,
            type: 'integer',
            nullable: false,
            default: "nextval('orders_id_seq'::regclass)",
            primaryKey: true,
            autoIncrement: true,
        });
        expect(columns[1]).toMatchObject({ name: 'note', nullable: true, comment: 'free text' });
        expect(columns[1]).not.toHaveProperty('default');
        expect(await session.listIndexes(table)).toEqual([
            { name: 'orders_pkey', columns: ['id'], unique: true, primary: true, method: 'btree' },
            {
                name: 'orders_note_idx',
                columns: ["to_tsvector('english'::regconfig, note)"],
                unique: false,
                primary: false,
                method: 'gin',
            },
        ]);
        const constraints = await session.listConstraints(table);
        expect(constraints[1]).toEqual({
            name: 'orders_customer_fk',
            kind: 'FOREIGN KEY',
            columns: ['customer_id'],
            references: { table: 'customers', columns: ['id'] },
            definition: 'FOREIGN KEY (customer_id) REFERENCES customers(id)',
        });
    });

    it('quotes the table name it looks up, so odd names cannot break out of the query', async () => {
        const { session, server } = await open({}, { auth: 'trust' }, (s) =>
            s.on(/FROM pg_attribute a/, { columns: [col('attname', TEXT)], rows: [] }),
        );
        await session.listColumns({ schema: 'pub"lic', name: "x'; DROP TABLE y; --" });
        const sent = server.queries.find((q) => q.includes('pg_attribute'))!;
        expect(sent).toContain(`'"pub""lic"."x''; DROP TABLE y; --"'::regclass`);
    });

    it('maps routines and triggers', async () => {
        const { session } = await open({}, { auth: 'trust' }, (s) => {
            s.on(/FROM pg_proc p JOIN pg_namespace/, {
                columns: [col('proname', TEXT), col('kind', TEXT), col('returns', TEXT)],
                rows: [
                    ['add', 'f', 'integer'],
                    ['refresh', 'p', null],
                ],
            });
            s.on(/FROM pg_trigger t JOIN pg_class c/, {
                columns: [col('tgname', TEXT), col('relname', TEXT), col('tgtype', INT4)],
                rows: [
                    ['audit', 'orders', String(1 | 4 | 16)],
                    ['guard', 'orders', String(2 | 8 | 64)],
                ],
            });
        });
        expect(await session.listRoutines({ schema: 'public' })).toEqual([
            {
                database: undefined,
                schema: 'public',
                name: 'add',
                kind: 'function',
                returns: 'integer',
            },
            { database: undefined, schema: 'public', name: 'refresh', kind: 'procedure' },
        ]);
        const triggers = await session.listTriggers({ schema: 'public' });
        expect(triggers[0]).toMatchObject({
            name: 'audit',
            table: 'orders',
            timing: 'AFTER',
            event: 'INSERT OR UPDATE',
        });
        expect(triggers[1]).toMatchObject({ timing: 'INSTEAD OF', event: 'DELETE' });
    });

    it('rebuilds definitions', async () => {
        const { session } = await open({}, { auth: 'trust' }, (s) => {
            s.on(/pg_get_viewdef/, { columns: [col('def', TEXT)], rows: [[' SELECT 1 AS one;']] });
            s.on(/pg_get_functiondef/, {
                columns: [col('def', TEXT)],
                rows: [['CREATE FUNCTION add() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql']],
            });
            s.on(/pg_get_triggerdef/, {
                columns: [col('def', TEXT)],
                rows: [
                    [
                        'CREATE TRIGGER audit AFTER INSERT ON orders FOR EACH ROW EXECUTE FUNCTION f()',
                    ],
                ],
            });
            s.on(/FROM pg_attribute a/, {
                columns: [
                    col('attname', TEXT),
                    col('attnum', INT4),
                    col('type', TEXT),
                    col('nullable', BOOL),
                    col('default', TEXT),
                    col('pk', BOOL),
                    col('auto', BOOL),
                    col('comment', TEXT),
                ],
                rows: [
                    ['id', '1', 'integer', 'f', null, 't', 'f', null],
                    ['name', '2', 'text', 't', "'x'::text", 'f', 'f', null],
                ],
            });
            s.on(/FROM pg_constraint c/, {
                columns: [
                    col('conname', TEXT),
                    col('contype', TEXT),
                    col('cols', 1009),
                    col('ref', TEXT),
                    col('refcols', 1009),
                    col('def', TEXT),
                ],
                rows: [['orders_pkey', 'p', '{id}', '-', null, 'PRIMARY KEY (id)']],
            });
            s.on(/pg_get_indexdef\(ix\.indexrelid, 0, true\)/, {
                columns: [col('def', TEXT)],
                rows: [['CREATE INDEX orders_name_idx ON public.orders USING btree (name)']],
            });
        });
        expect(await session.getDefinition({ schema: 'public', name: 'v', kind: 'view' })).toBe(
            'CREATE OR REPLACE VIEW "public"."v" AS\nSELECT 1 AS one;',
        );
        expect(
            await session.getDefinition({ schema: 'public', name: 'add', kind: 'routine' }),
        ).toContain('CREATE FUNCTION add()');
        expect(
            await session.getDefinition({ schema: 'public', name: 'audit', kind: 'trigger' }),
        ).toContain('CREATE TRIGGER audit');
        const table = await session.getDefinition({
            schema: 'public',
            name: 'orders',
            kind: 'table',
        });
        expect(table).toContain('CREATE TABLE "public"."orders" (');
        expect(table).toContain('"id" integer NOT NULL');
        expect(table).toContain(`"name" text DEFAULT 'x'::text`);
        expect(table).toContain('CONSTRAINT "orders_pkey" PRIMARY KEY (id)');
        expect(table).toContain('CREATE INDEX orders_name_idx');
    });

    it('says a missing object does not exist', async () => {
        const { session } = await open({}, { auth: 'trust' }, (s) => {
            s.on(/pg_get_functiondef/, { columns: [col('def', TEXT)], rows: [] });
            s.on(/FROM pg_attribute a/, { columns: [col('n', TEXT)], rows: [] });
        });
        await expect(
            session.getDefinition({ schema: 'public', name: 'nope', kind: 'routine' }),
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
        await expect(
            session.getDefinition({ schema: 'public', name: 'nope', kind: 'table' }),
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('lists and ends sessions', async () => {
        const { session, server } = await open({}, { auth: 'trust' }, (s) => {
            s.on(/FROM pg_stat_activity/, {
                columns: [
                    col('pid', INT4),
                    col('usename', TEXT),
                    col('datname', TEXT),
                    col('state', TEXT),
                    col('secs', 701),
                    col('query', TEXT),
                ],
                rows: [
                    ['123', 'ada', 'shop', 'active', '4.6', 'SELECT 1'],
                    ['124', null, null, 'idle', null, ''],
                ],
            });
            s.on(/pg_terminate_backend\(123\)/, { columns: [col('t', BOOL)], rows: [['t']] });
            s.on(/pg_terminate_backend\(999\)/, { columns: [col('t', BOOL)], rows: [['f']] });
        });
        expect(await session.listSessions()).toEqual([
            {
                id: '123',
                user: 'ada',
                database: 'shop',
                state: 'active',
                seconds: 5,
                statement: 'SELECT 1',
            },
            { id: '124', state: 'idle' },
        ]);
        await session.killSession('123');
        await expect(session.killSession('999')).rejects.toMatchObject({ code: 'NOT_FOUND' });
        await expect(session.killSession('1; DROP TABLE x')).rejects.toMatchObject({
            code: 'INVALID_REQUEST',
        });
        expect(server.queries.some((q) => q.includes('DROP'))).toBe(false);
    });

    it('reads server status and permissions', async () => {
        const { session } = await open({}, { auth: 'trust' }, (s) => {
            s.on(/FROM pg_settings/, {
                columns: [col('name', TEXT), col('setting', TEXT)],
                rows: [
                    ['max_connections', '100'],
                    ['shared_buffers', '16384'],
                ],
            });
            s.on(/pg_postmaster_start_time/, {
                columns: [
                    col('v', TEXT),
                    col('started', TEXT),
                    col('count', INT8),
                    col('size', INT8),
                ],
                rows: [['PostgreSQL 16.3', '2026-01-01 00:00:00+00', '7', '8192000']],
            });
            s.on(/FROM pg_roles r/, {
                columns: [
                    col('a', BOOL),
                    col('b', BOOL),
                    col('c', BOOL),
                    col('d', BOOL),
                    col('e', BOOL),
                ],
                rows: [['f', 't', 'f', 't', 'f']],
            });
        });
        const status = await session.serverStatus();
        expect(status).toMatchObject({
            max_connections: '100',
            connections: '7',
            database_size_bytes: '8192000',
        });
        expect(await session.getPermissions()).toEqual({
            read: true,
            write: false,
            schema: true,
            grants: ['createdb'],
        });
    });

    it('browses while a statement is running', async () => {
        const { session } = await open({}, { auth: 'trust' }, (s) => {
            s.on(/sleep/, { hang: true });
            s.on(/FROM pg_database/, { columns: [col('datname', TEXT)], rows: [['shop']] });
        });
        const execution = session.execute('SELECT pg_sleep(60)');
        const running = collect(execution).then(
            () => null,
            (error: unknown) => error,
        );
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(await session.listDatabases()).toEqual([{ name: 'shop', system: false }]);
        await execution.cancel();
        expect(await running).toMatchObject({ code: 'CANCELLED' });
    });
});
