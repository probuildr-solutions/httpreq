/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import {
    DbError,
    throwIfAborted,
    type ColumnInfo,
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
import { MysqlConnection, type MysqlConnectOptions } from '@httpreq/db-protocol-mysql';

const SYSTEM_DATABASES = new Set(['mysql', 'information_schema', 'performance_schema', 'sys']);

const text = (value: DbValue | undefined): string =>
    value === null || value === undefined ? '' : String(value);

/** Rows of one query, with columns by name. */
interface Table {
    columns: string[];
    rows: DbValue[][];
}

/**
 * A MySQL or MariaDB session.
 *
 * It uses two connections. The first runs the user's statements. The second is opened when it is
 * first needed and serves everything that must work while a statement is running: browsing the
 * schema, listing sessions, and cancelling (`KILL QUERY` has to come from another connection).
 */
export class MysqlSession implements RelationalSession {
    readonly info: ServerInfo;
    private auxiliary: Promise<MysqlConnection> | null = null;
    /** Metadata queries share one connection, which runs one statement at a time: they queue here. */
    private auxiliaryTurn: Promise<unknown> = Promise.resolve();
    private noBackslashEscapes = false;
    private closed = false;

    private constructor(
        private readonly main: MysqlConnection,
        private readonly options: MysqlConnectOptions,
        private readonly config: ConnectionConfig,
        info: ServerInfo,
    ) {
        this.info = info;
    }

    static async open(
        options: MysqlConnectOptions,
        config: ConnectionConfig,
        signal?: AbortSignal,
    ): Promise<MysqlSession> {
        const main = await MysqlConnection.connect(options, signal);
        try {
            const probe = await collectAll(
                main,
                'SELECT CURRENT_USER(), @@sql_mode, @@version_comment',
            );
            const [user, mode, comment] = probe.rows[0] ?? [];
            const version = main.serverVersion;
            const mariadb = /mariadb/i.test(version) || /mariadb/i.test(text(comment));
            const session = new MysqlSession(main, options, config, {
                product: mariadb ? 'MariaDB' : 'MySQL',
                version: version.replace(/-.*$/, ''),
                connectionId: String(main.connectionId),
                user: text(user),
                secure: main.secure,
            });
            session.noBackslashEscapes = text(mode).split(',').includes('NO_BACKSLASH_ESCAPES');
            // Rows come back as text in UTF-8, whatever the server's defaults are.
            await collectAll(main, 'SET NAMES utf8mb4');
            return session;
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
        if (this.auxiliary)
            await (await this.auxiliary.catch(() => null))?.close().catch(() => undefined);
    }

    /* ---------- Statements ---------- */

    execute(sql: string, options: ExecuteOptions = {}): Execution {
        throwIfAborted(options.signal);
        const query = this.main.query(sql, { pageRows: options.pageRows });
        const timeoutMs = options.timeoutMs ?? this.config.queryTimeoutMs;
        let timedOut = false;
        let cancelled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const kill = async () => {
            if (this.closed || this.main.closed) return;
            const killer = await this.second();
            for await (const _ of killer.query(`KILL QUERY ${this.main.connectionId}`)) void _;
        };
        const cancel = async () => {
            cancelled = true;
            await kill();
        };
        if (timeoutMs > 0) {
            timer = setTimeout(() => {
                timedOut = true;
                void kill().catch(() => undefined);
            }, timeoutMs);
        }
        const onAbort = () => void cancel().catch(() => undefined);
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
        const iterate = async function* (): AsyncGenerator<ResultEvent> {
            try {
                for await (const event of query) yield event;
            } catch (error) {
                // A statement that was stopped on purpose reports itself as an interruption; say why.
                if (
                    (timedOut || cancelled) &&
                    error instanceof DbError &&
                    error.code === 'CANCELLED'
                ) {
                    throw stopped();
                }
                throw error;
            } finally {
                cleanup();
            }
            // Some statements (SLEEP, for one) end quietly when killed rather than with an error.
            if (timedOut || cancelled) throw stopped();
        };
        return Object.assign(iterate(), { cancel });
    }

    async begin(): Promise<void> {
        await collectAll(this.main, 'START TRANSACTION');
    }

    async commit(): Promise<void> {
        await collectAll(this.main, 'COMMIT');
    }

    async rollback(): Promise<void> {
        await collectAll(this.main, 'ROLLBACK');
    }

    explain(sql: string): Promise<ExplainPlan> {
        return this.onSecond((connection) => this.explainOn(connection, sql));
    }

    private async explainOn(connection: MysqlConnection, sql: string): Promise<ExplainPlan> {
        let textPlan: string;
        try {
            const tree = await collectAll(connection, `EXPLAIN FORMAT=TREE ${sql}`);
            textPlan = tree.rows.map((row) => text(row[0])).join('\n');
        } catch {
            // Older servers and MariaDB have no tree format: fall back to the classic table.
            const classic = await collectAll(connection, `EXPLAIN ${sql}`);
            textPlan = [
                classic.columns.join('\t'),
                ...classic.rows.map((row) => row.map(text).join('\t')),
            ].join('\n');
        }
        let tree: DbValue | undefined;
        try {
            const json = await collectAll(connection, `EXPLAIN FORMAT=JSON ${sql}`);
            tree = JSON.parse(text(json.rows[0]?.[0])) as DbValue;
        } catch {
            // The structured form is optional.
        }
        return { text: textPlan, ...(tree !== undefined ? { tree } : {}) };
    }

    quoteIdentifier(name: string): string {
        return `\`${name.replace(/`/g, '``')}\``;
    }

    quoteLiteral(value: string): string {
        if (this.noBackslashEscapes) return `'${value.replace(/'/g, "''")}'`;
        // eslint-disable-next-line no-control-regex -- these are the control characters MySQL escapes
        return `'${value.replace(/[\0\n\r\\'"\x1a]/g, (c) => ESCAPES[c]!)}'`;
    }

    /* ---------- Schema browsing ---------- */

    async listPermissions(): Promise<string[]> {
        const grants = await this.meta('SHOW GRANTS');
        return grants.rows.map((row) => text(row[0]));
    }

    async getPermissions(): Promise<PermissionSet> {
        const grants = await this.listPermissions();
        const joined = grants.join('\n').toUpperCase();
        const has = (...words: string[]) =>
            /ALL PRIVILEGES/.test(joined) ||
            words.some((word) => new RegExp(`\\b${word}\\b`).test(joined));
        return {
            read: has('SELECT'),
            write: has('INSERT', 'UPDATE', 'DELETE'),
            schema: has('CREATE', 'ALTER', 'DROP'),
            grants,
        };
    }

    async listDatabases(): Promise<DatabaseInfo[]> {
        const result = await this.meta(
            'SELECT SCHEMA_NAME FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME',
        );
        return result.rows.map((row) => {
            const name = text(row[0]);
            return { name, system: SYSTEM_DATABASES.has(name.toLowerCase()) };
        });
    }

    async listSchemas(): Promise<SchemaInfo[]> {
        return []; // MySQL has databases only; there is no level between a database and its tables
    }

    async listTables(scope: { database?: string }): Promise<TableInfo[]> {
        const result = await this.meta(
            `SELECT TABLE_NAME, TABLE_TYPE, TABLE_ROWS, DATA_LENGTH + INDEX_LENGTH, TABLE_COMMENT
             FROM information_schema.TABLES WHERE TABLE_SCHEMA = ${this.scopeDatabase(scope)} ORDER BY TABLE_NAME`,
        );
        return result.rows.map((row) => ({
            database: scope.database,
            name: text(row[0]),
            kind: /view/i.test(text(row[1])) ? 'view' : 'table',
            ...(row[2] !== null ? { rows: Number(row[2]) } : {}),
            ...(row[3] !== null ? { bytes: Number(row[3]) } : {}),
            ...(text(row[4]) ? { comment: text(row[4]) } : {}),
        }));
    }

    async listColumns(table: ObjectRef): Promise<ColumnInfo[]> {
        const result = await this.meta(
            `SELECT COLUMN_NAME, ORDINAL_POSITION, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY, EXTRA, COLUMN_COMMENT
             FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = ${this.scopeDatabase(table)} AND TABLE_NAME = ${this.quoteLiteral(table.name)}
             ORDER BY ORDINAL_POSITION`,
        );
        return result.rows.map((row) => ({
            name: text(row[0]),
            position: Number(row[1]),
            type: text(row[2]),
            nullable: text(row[3]) === 'YES',
            ...(row[4] !== null ? { default: text(row[4]) } : {}),
            primaryKey: text(row[5]) === 'PRI',
            autoIncrement: /auto_increment/i.test(text(row[6])),
            ...(text(row[7]) ? { comment: text(row[7]) } : {}),
        }));
    }

    async listIndexes(table: ObjectRef): Promise<IndexInfo[]> {
        const result = await this.meta(
            `SELECT INDEX_NAME, NON_UNIQUE, INDEX_TYPE, COLUMN_NAME
             FROM information_schema.STATISTICS
             WHERE TABLE_SCHEMA = ${this.scopeDatabase(table)} AND TABLE_NAME = ${this.quoteLiteral(table.name)}
             ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
        );
        const byName = new Map<string, IndexInfo>();
        for (const row of result.rows) {
            const name = text(row[0]);
            const index = byName.get(name) ?? {
                name,
                columns: [],
                unique: Number(row[1]) === 0,
                primary: name === 'PRIMARY',
                method: text(row[2]),
            };
            index.columns.push(text(row[3]));
            byName.set(name, index);
        }
        return [...byName.values()];
    }

    async listConstraints(table: ObjectRef): Promise<ConstraintInfo[]> {
        const schema = this.scopeDatabase(table);
        const name = this.quoteLiteral(table.name);
        const result = await this.meta(
            `SELECT c.CONSTRAINT_NAME, c.CONSTRAINT_TYPE, k.COLUMN_NAME, k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME
             FROM information_schema.TABLE_CONSTRAINTS c
             LEFT JOIN information_schema.KEY_COLUMN_USAGE k
               ON k.CONSTRAINT_SCHEMA = c.CONSTRAINT_SCHEMA AND k.TABLE_NAME = c.TABLE_NAME AND k.CONSTRAINT_NAME = c.CONSTRAINT_NAME
             WHERE c.TABLE_SCHEMA = ${schema} AND c.TABLE_NAME = ${name}
             ORDER BY c.CONSTRAINT_NAME, k.ORDINAL_POSITION`,
        );
        const byName = new Map<string, ConstraintInfo>();
        for (const row of result.rows) {
            const key = text(row[0]);
            const constraint = byName.get(key) ?? { name: key, kind: text(row[1]), columns: [] };
            if (row[2] !== null) constraint.columns.push(text(row[2]));
            if (row[3] !== null) {
                constraint.references ??= { table: text(row[3]), columns: [] };
                constraint.references.columns.push(text(row[4]));
            }
            byName.set(key, constraint);
        }
        return [...byName.values()];
    }

    async listRoutines(scope: { database?: string }): Promise<RoutineInfo[]> {
        const result = await this.meta(
            `SELECT ROUTINE_NAME, ROUTINE_TYPE, DTD_IDENTIFIER FROM information_schema.ROUTINES
             WHERE ROUTINE_SCHEMA = ${this.scopeDatabase(scope)} ORDER BY ROUTINE_NAME`,
        );
        return result.rows.map((row) => ({
            database: scope.database,
            name: text(row[0]),
            kind: text(row[1]).toLowerCase() === 'procedure' ? 'procedure' : 'function',
            ...(row[2] !== null ? { returns: text(row[2]) } : {}),
        }));
    }

    async listTriggers(scope: { database?: string }): Promise<TriggerInfo[]> {
        const result = await this.meta(
            `SELECT TRIGGER_NAME, EVENT_OBJECT_TABLE, ACTION_TIMING, EVENT_MANIPULATION FROM information_schema.TRIGGERS
             WHERE TRIGGER_SCHEMA = ${this.scopeDatabase(scope)} ORDER BY TRIGGER_NAME`,
        );
        return result.rows.map((row) => ({
            database: scope.database,
            name: text(row[0]),
            table: text(row[1]),
            timing: text(row[2]),
            event: text(row[3]),
        }));
    }

    /** Scheduled events of a database (MySQL's event scheduler). */
    async listEvents(scope: {
        database?: string;
    }): Promise<{ name: string; status: string; schedule: string }[]> {
        const result = await this.meta(
            `SELECT EVENT_NAME, STATUS, EVENT_TYPE, INTERVAL_VALUE, INTERVAL_FIELD, EXECUTE_AT FROM information_schema.EVENTS
             WHERE EVENT_SCHEMA = ${this.scopeDatabase(scope)} ORDER BY EVENT_NAME`,
        );
        return result.rows.map((row) => ({
            name: text(row[0]),
            status: text(row[1]),
            schedule:
                text(row[2]) === 'RECURRING'
                    ? `every ${text(row[3])} ${text(row[4])}`
                    : `at ${text(row[5])}`,
        }));
    }

    async getDefinition(object: ObjectRef & { kind: string }): Promise<string> {
        const target = `${object.database ? `${this.quoteIdentifier(object.database)}.` : ''}${this.quoteIdentifier(object.name)}`;
        const kind = object.kind.toLowerCase();
        const statement = {
            table: 'TABLE',
            view: 'TABLE',
            procedure: 'PROCEDURE',
            function: 'FUNCTION',
            trigger: 'TRIGGER',
            event: 'EVENT',
        }[kind];
        if (!statement)
            throw new DbError('INVALID_REQUEST', `There is no definition for a ${object.kind}.`);
        const result = await this.meta(`SHOW CREATE ${statement} ${target}`);
        const row = result.rows[0];
        // The statement is in the column named "Create ..." ("SQL Original Statement" for triggers).
        const index = result.columns.findIndex((column) =>
            /^(create |sql original statement)/i.test(column),
        );
        return text(row?.[index >= 0 ? index : 1]);
    }

    async listSessions(): Promise<SessionInfo[]> {
        const result = await this.meta('SHOW FULL PROCESSLIST');
        const column = (name: string) => result.columns.findIndex((c) => c.toLowerCase() === name);
        return result.rows.map((row) => ({
            id: text(row[column('id')]),
            user: text(row[column('user')]),
            database: row[column('db')] === null ? undefined : text(row[column('db')]),
            state: text(row[column('command')]),
            seconds: Number(row[column('time')] ?? 0),
            statement: row[column('info')] === null ? undefined : text(row[column('info')]),
        }));
    }

    async killSession(id: string): Promise<void> {
        if (!/^\d+$/.test(id)) throw new DbError('INVALID_REQUEST', 'A session id is a number.');
        await this.meta(`KILL ${id}`);
    }

    async serverStatus(): Promise<Record<string, string>> {
        const result = await this.meta('SHOW GLOBAL STATUS');
        return Object.fromEntries(result.rows.map((row) => [text(row[0]), text(row[1])]));
    }

    /* ---------- Internals ---------- */

    /** Runs a metadata query on the second connection. */
    private meta(sql: string): Promise<Table> {
        return this.onSecond((connection) => collectAll(connection, sql));
    }

    /** Runs work on the second connection, after whatever is already using it. */
    private onSecond<T>(work: (connection: MysqlConnection) => Promise<T>): Promise<T> {
        const run = async () => work(await this.second());
        const result = this.auxiliaryTurn.then(run, run);
        this.auxiliaryTurn = result.catch(() => undefined);
        return result;
    }

    private scopeDatabase(scope: { database?: string }): string {
        // `DATABASE()` is the database of the connection that runs the query, which is the second one.
        return scope.database ? this.quoteLiteral(scope.database) : 'DATABASE()';
    }

    private second(): Promise<MysqlConnection> {
        if (this.closed)
            return Promise.reject(new DbError('CONNECTION_FAILED', 'The session is closed.'));
        this.auxiliary ??= MysqlConnection.connect(this.options).then(async (connection) => {
            await collectAll(connection, 'SET NAMES utf8mb4');
            return connection;
        });
        return this.auxiliary.catch((error: unknown) => {
            this.auxiliary = null;
            throw error;
        });
    }
}

const ESCAPES: Record<string, string> = {
    '\0': '\\0',
    '\n': '\\n',
    '\r': '\\r',
    '\\': '\\\\',
    "'": "\\'",
    '"': '\\"',
    '\x1a': '\\Z',
};

/** Runs one statement to completion and returns its (first) result set. For small results only. */
const collectAll = async (connection: MysqlConnection, sql: string): Promise<Table> => {
    const table: Table = { columns: [], rows: [] };
    let seen = false;
    for await (const event of connection.query(sql)) {
        if (event.kind === 'columns' && !seen) {
            table.columns = event.columns.map((column) => column.name);
        } else if (event.kind === 'rows' && !seen) {
            table.rows.push(...event.rows);
        } else if (event.kind === 'end') {
            seen = true;
        }
    }
    return table;
};
