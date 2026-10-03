/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import {
    DbError,
    throwIfAborted,
    type ColumnInfo,
    type ColumnMeta,
    type ConnectionConfig,
    type ConstraintInfo,
    type DatabaseInfo,
    type DbValue,
    type ExecuteOptions,
    type Execution,
    type ExplainPlan,
    type IndexInfo,
    type ObjectRef,
    type PermissionSet,
    type RelationalSession,
    type ResultEvent,
    type RoutineInfo,
    type SchemaInfo,
    type ServerInfo,
    type SessionInfo,
    type TableInfo,
    type TriggerInfo,
} from '@httpreq/db-core';
import {
    OID,
    PgConnection,
    typeName,
    type PgColumn,
    type PgConnectOptions,
} from '@httpreq/db-protocol-postgres';

/** Connections kept for browsing other databases; PostgreSQL connects to one database at a time. */
const MAX_BROWSING_CONNECTIONS = 4;

const text = (value: DbValue | undefined): string =>
    value === null || value === undefined ? '' : String(value);

/** What a column's type looks like: `varchar(64)`, `numeric(10,2)`, `integer[]`. */
const typeLabel = (column: PgColumn, learned: Map<number, string>): string => {
    const base = typeName(column.typeOid) ?? learned.get(column.typeOid) ?? `oid:${column.typeOid}`;
    const modifier = column.modifier;
    if (modifier < 4) return base;
    if (column.typeOid === OID.varchar || column.typeOid === OID.bpchar)
        return `${base}(${modifier - 4})`;
    if (column.typeOid === OID.numeric) {
        const precision = ((modifier - 4) >> 16) & 0xffff;
        const scale = (modifier - 4) & 0xffff;
        return `${base}(${precision},${scale})`;
    }
    return base;
};

interface Browsing {
    connection: Promise<PgConnection>;
    /** Queries on one connection run one at a time. */
    turn: Promise<unknown>;
}

/**
 * A PostgreSQL session. The first connection runs the user's statements. Browsing (schemas,
 * tables, definitions, activity) and cancelling use other connections, because the first is busy
 * while a statement runs and PostgreSQL cannot look into another database from a connection:
 * browsing a database other than the current one opens a connection to that one.
 */
export class PostgresSession implements RelationalSession {
    readonly info: ServerInfo;
    private readonly browsing = new Map<string, Browsing>();
    private readonly learnedTypes = new Map<number, string>();
    private closed = false;
    private readonly defaultDatabase: string;

    private constructor(
        private readonly main: PgConnection,
        private readonly options: PgConnectOptions,
        private readonly config: ConnectionConfig,
        info: ServerInfo,
    ) {
        this.info = info;
        this.defaultDatabase = options.database || options.user;
    }

    static async open(
        options: PgConnectOptions,
        config: ConnectionConfig,
        signal?: AbortSignal,
    ): Promise<PostgresSession> {
        const main = await PgConnection.connect(options, signal);
        try {
            let version = main.serverVersion;
            let product = 'PostgreSQL';
            const probe: DbValue[][] = [];
            for await (const event of main.query('SELECT version()')) {
                if (event.kind === 'rows') probe.push(...event.rows);
            }
            const banner = text(probe[0]?.[0]);
            if (/cockroachdb/i.test(banner)) {
                product = 'CockroachDB';
                version = /CCL v([\d.]+)/.exec(banner)?.[1] ?? version;
            } else if (/yugabyte/i.test(banner)) product = 'YugabyteDB';
            else if (/redshift/i.test(banner)) product = 'Amazon Redshift';
            return new PostgresSession(main, options, config, {
                product,
                version: version.split(' ')[0] ?? version,
                connectionId: String(main.backendPid),
                user: main.parameters.get('session_authorization') ?? options.user,
                secure: main.secure,
            });
        } catch (error) {
            main.destroy();
            throw error;
        }
    }

    get alive(): boolean {
        return !this.closed && !this.main.closed;
    }

    async ping(): Promise<void> {
        await this.main.ping();
    }

    async close(): Promise<void> {
        this.closed = true;
        await this.main.close().catch(() => undefined);
        for (const entry of this.browsing.values()) {
            await (await entry.connection.catch(() => null))?.close().catch(() => undefined);
        }
        this.browsing.clear();
    }

    /* ---------- Statements ---------- */

    execute(sql: string, options: ExecuteOptions = {}): Execution {
        throwIfAborted(options.signal);
        const query = this.main.query(sql, { pageRows: options.pageRows });
        const timeoutMs = options.timeoutMs ?? this.config.queryTimeoutMs;
        let timedOut = false;
        let cancelled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const interrupt = () => this.main.cancel().catch(() => this.main.destroy());
        const cancel = async () => {
            cancelled = true;
            await interrupt();
        };
        if (timeoutMs > 0) {
            timer = setTimeout(() => {
                timedOut = true;
                void interrupt();
            }, timeoutMs);
        }
        const onAbort = () => void cancel();
        options.signal?.addEventListener('abort', onAbort, { once: true });
        const cleanup = () => {
            clearTimeout(timer);
            options.signal?.removeEventListener('abort', onAbort);
        };
        const stopped = () =>
            timedOut
                ? new DbError(
                      'TIMEOUT',
                      'The statement ran longer than the time limit and was stopped.',
                  )
                : new DbError('CANCELLED', 'The statement was cancelled.');
        // eslint-disable-next-line @typescript-eslint/no-this-alias -- used inside the generator
        const session = this;
        const iterate = async function* (): AsyncGenerator<ResultEvent> {
            let notices: string[] = [];
            try {
                for await (const event of query) {
                    switch (event.kind) {
                        case 'columns': {
                            await session.learnTypes(event.columns);
                            const columns: ColumnMeta[] = event.columns.map((column) => ({
                                name: column.name,
                                type: typeLabel(column, session.learnedTypes),
                            }));
                            yield { kind: 'columns', columns };
                            break;
                        }
                        case 'rows':
                            yield event;
                            break;
                        case 'notice':
                            notices.push(`${event.notice.severity}: ${event.notice.message}`);
                            break;
                        case 'end':
                            yield {
                                kind: 'end',
                                ...(event.rowCount !== undefined
                                    ? { rowCount: event.rowCount }
                                    : {}),
                                ...(event.affectedRows !== undefined
                                    ? { affectedRows: event.affectedRows }
                                    : {}),
                                info:
                                    [event.tag, ...notices].filter(Boolean).join('\n') || undefined,
                            };
                            notices = [];
                            break;
                    }
                }
            } catch (error) {
                if (
                    (timedOut || cancelled) &&
                    error instanceof DbError &&
                    error.code === 'CANCELLED'
                )
                    throw stopped();
                throw error;
            } finally {
                cleanup();
            }
        };
        return Object.assign(iterate(), { cancel });
    }

    /** Looks up the names of types this client does not know, once, so columns are labelled. */
    private async learnTypes(columns: PgColumn[]): Promise<void> {
        const unknown = [...new Set(columns.map((c) => c.typeOid))].filter(
            (oid) => typeName(oid) === undefined && !this.learnedTypes.has(oid),
        );
        if (unknown.length === 0) return;
        try {
            const rows = await this.query(
                `SELECT oid::int8, format_type(oid, NULL) FROM pg_type WHERE oid IN (${unknown.map((oid) => Number(oid)).join(',')})`,
            );
            for (const [oid, name] of rows) this.learnedTypes.set(Number(oid), text(name));
        } catch {
            for (const oid of unknown) this.learnedTypes.set(oid, `oid:${oid}`);
        }
    }

    async begin(): Promise<void> {
        await this.drain('BEGIN');
    }

    async commit(): Promise<void> {
        await this.drain('COMMIT');
    }

    async rollback(): Promise<void> {
        await this.drain('ROLLBACK');
    }

    private async drain(sql: string): Promise<void> {
        for await (const event of this.main.query(sql)) void event;
    }

    async explain(sql: string): Promise<ExplainPlan> {
        // EXPLAIN without ANALYZE plans the statement without running it.
        const plan = await this.query(`EXPLAIN (FORMAT JSON) ${sql}`);
        const textPlan = await this.query(`EXPLAIN ${sql}`);
        const tree = plan[0]?.[0];
        return {
            text: textPlan.map((row) => text(row[0])).join('\n'),
            ...(tree !== undefined && tree !== null ? { tree: tree as DbValue } : {}),
        };
    }

    quoteIdentifier(name: string): string {
        return `"${name.replace(/"/g, '""')}"`;
    }

    quoteLiteral(value: string): string {
        if (this.main.parameters.get('standard_conforming_strings') === 'off') {
            return `E'${value.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
        }
        return `'${value.replace(/'/g, "''")}'`;
    }

    /* ---------- Browsing ---------- */

    /** Runs a query on the browsing connection of a database, after whatever is using it. */
    private query(sql: string, database?: string): Promise<DbValue[][]> {
        const key = database ?? this.defaultDatabase;
        const entry = this.browsingFor(key);
        const run = async () => {
            const connection = await entry.connection;
            const rows: DbValue[][] = [];
            for await (const event of connection.query(sql, { pageRows: 5000 })) {
                if (event.kind === 'rows') rows.push(...event.rows);
            }
            return rows;
        };
        const result = entry.turn.then(run, run);
        entry.turn = result.catch(() => undefined);
        return result;
    }

    private browsingFor(database: string): Browsing {
        if (this.closed) throw new DbError('CONNECTION_FAILED', 'The session is closed.');
        const existing = this.browsing.get(database);
        if (existing) {
            // A connection that has died is replaced.
            existing.connection = existing.connection.then(
                (connection) => (connection.closed ? this.connectTo(database) : connection),
                () => this.connectTo(database),
            );
            return existing;
        }
        // Keep the number of extra connections bounded: the oldest of the others is closed.
        if (this.browsing.size >= MAX_BROWSING_CONNECTIONS) {
            const oldest = [...this.browsing.keys()].find((name) => name !== this.defaultDatabase);
            if (oldest) {
                const dropped = this.browsing.get(oldest)!;
                this.browsing.delete(oldest);
                void dropped.connection
                    .then((connection) => connection.close())
                    .catch(() => undefined);
            }
        }
        const entry: Browsing = { connection: this.connectTo(database), turn: Promise.resolve() };
        this.browsing.set(database, entry);
        return entry;
    }

    private connectTo(database: string): Promise<PgConnection> {
        return PgConnection.connect({ ...this.options, database });
    }

    async getPermissions(): Promise<PermissionSet> {
        const rows = await this.query(
            `SELECT r.rolsuper, r.rolcreatedb, r.rolcreaterole,
                    has_schema_privilege(current_schema(), 'CREATE'),
                    EXISTS (SELECT 1 FROM information_schema.table_privileges WHERE grantee = current_user AND privilege_type IN ('INSERT','UPDATE','DELETE'))
             FROM pg_roles r WHERE r.rolname = current_user`,
        );
        const [superuser, createdb, createrole, createInSchema, canWrite] = rows[0] ?? [];
        const attributes = [
            superuser === true ? 'superuser' : null,
            createdb === true ? 'createdb' : null,
            createrole === true ? 'createrole' : null,
        ].filter((name): name is string => name !== null);
        return {
            read: true,
            write: superuser === true || canWrite === true,
            schema: superuser === true || createInSchema === true,
            grants: attributes,
        };
    }

    async listDatabases(): Promise<DatabaseInfo[]> {
        const rows = await this.query(
            'SELECT datname FROM pg_database WHERE datallowconn AND NOT datistemplate ORDER BY datname',
        );
        return rows.map((row) => ({ name: text(row[0]), system: false }));
    }

    async listSchemas(database?: string): Promise<SchemaInfo[]> {
        const rows = await this.query(
            `SELECT nspname FROM pg_namespace WHERE nspname !~ '^pg_(toast|temp)' ORDER BY nspname`,
            database,
        );
        return rows.map((row) => {
            const name = text(row[0]);
            return { name, system: name === 'information_schema' || name.startsWith('pg_') };
        });
    }

    async listTables(scope: { database?: string; schema?: string }): Promise<TableInfo[]> {
        const schema = scope.schema ?? 'public';
        const rows = await this.query(
            `SELECT c.relname, c.relkind::text, c.reltuples::int8, pg_total_relation_size(c.oid), obj_description(c.oid, 'pg_class')
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = ${this.quoteLiteral(schema)} AND c.relkind IN ('r','p','v','m','f')
             ORDER BY c.relname`,
            scope.database,
        );
        const kinds: Record<string, string> = {
            r: 'table',
            p: 'table',
            v: 'view',
            m: 'materialized view',
            f: 'foreign table',
        };
        return rows.map((row) => {
            const estimate = Number(row[2]);
            return {
                database: scope.database,
                schema,
                name: text(row[0]),
                kind: kinds[text(row[1])] ?? 'table',
                // A table that was never analysed reports -1.
                ...(estimate >= 0 ? { rows: estimate } : {}),
                bytes: Number(row[3]),
                ...(row[4] ? { comment: text(row[4]) } : {}),
            };
        });
    }

    /** The regclass literal of a table: quoted, so names with capitals or dots are safe. */
    private regclass(table: ObjectRef): string {
        const name = `${this.quoteIdentifier(table.schema ?? 'public')}.${this.quoteIdentifier(table.name)}`;
        return `${this.quoteLiteral(name)}::regclass`;
    }

    async listColumns(table: ObjectRef): Promise<ColumnInfo[]> {
        const rows = await this.query(
            `SELECT a.attname, a.attnum, format_type(a.atttypid, a.atttypmod), NOT a.attnotnull,
                    pg_get_expr(d.adbin, d.adrelid),
                    EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY (i.indkey)),
                    a.attidentity <> '' OR COALESCE(pg_get_expr(d.adbin, d.adrelid) LIKE 'nextval(%', false),
                    col_description(a.attrelid, a.attnum)
             FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
             WHERE a.attrelid = ${this.regclass(table)} AND a.attnum > 0 AND NOT a.attisdropped
             ORDER BY a.attnum`,
            table.database,
        );
        return rows.map((row) => ({
            name: text(row[0]),
            position: Number(row[1]),
            type: text(row[2]),
            nullable: row[3] === true,
            ...(row[4] !== null ? { default: text(row[4]) } : {}),
            primaryKey: row[5] === true,
            autoIncrement: row[6] === true,
            ...(row[7] ? { comment: text(row[7]) } : {}),
        }));
    }

    async listIndexes(table: ObjectRef): Promise<IndexInfo[]> {
        const rows = await this.query(
            `SELECT i.relname, ix.indisunique, ix.indisprimary, am.amname,
                    (SELECT array_agg(pg_get_indexdef(ix.indexrelid, k, true) ORDER BY k) FROM generate_series(1, ix.indnkeyatts::int) AS k)
             FROM pg_index ix JOIN pg_class i ON i.oid = ix.indexrelid JOIN pg_am am ON am.oid = i.relam
             WHERE ix.indrelid = ${this.regclass(table)}
             ORDER BY ix.indisprimary DESC, i.relname`,
            table.database,
        );
        return rows.map((row) => ({
            name: text(row[0]),
            columns: Array.isArray(row[4]) ? (row[4] as DbValue[]).map(text) : [],
            unique: row[1] === true,
            primary: row[2] === true,
            method: text(row[3]),
        }));
    }

    async listConstraints(table: ObjectRef): Promise<ConstraintInfo[]> {
        const columns = (side: 'conkey' | 'confkey', relation: 'conrelid' | 'confrelid') =>
            `(SELECT array_agg(a.attname ORDER BY u.ord) FROM unnest(c.${side}) WITH ORDINALITY AS u(attnum, ord) JOIN pg_attribute a ON a.attrelid = c.${relation} AND a.attnum = u.attnum)`;
        const rows = await this.query(
            `SELECT c.conname, c.contype::text, ${columns('conkey', 'conrelid')}, c.confrelid::regclass::text, ${columns('confkey', 'confrelid')}, pg_get_constraintdef(c.oid, true)
             FROM pg_constraint c WHERE c.conrelid = ${this.regclass(table)} ORDER BY c.contype, c.conname`,
            table.database,
        );
        const kinds: Record<string, string> = {
            p: 'PRIMARY KEY',
            f: 'FOREIGN KEY',
            u: 'UNIQUE',
            c: 'CHECK',
            x: 'EXCLUDE',
            t: 'TRIGGER',
        };
        return rows.map((row) => ({
            name: text(row[0]),
            kind: kinds[text(row[1])] ?? text(row[1]),
            columns: Array.isArray(row[2]) ? (row[2] as DbValue[]).map(text) : [],
            ...(text(row[1]) === 'f'
                ? {
                      references: {
                          table: text(row[3]),
                          columns: Array.isArray(row[4]) ? (row[4] as DbValue[]).map(text) : [],
                      },
                  }
                : {}),
            definition: text(row[5]),
        }));
    }

    async listRoutines(scope: { database?: string; schema?: string }): Promise<RoutineInfo[]> {
        const rows = await this.query(
            `SELECT p.proname, p.prokind::text, pg_get_function_result(p.oid)
             FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = ${this.quoteLiteral(scope.schema ?? 'public')} AND p.prokind IN ('f','p')
             ORDER BY p.proname`,
            scope.database,
        );
        return rows.map((row) => ({
            database: scope.database,
            schema: scope.schema ?? 'public',
            name: text(row[0]),
            kind: text(row[1]) === 'p' ? ('procedure' as const) : ('function' as const),
            ...(row[2] !== null ? { returns: text(row[2]) } : {}),
        }));
    }

    async listTriggers(scope: { database?: string; schema?: string }): Promise<TriggerInfo[]> {
        const rows = await this.query(
            `SELECT t.tgname, c.relname, t.tgtype::int
             FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE NOT t.tgisinternal AND n.nspname = ${this.quoteLiteral(scope.schema ?? 'public')}
             ORDER BY t.tgname`,
            scope.database,
        );
        return rows.map((row) => {
            const flags = Number(row[2]);
            const events = [
                flags & 4 ? 'INSERT' : null,
                flags & 8 ? 'DELETE' : null,
                flags & 16 ? 'UPDATE' : null,
                flags & 32 ? 'TRUNCATE' : null,
            ]
                .filter((name): name is string => name !== null)
                .join(' OR ');
            return {
                database: scope.database,
                schema: scope.schema ?? 'public',
                name: text(row[0]),
                table: text(row[1]),
                timing: flags & 64 ? 'INSTEAD OF' : flags & 2 ? 'BEFORE' : 'AFTER',
                event: events,
            };
        });
    }

    /** The statement that creates an object, rebuilt from the catalogs. */
    async getDefinition(object: ObjectRef & { kind: string }): Promise<string> {
        const schema = object.schema ?? 'public';
        const database = object.database;
        const qualified = `${this.quoteIdentifier(schema)}.${this.quoteIdentifier(object.name)}`;
        switch (object.kind) {
            case 'view':
            case 'materialized view': {
                const rows = await this.query(
                    `SELECT pg_get_viewdef(${this.regclass(object)}, true)`,
                    database,
                );
                const body = text(rows[0]?.[0]).trim();
                return object.kind === 'view'
                    ? `CREATE OR REPLACE VIEW ${qualified} AS\n${body}`
                    : `CREATE MATERIALIZED VIEW ${qualified} AS\n${body}`;
            }
            case 'routine':
            case 'function':
            case 'procedure': {
                const rows = await this.query(
                    `SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                     WHERE n.nspname = ${this.quoteLiteral(schema)} AND p.proname = ${this.quoteLiteral(object.name)} AND p.prokind IN ('f','p') LIMIT 1`,
                    database,
                );
                if (!rows[0])
                    throw new DbError('NOT_FOUND', `The routine “${object.name}” does not exist.`);
                return text(rows[0][0]);
            }
            case 'trigger': {
                const rows = await this.query(
                    `SELECT pg_get_triggerdef(t.oid, true) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
                     WHERE t.tgname = ${this.quoteLiteral(object.name)} AND NOT t.tgisinternal AND n.nspname = ${this.quoteLiteral(schema)} LIMIT 1`,
                    database,
                );
                if (!rows[0])
                    throw new DbError('NOT_FOUND', `The trigger “${object.name}” does not exist.`);
                return text(rows[0][0]);
            }
            default: {
                const columns = await this.listColumns(object);
                if (columns.length === 0)
                    throw new DbError('NOT_FOUND', `The table “${object.name}” does not exist.`);
                const constraints = await this.listConstraints(object);
                const lines = [
                    ...columns.map(
                        (column) =>
                            `    ${this.quoteIdentifier(column.name)} ${column.type}${column.nullable ? '' : ' NOT NULL'}${column.default !== undefined ? ` DEFAULT ${column.default}` : ''}`,
                    ),
                    ...constraints.map(
                        (constraint) =>
                            `    CONSTRAINT ${this.quoteIdentifier(constraint.name)} ${constraint.definition ?? constraint.kind}`,
                    ),
                ];
                const indexes = await this.query(
                    `SELECT pg_get_indexdef(ix.indexrelid, 0, true) FROM pg_index ix
                     WHERE ix.indrelid = ${this.regclass(object)} AND NOT ix.indisprimary
                       AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = ix.indexrelid)
                     ORDER BY 1`,
                    database,
                );
                return [
                    `CREATE TABLE ${qualified} (\n${lines.join(',\n')}\n);`,
                    ...indexes.map((row) => `${text(row[0])};`),
                ].join('\n\n');
            }
        }
    }

    async listSessions(): Promise<SessionInfo[]> {
        const rows = await this.query(
            `SELECT pid, usename, datname, state, EXTRACT(EPOCH FROM now() - query_start)::float8, query
             FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND backend_type = 'client backend' ORDER BY query_start NULLS LAST`,
        );
        return rows.map((row) => ({
            id: text(row[0]),
            ...(row[1] !== null ? { user: text(row[1]) } : {}),
            ...(row[2] !== null ? { database: text(row[2]) } : {}),
            ...(row[3] !== null ? { state: text(row[3]) } : {}),
            ...(row[4] !== null ? { seconds: Math.round(Number(row[4])) } : {}),
            ...(row[5] ? { statement: text(row[5]) } : {}),
        }));
    }

    async killSession(id: string): Promise<void> {
        if (!/^\d+$/.test(id)) throw new DbError('INVALID_REQUEST', 'A session id is a number.');
        const rows = await this.query(`SELECT pg_terminate_backend(${Number(id)})`);
        if (rows[0]?.[0] !== true)
            throw new DbError('NOT_FOUND', 'That session no longer exists, or you may not end it.');
    }

    async serverStatus(): Promise<Record<string, string>> {
        const settings = await this.query('SELECT name, setting FROM pg_settings ORDER BY name');
        const status = await this.query(
            `SELECT version(), pg_postmaster_start_time()::text, (SELECT count(*) FROM pg_stat_activity)::int8, pg_database_size(current_database())`,
        );
        const out: Record<string, string> = {};
        const [version, started, connections, size] = status[0] ?? [];
        out.version = text(version);
        out.started = text(started);
        out.connections = text(connections);
        out.database_size_bytes = text(size);
        for (const [name, setting] of settings) out[text(name)] = text(setting);
        return out;
    }
}
