/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { randomBytes } from 'node:crypto';
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
import {
    MongoConnection,
    serverError,
    type BsonDocument,
    type MongoConnectOptions,
} from '@httpreq/db-protocol-mongo';
import { DocumentTable, toShell, toShellLine, typeName } from './format';
import { parseStatement, type Plan } from './shell';

type CommandPlan = Extract<Plan, { kind: 'command' }>;

const SYSTEM_DATABASES = new Set(['admin', 'config', 'local']);
const DEFAULT_PAGE_ROWS = 500;
const SAMPLE_SIZE = 200;
const MAX_SCHEMA_FIELDS = 100;
/** Counts are fetched for this many collections at most; more would make browsing slow. */
const MAX_COUNTED_COLLECTIONS = 100;

/** Commands that carry a `comment`, which is how a running one is found and stopped. */
const TAGGABLE = [
    'find',
    'aggregate',
    'count',
    'distinct',
    'insert',
    'update',
    'delete',
    'findAndModify',
];

const isDocument = (value: unknown): value is BsonDocument =>
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !(value instanceof Date) &&
    !(value instanceof Uint8Array);

const asNumber = (value: DbValue | undefined): number =>
    typeof value === 'bigint' ? Number(value) : Number(value ?? 0);

const uuid = (): { $type: string; $value: string } => {
    const bytes = randomBytes(16);
    bytes[6] = (bytes[6]! & 0x0f) | 0x40;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const h = bytes.toString('hex');
    return {
        $type: 'uuid',
        $value: `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`,
    };
};

/** The first failure in a write reply, as an error. */
const writeFailure = (reply: BsonDocument): DbError | null => {
    const errors = reply.writeErrors;
    if (Array.isArray(errors) && errors.length > 0 && isDocument(errors[0])) {
        const first = errors[0];
        const code = asNumber(first.code);
        const message = String(first.errmsg ?? 'The write failed.');
        return new DbError(
            code === 11000 ? 'CONFLICT' : 'QUERY_FAILED',
            code === 11000
                ? `A document with that unique value already exists. ${message}`
                : message,
            {
                server: { number: code },
            },
        );
    }
    return null;
};

/**
 * A MongoDB session. Statements are written the way the MongoDB shell takes them
 * (`db.orders.find({ total: { $gt: 100 } }).sort({ _id: -1 }).limit(20)`), one per line or ending
 * in a semicolon; `use shop` changes the database; `show dbs` and `show collections` list them.
 * Results come back as tables, one row per document, so the same grid shows them.
 *
 * Two connections are used. The first runs the user's statements; the second serves browsing,
 * `killOp` (which is how a running statement is stopped without dropping the connection) and the
 * administration views.
 */
export class MongoSession implements RelationalSession {
    readonly info: ServerInfo;
    private auxiliary: Promise<MongoConnection> | null = null;
    private auxiliaryTurn: Promise<unknown> = Promise.resolve();
    private closed = false;
    private database: string;
    private transaction: {
        lsid: { $type: string; $value: string };
        number: number;
        started: boolean;
    } | null = null;
    private transactionCounter = 0;

    private constructor(
        private readonly main: MongoConnection,
        private readonly options: MongoConnectOptions,
        private readonly config: ConnectionConfig,
        info: ServerInfo,
    ) {
        this.info = info;
        this.database = config.database || 'test';
    }

    static async open(
        options: MongoConnectOptions,
        config: ConnectionConfig,
        signal?: AbortSignal,
    ): Promise<MongoSession> {
        const main = await MongoConnection.connect(options, signal);
        const hello = main.hello;
        const product = hello.process === 'mongos' ? 'MongoDB (router)' : 'MongoDB';
        return new MongoSession(main, options, config, {
            product,
            version: hello.version,
            connectionId: undefined,
            user: main.authenticatedUser,
            secure: main.secure,
        });
    }

    get alive(): boolean {
        return !this.closed && !this.main.closed;
    }

    /** The database the next statement runs on. */
    get currentDatabase(): string {
        return this.database;
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

    execute(statement: string, options: ExecuteOptions = {}): Execution {
        throwIfAborted(options.signal);
        const plan = parseStatement(statement, this.database);
        const pageRows = options.pageRows ?? DEFAULT_PAGE_ROWS;
        const timeoutMs = options.timeoutMs ?? this.config.queryTimeoutMs;
        const comment = `httpreq-${randomBytes(8).toString('hex')}`;
        let stopped: 'cancelled' | 'timeout' | null = null;
        let tagged = false;
        let timer: ReturnType<typeof setTimeout> | undefined;

        const stop = (why: 'cancelled' | 'timeout') => {
            stopped ??= why;
            if (tagged) {
                // Ask the server to interrupt the operation; the connection stays usable.
                void this.killByComment(comment).catch(() => this.main.destroy());
            } else {
                this.main.destroy();
            }
        };
        if (timeoutMs > 0) timer = setTimeout(() => stop('timeout'), timeoutMs);
        const onAbort = () => stop('cancelled');
        options.signal?.addEventListener('abort', onAbort, { once: true });
        const cleanup = () => {
            clearTimeout(timer);
            options.signal?.removeEventListener('abort', onAbort);
        };
        const reason = () =>
            stopped === 'timeout'
                ? new DbError(
                      'TIMEOUT',
                      'The statement ran longer than the time limit and was stopped.',
                  )
                : new DbError('CANCELLED', 'The statement was cancelled.');

        // eslint-disable-next-line @typescript-eslint/no-this-alias -- used inside the generator
        const session = this;
        const iterate = async function* (): AsyncGenerator<ResultEvent> {
            let openCursor: { id: DbValue; database: string; collection: string } | null = null;
            try {
                if (plan.kind === 'use') {
                    session.database = plan.database;
                    yield { kind: 'columns', columns: [{ name: 'database', type: 'string' }] };
                    yield { kind: 'rows', rows: [[plan.database]] };
                    yield { kind: 'end', rowCount: 1, info: `Switched to ${plan.database}.` };
                    return;
                }
                const taggable =
                    TAGGABLE.includes(Object.keys(plan.command)[0]!) &&
                    session.main.hello.maxWireVersion >= 9;
                tagged = taggable;
                const send = (database: string, body: BsonDocument, continuing = false) => {
                    if (stopped) throw reason();
                    const full = session.withContext(body, taggable ? comment : null, continuing);
                    return session.main.send(database, full);
                };
                const fail = (reply: BsonDocument) => {
                    if (stopped) throw reason();
                    throw serverError(reply);
                };

                const prepared: BsonDocument = { ...plan.command };
                if ('find' in prepared && prepared.batchSize === undefined)
                    prepared.batchSize = pageRows;
                if (
                    'aggregate' in prepared &&
                    isDocument(prepared.cursor) &&
                    prepared.cursor.batchSize === undefined &&
                    plan.shape === 'cursor'
                ) {
                    prepared.cursor = { ...prepared.cursor, batchSize: pageRows };
                }
                const reply = await send(plan.database, prepared);
                if (reply.ok !== 1) fail(reply);
                const writeError = writeFailure(reply);
                if (writeError) throw writeError;

                const cursor = isDocument(reply.cursor) ? reply.cursor : null;
                if (cursor && (plan.shape === 'cursor' || plan.shape === 'document')) {
                    const ns = String(cursor.ns ?? '');
                    const dot = ns.indexOf('.');
                    const collection = dot >= 0 ? ns.slice(dot + 1) : ns;
                    const table = new DocumentTable();
                    let first = true;
                    let count = 0;
                    let batch = (cursor.firstBatch as BsonDocument[]) ?? [];
                    let id: DbValue = cursor.id ?? 0;
                    const wantsRows = plan.shape === 'cursor';
                    if (!wantsRows) {
                        // A command that happens to return a cursor: show it as a table too.
                    }
                    if (BigInt(id as number | bigint) !== 0n) {
                        openCursor = {
                            id,
                            database: dot >= 0 ? ns.slice(0, dot) : plan.database,
                            collection,
                        };
                    }
                    for (;;) {
                        if (first) {
                            yield { kind: 'columns', columns: table.begin(batch) };
                            first = false;
                        }
                        for (let i = 0; i < batch.length; i += pageRows) {
                            const part = batch.slice(i, i + pageRows);
                            count += part.length;
                            yield { kind: 'rows', rows: table.rows(part) };
                        }
                        if (BigInt(id as number | bigint) === 0n) break;
                        const more = await send(
                            openCursor!.database,
                            {
                                getMore: id as number,
                                collection: openCursor!.collection,
                                batchSize: pageRows,
                            },
                            true,
                        );
                        if (more.ok !== 1) fail(more);
                        const next = isDocument(more.cursor) ? more.cursor : {};
                        batch = (next.nextBatch as BsonDocument[]) ?? [];
                        id = next.id ?? 0;
                        if (BigInt(id as number | bigint) === 0n) openCursor = null;
                    }
                    openCursor = null;
                    yield {
                        kind: 'end',
                        rowCount: count,
                        ...(table.hidden > 0
                            ? {
                                  info: `${table.hidden} document${table.hidden === 1 ? ' has' : 's have'} fields that are not shown as columns.`,
                              }
                            : {}),
                    };
                    return;
                }
                yield* shapeReply(plan, reply, pageRows);
            } catch (error) {
                if (stopped) throw reason();
                throw error;
            } finally {
                cleanup();
                if (openCursor) {
                    // The consumer stopped early: release the server's cursor.
                    const { id, database, collection } = openCursor;
                    void session
                        .onSecond((connection) =>
                            connection.send(database, {
                                killCursors: collection,
                                cursors: [id as number],
                            }),
                        )
                        .catch(() => undefined);
                }
            }
            if (stopped) throw reason();
        };
        return Object.assign(iterate(), {
            cancel: async () => {
                stop('cancelled');
            },
        });
    }

    /** Adds the fields a command needs when it runs in a transaction, and the cancellation tag. */
    private withContext(
        body: BsonDocument,
        comment: string | null,
        continuing: boolean,
    ): BsonDocument {
        const out: BsonDocument = { ...body };
        if (comment) out.comment = comment;
        if (this.transaction) {
            out.lsid = { id: this.transaction.lsid };
            out.txnNumber = { $type: 'int64', $value: String(this.transaction.number) };
            out.autocommit = false;
            if (!this.transaction.started && !continuing) {
                out.startTransaction = true;
                this.transaction.started = true;
            }
        }
        return out;
    }

    private async killByComment(comment: string): Promise<void> {
        await this.onSecond(async (connection) => {
            const found = await connection.command('admin', {
                aggregate: 1,
                pipeline: [
                    { $currentOp: { allUsers: true, localOps: true } },
                    { $match: { 'command.comment': comment } },
                ],
                cursor: {},
            });
            const operations = ((found.cursor as BsonDocument).firstBatch as BsonDocument[]) ?? [];
            for (const operation of operations) {
                await connection.send('admin', { killOp: 1, op: operation.opid as number });
            }
        });
    }

    async begin(): Promise<void> {
        if (this.transaction) throw new DbError('CONFLICT', 'A transaction is already open.');
        this.transaction = { lsid: uuid(), number: ++this.transactionCounter, started: false };
    }

    async commit(): Promise<void> {
        await this.endTransaction('commitTransaction');
    }

    async rollback(): Promise<void> {
        try {
            await this.endTransaction('abortTransaction');
        } catch (error) {
            // A transaction the server never started, or already ended (it aborts one that failed),
            // is as rolled back as it can be.
            const number = error instanceof DbError ? error.server?.number : undefined;
            if (number !== 251 && number !== 20) throw error;
        }
    }

    private async endTransaction(command: 'commitTransaction' | 'abortTransaction'): Promise<void> {
        const transaction = this.transaction;
        if (!transaction) throw new DbError('INVALID_REQUEST', 'There is no open transaction.');
        this.transaction = null;
        // Nothing ran inside it, so the server knows nothing of it.
        if (!transaction.started) return;
        await this.main.command('admin', {
            [command]: 1,
            lsid: { id: transaction.lsid },
            txnNumber: { $type: 'int64', $value: String(transaction.number) },
            autocommit: false,
        });
    }

    async explain(statement: string): Promise<ExplainPlan> {
        const plan = parseStatement(statement, this.database);
        if (plan.kind !== 'command' || !plan.explainable) {
            throw new DbError(
                'UNSUPPORTED',
                'Only find, aggregate, count, distinct, update and delete statements can be explained.',
            );
        }
        const reply = await this.onSecond((connection) =>
            connection.command(plan.database, {
                explain: plan.command,
                verbosity: 'executionStats',
            }),
        );
        const { ok: _ok, ...tree } = reply;
        void _ok;
        return { text: toShell(tree as DbValue), tree: tree as DbValue };
    }

    quoteIdentifier(name: string): string {
        return JSON.stringify(name);
    }

    quoteLiteral(value: string): string {
        return JSON.stringify(value);
    }

    /* ---------- Browsing ---------- */

    async getPermissions(): Promise<PermissionSet> {
        const reply = await this.onSecond((connection) =>
            connection.command('admin', { connectionStatus: 1, showPrivileges: true }),
        );
        const info = isDocument(reply.authInfo) ? reply.authInfo : {};
        const users = Array.isArray(info.authenticatedUsers) ? info.authenticatedUsers : [];
        // Without a login the server either has no access control (everything works) or refuses
        // everything; connecting got this far, so assume the former.
        if (users.length === 0) return { read: true, write: true, schema: true };
        const actions = new Set<string>();
        for (const privilege of (info.authenticatedUserPrivileges as BsonDocument[]) ?? []) {
            for (const action of (privilege.actions as string[]) ?? []) actions.add(action);
        }
        const roles = ((info.authenticatedUserRoles as BsonDocument[]) ?? []).map(
            (r) => `${String(r.role)}@${String(r.db)}`,
        );
        const has = (...names: string[]) => names.some((name) => actions.has(name));
        return {
            read: has('find'),
            write: has('insert', 'update', 'remove'),
            schema: has('createCollection', 'dropCollection', 'createIndex', 'dropIndex'),
            grants: roles,
        };
    }

    async listDatabases(): Promise<DatabaseInfo[]> {
        const reply = await this.onSecond((connection) =>
            connection.command('admin', { listDatabases: 1, nameOnly: true }),
        );
        return ((reply.databases as BsonDocument[]) ?? [])
            .map((entry) => ({
                name: String(entry.name),
                system: SYSTEM_DATABASES.has(String(entry.name)),
            }))
            .sort((a, b) => a.name.localeCompare(b.name));
    }

    async listSchemas(): Promise<SchemaInfo[]> {
        return [];
    }

    /** Collections and views of a database, with their document counts when there are not too many. */
    async listTables(scope: { database?: string }): Promise<TableInfo[]> {
        const database = scope.database ?? this.database;
        return this.onSecond(async (connection) => {
            const reply = await connection.command(database, { listCollections: 1, filter: {} });
            const entries = ((reply.cursor as BsonDocument).firstBatch as BsonDocument[]) ?? [];
            let next = (reply.cursor as BsonDocument).id as number | bigint;
            // A database with thousands of collections needs more than one batch.
            const all = [...entries];
            while (BigInt(next) !== 0n) {
                const more = await connection.command(database, {
                    getMore: next as number,
                    collection: '$cmd.listCollections',
                    batchSize: 1000,
                });
                const cursor = more.cursor as BsonDocument;
                all.push(...((cursor.nextBatch as BsonDocument[]) ?? []));
                next = cursor.id as number | bigint;
            }
            const tables: TableInfo[] = all.map((entry) => ({
                database,
                name: String(entry.name),
                kind: entry.type === 'view' ? 'view' : 'table',
            }));
            tables.sort((a, b) => a.name.localeCompare(b.name));
            if (tables.length <= MAX_COUNTED_COLLECTIONS) {
                for (const table of tables) {
                    if (table.kind !== 'table') continue;
                    try {
                        const stats = await connection.command(database, {
                            aggregate: table.name,
                            pipeline: [{ $collStats: { count: {}, storageStats: {} } }],
                            cursor: {},
                        });
                        const first = (
                            (stats.cursor as BsonDocument).firstBatch as BsonDocument[]
                        )[0];
                        if (first) {
                            table.rows = asNumber(first.count);
                            const storage = first.storageStats;
                            if (isDocument(storage)) table.bytes = asNumber(storage.size);
                        }
                    } catch {
                        // A user without the privilege still gets the list.
                    }
                }
            }
            return tables;
        });
    }

    /** The fields of a collection, inferred from a random sample of its documents. */
    async listColumns(table: ObjectRef): Promise<ColumnInfo[]> {
        const database = table.database ?? this.database;
        const reply = await this.onSecond((connection) =>
            connection.command(database, {
                aggregate: table.name,
                pipeline: [{ $sample: { size: SAMPLE_SIZE } }],
                cursor: {},
            }),
        );
        const sample = ((reply.cursor as BsonDocument).firstBatch as BsonDocument[]) ?? [];
        const stats = new Map<string, { count: number; types: Map<string, number> }>();
        const visit = (prefix: string, document: BsonDocument, depth: number) => {
            for (const [key, value] of Object.entries(document)) {
                const path = prefix ? `${prefix}.${key}` : key;
                if (!stats.has(path) && stats.size >= MAX_SCHEMA_FIELDS * 4) continue;
                const entry = stats.get(path) ?? { count: 0, types: new Map() };
                entry.count++;
                const type = typeName(value);
                entry.types.set(type, (entry.types.get(type) ?? 0) + 1);
                stats.set(path, entry);
                if (depth < 1 && isDocument(value) && typeName(value) === 'object')
                    visit(path, value, depth + 1);
            }
        };
        for (const document of sample) visit('', document, 0);
        const fields = [...stats.entries()].slice(0, MAX_SCHEMA_FIELDS);
        // `_id` first, then in order of first appearance.
        fields.sort(([a], [b]) => (a === '_id' ? -1 : b === '_id' ? 1 : 0));
        return fields.map(([name, entry], index) => {
            const ordered = [...entry.types.entries()].sort((a, b) => b[1] - a[1]);
            const percent = Math.round((entry.count / sample.length) * 100);
            return {
                name,
                position: index + 1,
                type: ordered
                    .slice(0, 3)
                    .map(([type]) => type)
                    .join(' | '),
                nullable: entry.count < sample.length || entry.types.has('null'),
                primaryKey: name === '_id',
                comment: `in ${percent}% of ${sample.length} sampled documents`,
            };
        });
    }

    async listIndexes(table: ObjectRef): Promise<IndexInfo[]> {
        const database = table.database ?? this.database;
        const reply = await this.onSecond((connection) =>
            connection.command(database, { listIndexes: table.name }),
        );
        return (((reply.cursor as BsonDocument).firstBatch as BsonDocument[]) ?? []).map(
            (index) => {
                const key = isDocument(index.key) ? index.key : {};
                const special = Object.values(key).find(
                    (direction) => typeof direction === 'string',
                ) as string | undefined;
                return {
                    name: String(index.name),
                    columns: Object.keys(key).filter(
                        (field) => field !== '_fts' && field !== '_ftsx',
                    ),
                    unique: index.unique === true || index.name === '_id_',
                    primary: index.name === '_id_',
                    method: special ?? 'btree',
                };
            },
        );
    }

    async listConstraints(): Promise<ConstraintInfo[]> {
        return [];
    }

    async listRoutines(): Promise<RoutineInfo[]> {
        return [];
    }

    async listTriggers(): Promise<TriggerInfo[]> {
        return [];
    }

    /** Statements that would recreate a collection or view, with its indexes. */
    async getDefinition(object: ObjectRef & { kind: string }): Promise<string> {
        const database = object.database ?? this.database;
        return this.onSecond(async (connection) => {
            const listed = await connection.command(database, {
                listCollections: 1,
                filter: { name: object.name },
            });
            const info = ((listed.cursor as BsonDocument).firstBatch as BsonDocument[])[0];
            if (!info)
                throw new DbError(
                    'NOT_FOUND',
                    `The collection “${object.name}” does not exist in ${database}.`,
                );
            const options = isDocument(info.options) ? info.options : {};
            const lines: string[] = [`use ${database}`];
            if (info.type === 'view') {
                lines.push(
                    `db.createView(${JSON.stringify(object.name)}, ${JSON.stringify(String(options.viewOn))}, ${toShell(options.pipeline as DbValue)})`,
                );
                return lines.join('\n');
            }
            lines.push(
                Object.keys(options).length > 0
                    ? `db.createCollection(${JSON.stringify(object.name)}, ${toShell(options)})`
                    : `db.createCollection(${JSON.stringify(object.name)})`,
            );
            const indexes = await connection.command(database, { listIndexes: object.name });
            for (const index of ((indexes.cursor as BsonDocument).firstBatch as BsonDocument[]) ??
                []) {
                if (index.name === '_id_') continue;
                const { v: _v, key, ns: _ns, ...rest } = index;
                void _v;
                void _ns;
                lines.push(
                    Object.keys(rest).length > 0
                        ? `db.getCollection(${JSON.stringify(object.name)}).createIndex(${toShell(key as DbValue)}, ${toShell(rest as DbValue)})`
                        : `db.getCollection(${JSON.stringify(object.name)}).createIndex(${toShell(key as DbValue)})`,
                );
            }
            return lines.join('\n');
        });
    }

    async listSessions(): Promise<SessionInfo[]> {
        const reply = await this.onSecond((connection) =>
            connection.command('admin', {
                aggregate: 1,
                pipeline: [{ $currentOp: { allUsers: true, localOps: true } }],
                cursor: {},
            }),
        );
        return (((reply.cursor as BsonDocument).firstBatch as BsonDocument[]) ?? []).map((op) => ({
            id: String(op.opid),
            user:
                Array.isArray(op.effectiveUsers) && isDocument(op.effectiveUsers[0])
                    ? String(op.effectiveUsers[0].user)
                    : undefined,
            database: typeof op.ns === 'string' ? op.ns.split('.')[0] : undefined,
            state: op.active === true ? 'active' : 'idle',
            seconds: asNumber(op.secs_running),
            statement: isDocument(op.command)
                ? toShellLine(op.command as DbValue).slice(0, 500)
                : String(op.desc ?? ''),
        }));
    }

    async killSession(id: string): Promise<void> {
        await this.onSecond((connection) =>
            connection.command('admin', { killOp: 1, op: Number(id) }),
        );
    }

    async serverStatus(): Promise<Record<string, string>> {
        const reply = await this.onSecond((connection) =>
            connection.command('admin', { serverStatus: 1 }),
        );
        const out: Record<string, string> = {};
        const flatten = (prefix: string, value: DbValue, depth: number) => {
            if (Object.keys(out).length >= 600) return;
            if (isDocument(value) && depth < 3 && typeName(value) === 'object') {
                for (const [key, item] of Object.entries(value))
                    flatten(prefix ? `${prefix}.${key}` : key, item, depth + 1);
            } else if (!Array.isArray(value)) {
                out[prefix] = toShellLine(value);
            }
        };
        flatten('', reply, 0);
        delete out.ok;
        return out;
    }

    /* ---------- Plumbing ---------- */

    private onSecond<T>(work: (connection: MongoConnection) => Promise<T>): Promise<T> {
        const run = async () => work(await this.second());
        const result = this.auxiliaryTurn.then(run, run);
        this.auxiliaryTurn = result.catch(() => undefined);
        return result;
    }

    private second(): Promise<MongoConnection> {
        if (this.closed)
            return Promise.reject(new DbError('CONNECTION_FAILED', 'The session is closed.'));
        this.auxiliary ??= MongoConnection.connect(this.options);
        return this.auxiliary.then(
            (connection) => {
                if (connection.closed) {
                    this.auxiliary = null;
                    return this.second();
                }
                return connection;
            },
            (error: unknown) => {
                this.auxiliary = null;
                throw error;
            },
        );
    }
}

/* ---------- Reply shaping ---------- */

async function* shapeReply(
    plan: CommandPlan,
    reply: BsonDocument,
    pageRows: number,
): AsyncGenerator<ResultEvent> {
    switch (plan.shape) {
        case 'count': {
            const batch = isDocument(reply.cursor)
                ? (reply.cursor.firstBatch as BsonDocument[])
                : null;
            const n = batch ? asNumber(batch[0]?.n) : asNumber(reply.n);
            yield { kind: 'columns', columns: [{ name: 'count', type: 'int' }] };
            yield { kind: 'rows', rows: [[n]] };
            yield { kind: 'end', rowCount: 1 };
            return;
        }
        case 'values': {
            const list =
                plan.valuesField === 'name' && isDocument(reply.cursor)
                    ? ((reply.cursor.firstBatch as BsonDocument[]) ?? [])
                          .map((entry) => entry.name as DbValue)
                          .sort()
                    : ((reply[plan.valuesField ?? 'values'] as DbValue[]) ?? []);
            yield {
                kind: 'columns',
                columns: [{ name: 'value', type: list.length > 0 ? typeName(list[0]) : 'null' }],
            };
            for (let i = 0; i < list.length; i += pageRows) {
                yield { kind: 'rows', rows: list.slice(i, i + pageRows).map((value) => [value]) };
            }
            yield { kind: 'end', rowCount: list.length };
            return;
        }
        case 'write':
            yield* shapeWrite(plan, reply);
            return;
        default:
            break;
    }

    // `show dbs` and a few others answer with a list of documents in one field.
    const field =
        plan.valuesField && Array.isArray(reply[plan.valuesField])
            ? (reply[plan.valuesField] as BsonDocument[])
            : null;
    if (field) {
        const table = new DocumentTable();
        yield { kind: 'columns', columns: table.begin(field.filter(isDocument)) };
        yield { kind: 'rows', rows: table.rows(field.filter(isDocument)) };
        yield { kind: 'end', rowCount: field.length };
        return;
    }

    if (plan.write === 'modify') {
        const found = reply.value;
        if (isDocument(found)) {
            const table = new DocumentTable();
            yield { kind: 'columns', columns: table.begin([found]) };
            yield { kind: 'rows', rows: table.rows([found]) };
            yield { kind: 'end', rowCount: 1 };
        } else {
            yield { kind: 'columns', columns: [{ name: 'result', type: 'string' }] };
            yield { kind: 'rows', rows: [['No document matched.']] };
            yield { kind: 'end', rowCount: 0 };
        }
        return;
    }

    // One reply document: a field/value table.
    const { ok: _ok, $clusterTime: _ct, operationTime: _ot, ...body } = reply;
    void _ok;
    void _ct;
    void _ot;
    const entries = Object.entries(body);
    yield {
        kind: 'columns',
        columns: [
            { name: 'field', type: 'string' },
            { name: 'value', type: 'mixed' },
        ],
    };
    for (let i = 0; i < entries.length; i += pageRows) {
        yield {
            kind: 'rows',
            rows: entries.slice(i, i + pageRows).map(([key, value]) => [key, value]),
        };
    }
    yield {
        kind: 'end',
        rowCount: entries.length,
        ...(entries.length === 0 ? { info: 'The command succeeded.' } : {}),
    };
}

async function* shapeWrite(plan: CommandPlan, reply: BsonDocument): AsyncGenerator<ResultEvent> {
    const row: { name: string; type: string; value: DbValue }[] = [
        { name: 'acknowledged', type: 'bool', value: true },
    ];
    if (plan.write === 'insert') {
        const ids = plan.insertedIds ?? [];
        row.push({ name: 'insertedCount', type: 'int', value: asNumber(reply.n) });
        row.push(
            ids.length === 1
                ? { name: 'insertedId', type: typeName(ids[0]), value: ids[0]! }
                : { name: 'insertedIds', type: 'array', value: ids },
        );
    } else if (plan.write === 'update') {
        const upserted =
            Array.isArray(reply.upserted) && isDocument(reply.upserted[0])
                ? reply.upserted[0]
                : null;
        const matched = asNumber(reply.n) - (upserted ? 1 : 0);
        row.push({ name: 'matchedCount', type: 'int', value: matched });
        row.push({ name: 'modifiedCount', type: 'int', value: asNumber(reply.nModified) });
        if (upserted)
            row.push({
                name: 'upsertedId',
                type: typeName(upserted._id),
                value: upserted._id ?? null,
            });
    } else {
        row.push({ name: 'deletedCount', type: 'int', value: asNumber(reply.n) });
    }
    yield { kind: 'columns', columns: row.map(({ name, type }) => ({ name, type })) };
    yield { kind: 'rows', rows: [row.map((entry) => entry.value)] };
    const warning = isDocument(reply.writeConcernError)
        ? String(reply.writeConcernError.errmsg ?? 'The write concern was not satisfied.')
        : undefined;
    yield {
        kind: 'end',
        rowCount: 1,
        affectedRows:
            plan.write === 'insert'
                ? asNumber(reply.n)
                : plan.write === 'update'
                  ? asNumber(reply.nModified)
                  : asNumber(reply.n),
        ...(warning ? { info: warning } : {}),
    };
}
