/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

/**
 * The contracts between Database Studio and a database engine.
 *
 * An engine (MySQL, PostgreSQL, MongoDB, and whatever comes later) implements these; nothing
 * above them knows which engine it is talking to, and nothing here assumes the data is relational.
 * The contract is split into *capabilities*: a relational engine implements `RelationalSession`, a
 * document engine `DocumentSession`, and a caller asks a provider what it can do instead of
 * branching on its name.
 */

/* ---------- Values ---------- */

/**
 * A value in a result row or a document. These all survive structured clone, which is how rows
 * cross from the database process to the window, so no value needs special encoding in transit.
 * Engine-specific types (a MongoDB ObjectId, a PostgreSQL interval) arrive as a `DbTagged`.
 */
export type DbValue =
    | null
    | boolean
    | number
    | bigint
    | string
    | Date
    | Uint8Array
    | DbTagged
    | DbValue[]
    | { [key: string]: DbValue };

/** A value of an engine type that has no JavaScript equivalent; shown as its text. */
export interface DbTagged {
    /** The engine's name for the type (`objectId`, `decimal128`, `interval`…). */
    $type: string;
    /** Its text form. */
    $value: string;
}

export const isDbTagged = (value: unknown): value is DbTagged =>
    !!value &&
    typeof value === 'object' &&
    typeof (value as DbTagged).$type === 'string' &&
    typeof (value as DbTagged).$value === 'string' &&
    Object.keys(value).length === 2;

/* ---------- Connections ---------- */

export type TlsMode =
    /** Never use TLS. */
    | 'disable'
    /** Use TLS when the server offers it, without checking the certificate. */
    | 'prefer'
    /** Require TLS but do not check the certificate. */
    | 'require'
    /** Require TLS and a certificate signed by a trusted CA. */
    | 'verify-ca'
    /** Require TLS, a trusted certificate, and a name that matches the host. */
    | 'verify-full';

export interface TlsConfig {
    mode: TlsMode;
    /** Extra trusted certificate authorities, as PEM text. */
    ca?: string;
    /** Client certificate and key, as PEM text. */
    cert?: string;
    key?: string;
    /** The name to check the certificate against, when it differs from the host. */
    serverName?: string;
}

/**
 * Everything needed to connect. The password is present only for the moment of connecting, in the
 * process that connects: a profile on disk and a profile in the window never carry one.
 */
export interface ConnectionConfig {
    engine: string;
    host: string;
    port: number;
    database?: string;
    username?: string;
    password?: string;
    tls: TlsConfig;
    connectTimeoutMs: number;
    /** Longest a statement may run before it is cancelled; 0 for no limit. */
    queryTimeoutMs: number;
    /** Engine-specific settings, such as a MongoDB replica set name or auth source. */
    options: Record<string, string>;
}

export interface ServerInfo {
    /** Product, for example `MySQL`, `MariaDB`, `PostgreSQL`, `MongoDB`. */
    product: string;
    version: string;
    /** The session id on the server, used to cancel its statements. */
    connectionId?: string;
    /** The user the server authenticated. */
    user?: string;
    /** Whether the connection is encrypted. */
    secure: boolean;
}

export interface TestResult {
    ok: boolean;
    server?: ServerInfo;
    elapsedMs: number;
    /** What the signed-in user may do, when the engine can tell. */
    permissions?: PermissionSet;
}

/** What the connected account is allowed to do, so the UI can disable what would fail. */
export interface PermissionSet {
    /** The account can read data. */
    read: boolean;
    /** The account can change data. */
    write: boolean;
    /** The account can change schema (create, alter, drop). */
    schema: boolean;
    /** Free-text grants, for display. */
    grants?: string[];
}

/* ---------- Capabilities ---------- */

export type Capability =
    | 'sql'
    | 'documents'
    | 'explain'
    | 'transactions'
    | 'routines'
    | 'triggers'
    | 'events'
    | 'sequences'
    | 'extensions'
    | 'materializedViews'
    | 'sessions'
    | 'serverStatus'
    | 'indexes'
    | 'aggregation'
    | 'schemaInference';

export interface DatabaseProvider {
    /** Stable id: `mysql`, `postgresql`, `mongodb`. */
    readonly id: string;
    readonly displayName: string;
    readonly defaultPort: number;
    readonly capabilities: ReadonlySet<Capability>;
    /** Creates a connector. No I/O happens until `connect`. */
    createConnector(config: ConnectionConfig): Connector;
}

export interface Connector {
    connect(signal?: AbortSignal): Promise<Session>;
}

/** An open connection. */
export interface Session {
    readonly info: ServerInfo;
    /** False once the connection is known to be gone (closed here, or dropped by the server). */
    readonly alive: boolean;
    /** Checks that the connection is alive. */
    ping(): Promise<void>;
    /** Reads what the account may do. */
    getPermissions(): Promise<PermissionSet>;
    close(): Promise<void>;
}

/* ---------- Results ---------- */

export interface ColumnMeta {
    name: string;
    /** A display type such as `int`, `varchar(64)` or `timestamptz`. */
    type: string;
    nullable?: boolean;
}

/** One step of a running statement, in the order the server produced it. */
export type ResultEvent =
    /** A result set begins. */
    | { kind: 'columns'; columns: ColumnMeta[] }
    /** Some rows of the current result set. */
    | { kind: 'rows'; rows: DbValue[][] }
    /** The current result set (or a statement with no rows) ends. */
    | {
          kind: 'end';
          /** Rows produced, for a query. */
          rowCount?: number;
          /** Rows changed, for a write. */
          affectedRows?: number;
          insertId?: string;
          /** A message from the server (`Rows matched: 1  Changed: 1`). */
          info?: string;
          warnings?: number;
      };

/**
 * A statement in flight. Iterating it yields events as the server sends them, and stops reading
 * from the network while the consumer is not iterating, so a slow reader slows the server down
 * instead of filling memory.
 */
export interface Execution extends AsyncIterable<ResultEvent> {
    /** Asks the server to stop this statement. Iteration then ends with a `CANCELLED` error. */
    cancel(): Promise<void>;
}

export interface ExecuteOptions {
    /** Rows per `rows` event. */
    pageRows?: number;
    /** Overrides the connection's statement timeout. */
    timeoutMs?: number;
    signal?: AbortSignal;
}

/* ---------- Relational engines ---------- */

/** A table, view, routine or similar, addressed by where it lives. */
export interface ObjectRef {
    /** The database (MySQL) or database (PostgreSQL); omitted for the current one. */
    database?: string;
    /** The schema (PostgreSQL); MySQL has none. */
    schema?: string;
    name: string;
}

export interface DatabaseInfo {
    name: string;
    /** System databases are shown after the user's own. */
    system: boolean;
}

export interface SchemaInfo {
    name: string;
    system: boolean;
}

export interface TableInfo extends ObjectRef {
    /** `table`, `view`, `materialized view`, `foreign table`… */
    kind: string;
    /** Estimated rows, from the server's statistics. */
    rows?: number;
    /** Size in bytes, from the server's statistics. */
    bytes?: number;
    comment?: string;
}

export interface ColumnInfo {
    name: string;
    position: number;
    type: string;
    nullable: boolean;
    default?: string;
    primaryKey: boolean;
    autoIncrement?: boolean;
    comment?: string;
}

export interface IndexInfo {
    name: string;
    columns: string[];
    unique: boolean;
    primary: boolean;
    /** `BTREE`, `HASH`, `GIN`… */
    method?: string;
}

export interface ConstraintInfo {
    name: string;
    /** `PRIMARY KEY`, `FOREIGN KEY`, `UNIQUE`, `CHECK`. */
    kind: string;
    columns: string[];
    /** For a foreign key: what it points at. */
    references?: { table: string; columns: string[] };
    definition?: string;
}

export interface RoutineInfo extends ObjectRef {
    kind: 'procedure' | 'function';
    returns?: string;
}

export interface TriggerInfo extends ObjectRef {
    table: string;
    timing: string;
    event: string;
}

export interface ExplainPlan {
    /** The plan as text, in the engine's own format. */
    text: string;
    /** The plan as structured data, when the engine can give it. */
    tree?: DbValue;
}

export interface SessionInfo {
    id: string;
    user?: string;
    database?: string;
    state?: string;
    /** Seconds the statement has been running. */
    seconds?: number;
    statement?: string;
}

export interface RelationalSession extends Session {
    /** Runs one statement (or, where the engine allows, several). */
    execute(sql: string, options?: ExecuteOptions): Execution;
    explain(sql: string): Promise<ExplainPlan>;
    begin(): Promise<void>;
    commit(): Promise<void>;
    rollback(): Promise<void>;

    quoteIdentifier(name: string): string;
    quoteLiteral(value: string): string;

    listDatabases(): Promise<DatabaseInfo[]>;
    /** Engines without schemas inside a database (MySQL) return an empty list. */
    listSchemas(database?: string): Promise<SchemaInfo[]>;
    listTables(scope: { database?: string; schema?: string }): Promise<TableInfo[]>;
    listColumns(table: ObjectRef): Promise<ColumnInfo[]>;
    listIndexes(table: ObjectRef): Promise<IndexInfo[]>;
    listConstraints(table: ObjectRef): Promise<ConstraintInfo[]>;
    listRoutines(scope: { database?: string; schema?: string }): Promise<RoutineInfo[]>;
    listTriggers(scope: { database?: string; schema?: string }): Promise<TriggerInfo[]>;
    /** The statement that creates the object, for display. */
    getDefinition(object: ObjectRef & { kind: string }): Promise<string>;
    listSessions(): Promise<SessionInfo[]>;
    killSession(id: string): Promise<void>;
    serverStatus(): Promise<Record<string, string>>;
}

export const isRelationalSession = (session: Session): session is RelationalSession =>
    typeof (session as RelationalSession).execute === 'function';
