/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

/**
 * The renderer's view of Database Studio. Desktop only.
 *
 * Nothing here carries a file path. The renderer asks the main process to show a native file
 * dialog and gets back an opaque `token`; presenting that token opens the file. A page that has
 * been compromised therefore cannot name a file it was never given.
 */

/** A failed Database Studio call. `code` is a `DbErrorCode`; it stays a string here so `shared` has no dependency on the packages that raise it. */
export interface DbStudioError {
    code: string;
    message: string;
}

/** Same envelope as `IpcResult`, with Database Studio's own error codes. Handlers never throw across IPC. */
export type DbResult<T> = { ok: true; value: T } | { ok: false; error: DbStudioError };

/** A file the user chose, by token. `name` is the file name only, never the directory. */
export interface DbFileRef {
    token: string;
    name: string;
    size: number;
}

/** The line ending a file uses. */
export type DbLineEnding = '\n' | '\r\n';

export interface DbFileOpened {
    fileId: string;
    name: string;
    size: number;
    eol: DbLineEnding;
    /** Stable for the file's path, so unsaved work can be matched to it later. */
    fileKey: string;
    mtimeMs: number;
}

export type DbIndexState = 'indexing' | 'ready' | 'failed' | 'cancelled';

/** Pushed while a file is indexed in the background. */
export interface DbFileProgress {
    fileId: string;
    state: DbIndexState;
    bytesRead: number;
    totalBytes: number;
    /** Lines found so far; the final count once `ready`. */
    lines: number;
    error?: { code: string; message: string };
}

export interface DbLine {
    /** Zero-based. */
    line: number;
    text: string;
    /** The line was longer than the display limit and was cut. */
    truncated: boolean;
}

export interface DbLinesResult {
    lines: DbLine[];
    /** Lines readable now; final once `complete`. */
    lineCount: number;
    complete: boolean;
}

export type DbHostState = 'idle' | 'starting' | 'running' | 'crashed' | 'failed' | 'stopped';

/** Health of the isolated process that reads files. */
export interface DbHostStatus {
    state: DbHostState;
    restarts: number;
    message?: string;
}

export interface DbStudioBridge extends DbStudioFileBridge, DbConnectionBridge {
    getStatus(): Promise<DbHostStatus>;
    /** Shows the native open dialog. `null` means the user cancelled. */
    pickFile(): Promise<DbResult<DbFileRef | null>>;
    openFile(token: string): Promise<DbResult<DbFileOpened>>;
    readLines(fileId: string, from: number, count: number): Promise<DbResult<DbLinesResult>>;
    closeFile(fileId: string): Promise<DbResult<void>>;
    onFileProgress(listener: (progress: DbFileProgress) => void): () => void;
    onHostStatus(listener: (status: DbHostStatus) => void): () => void;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object';

const isCount = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0;

const INDEX_STATES: readonly unknown[] = ['indexing', 'ready', 'failed', 'cancelled'];
const HOST_STATES: readonly unknown[] = [
    'idle',
    'starting',
    'running',
    'crashed',
    'failed',
    'stopped',
];

export const isDbFileProgress = (value: unknown): value is DbFileProgress =>
    isRecord(value) &&
    typeof value.fileId === 'string' &&
    INDEX_STATES.includes(value.state) &&
    isCount(value.bytesRead) &&
    isCount(value.totalBytes) &&
    isCount(value.lines) &&
    (value.error === undefined ||
        (isRecord(value.error) &&
            typeof value.error.code === 'string' &&
            typeof value.error.message === 'string'));

export const isDbHostStatus = (value: unknown): value is DbHostStatus =>
    isRecord(value) &&
    HOST_STATES.includes(value.state) &&
    isCount(value.restarts) &&
    (value.message === undefined || typeof value.message === 'string');

/* ---------- Statements and documents ---------- */

export type DbItemFormat =
    'sql-mysql' | 'sql-postgresql' | 'jsonl' | 'json-array' | 'json-sequence';

export interface DbItemsAnalyzed {
    /** `null` when the file is not split into statements or documents. */
    format: DbItemFormat | null;
    kind: 'statement' | 'document' | null;
}

export type DbItemsState = 'scanning' | 'ready' | 'failed' | 'cancelled';

export interface DbItemsProgress {
    fileId: string;
    state: DbItemsState;
    bytesRead: number;
    totalBytes: number;
    count: number;
    error?: DbStudioError;
}

export interface DbItemSummary {
    index: number;
    start: number;
    length: number;
    /** `SELECT`, `INSERT`… for statements, `document` for documents. */
    label: string;
    preview: string;
    problem?: 'malformed' | 'unterminated';
}

export interface DbItemsList {
    items: DbItemSummary[];
    count: number;
    complete: boolean;
}

export interface DbItemText {
    index: number;
    start: number;
    length: number;
    text: string;
    /** The item is longer than what is returned. */
    truncated: boolean;
}

/* ---------- Search ---------- */

export interface DbSearchQuery {
    text: string;
    caseSensitive?: boolean;
    regex?: boolean;
    wholeWord?: boolean;
}

export interface DbSearchHit {
    offset: number;
    line: number;
    length: number;
    preview: string;
    previewStart: number;
}

export interface DbSearchHits {
    searchId: string;
    fileId: string;
    hits: DbSearchHit[];
}

export type DbSearchState = 'running' | 'done' | 'failed' | 'cancelled';

export interface DbSearchProgress {
    searchId: string;
    fileId: string;
    state: DbSearchState;
    bytesRead: number;
    totalBytes: number;
    hits: number;
    /** Stopped at the hit limit; there are more matches. */
    truncated: boolean;
    error?: DbStudioError;
}

/* ---------- Editing ---------- */

/** A run of lines of the document being saved: from the file on disk, or typed in. */
export type DbSavePiece =
    { kind: 'original'; from: number; count: number } | { kind: 'added'; lines: string[] };

/** A small file's whole text, for the full editor. */
export interface DbFileText {
    text: string;
    eol: DbLineEnding;
    /** The file is not valid UTF-8; editing it as text would change those bytes. */
    lossy: boolean;
}

export interface DbSaved {
    fileId: string;
    name: string;
    size: number;
    eol: DbLineEnding;
    fileKey: string;
    mtimeMs: number;
}

export interface DbReplaced extends DbSaved {
    replacements: number;
}

export interface DbEditProgress {
    fileId: string;
    op: 'save' | 'replace';
    bytes: number;
    totalBytes: number;
}

export interface DbStudioFileBridge {
    /** The whole text of a file up to 8 MiB; larger files are refused. */
    readText(fileId: string): Promise<DbResult<DbFileText>>;
    /** Writes the document over the file (refused if the file changed on disk meanwhile). */
    saveFile(fileId: string, pieces: DbSavePiece[], eol?: DbLineEnding): Promise<DbResult<DbSaved>>;
    /** Shows a save dialog and writes the document there; `null` means the user cancelled. */
    saveFileAs(
        fileId: string,
        pieces: DbSavePiece[],
        eol?: DbLineEnding,
    ): Promise<DbResult<DbSaved | null>>;
    /**
     * Writes a query tab's text to a file. With the token of a file this window already chose it
     * overwrites that file; otherwise a save dialog asks where. `null` means the user cancelled.
     * The returned token stands for the file written, so a later save goes to the same place
     * without the window ever learning the path.
     */
    saveText(
        token: string | null,
        suggestedName: string,
        text: string,
    ): Promise<DbResult<{ token: string; name: string; size: number } | null>>;
    /** Replaces every match in place, line by line. */
    replaceAll(
        fileId: string,
        query: DbSearchQuery,
        replacement: string,
    ): Promise<DbResult<DbReplaced>>;
    onEditProgress(listener: (progress: DbEditProgress) => void): () => void;
    analyzeFile(fileId: string, format?: DbItemFormat | 'auto'): Promise<DbResult<DbItemsAnalyzed>>;
    listItems(fileId: string, from: number, count: number): Promise<DbResult<DbItemsList>>;
    readItem(fileId: string, index: number): Promise<DbResult<DbItemText>>;
    /** Index of the statement or document containing a byte offset; -1 if none. */
    itemAt(fileId: string, offset: number): Promise<DbResult<{ index: number }>>;
    /**
     * Starts a search under an id the caller chose (16 hex characters), so events that arrive
     * before this call's reply can already be matched to it.
     */
    startSearch(
        fileId: string,
        searchId: string,
        query: DbSearchQuery,
        maxHits?: number,
    ): Promise<DbResult<{ searchId: string }>>;
    cancelSearch(searchId: string): Promise<DbResult<void>>;
    onItemsProgress(listener: (progress: DbItemsProgress) => void): () => void;
    onSearchHits(listener: (batch: DbSearchHits) => void): () => void;
    onSearchProgress(listener: (progress: DbSearchProgress) => void): () => void;
}

const isErrorShape = (value: unknown): boolean =>
    value === undefined ||
    (isRecord(value) && typeof value.code === 'string' && typeof value.message === 'string');

export const isDbItemsProgress = (value: unknown): value is DbItemsProgress =>
    isRecord(value) &&
    typeof value.fileId === 'string' &&
    ['scanning', 'ready', 'failed', 'cancelled'].includes(value.state as string) &&
    isCount(value.bytesRead) &&
    isCount(value.totalBytes) &&
    isCount(value.count) &&
    isErrorShape(value.error);

const isHit = (value: unknown): value is DbSearchHit =>
    isRecord(value) &&
    isCount(value.offset) &&
    isCount(value.line) &&
    isCount(value.length) &&
    typeof value.preview === 'string' &&
    isCount(value.previewStart);

export const isDbSearchHits = (value: unknown): value is DbSearchHits =>
    isRecord(value) &&
    typeof value.searchId === 'string' &&
    typeof value.fileId === 'string' &&
    Array.isArray(value.hits) &&
    value.hits.every(isHit);

export const isDbSearchProgress = (value: unknown): value is DbSearchProgress =>
    isRecord(value) &&
    typeof value.searchId === 'string' &&
    typeof value.fileId === 'string' &&
    ['running', 'done', 'failed', 'cancelled'].includes(value.state as string) &&
    isCount(value.bytesRead) &&
    isCount(value.totalBytes) &&
    isCount(value.hits) &&
    typeof value.truncated === 'boolean' &&
    isErrorShape(value.error);

export const isDbEditProgress = (value: unknown): value is DbEditProgress =>
    isRecord(value) &&
    typeof value.fileId === 'string' &&
    (value.op === 'save' || value.op === 'replace') &&
    isCount(value.bytes) &&
    isCount(value.totalBytes);

/* ---------- Database connections ---------- */

export interface DbEngineInfo {
    id: string;
    displayName: string;
    defaultPort: number;
    capabilities: string[];
}

export type DbTlsMode = 'disable' | 'prefer' | 'require' | 'verify-ca' | 'verify-full';

/**
 * How to reach a server, without its password. The renderer holds and stores this; the password
 * lives only in the operating system's credential store, in the main process, and is added to a
 * connection request there.
 */
export interface DbConnectionSettings {
    engine: string;
    host: string;
    port: number;
    database?: string;
    username?: string;
    tls: { mode: DbTlsMode; ca?: string; cert?: string; key?: string; serverName?: string };
    connectTimeoutMs?: number;
    queryTimeoutMs?: number;
    options?: Record<string, string>;
}

export type DbConnectionState = 'connecting' | 'connected' | 'disconnected' | 'failed';

export interface DbPermissions {
    read: boolean;
    write: boolean;
    schema: boolean;
    grants?: string[];
}

export interface DbServerInfo {
    product: string;
    version: string;
    connectionId?: string;
    user?: string;
    secure: boolean;
}

export interface DbConnectionStatus {
    id: string;
    state: DbConnectionState;
    server?: DbServerInfo;
    permissions?: DbPermissions;
    error?: DbStudioError;
    reconnects: number;
}

export interface DbTestResult {
    ok: boolean;
    server?: DbServerInfo;
    elapsedMs: number;
    permissions?: DbPermissions;
}

export interface DbColumnMeta {
    name: string;
    type: string;
    nullable?: boolean;
}

/** What is known about one result set of a statement. */
export interface DbResultInfo {
    index: number;
    columns: DbColumnMeta[];
    rowCount: number;
    complete: boolean;
    capped: boolean;
    affectedRows?: number;
    insertId?: string;
    info?: string;
    warnings?: number;
}

export type DbQueryState = 'running' | 'done' | 'failed' | 'cancelled';

export interface DbQuerySnapshot {
    state: DbQueryState;
    results: DbResultInfo[];
    elapsedMs: number;
    /** Still running on the server, but not being read: the window has all it asked for. */
    paused: boolean;
    error?: DbStudioError;
}

/** A value in a result cell. Wide cells arrive cut; see `clipped`. */
export type DbCell =
    | null
    | boolean
    | number
    | bigint
    | string
    | Date
    | Uint8Array
    | { $type: string; $value: string }
    | DbCell[]
    | { [key: string]: DbCell };

export interface DbResultPage {
    rows: DbCell[][];
    clipped: { row: number; column: number; length: number }[];
    firstRow: number;
    pageSize: number;
}

export type DbScriptState = 'running' | 'done' | 'failed' | 'cancelled';

export interface DbScriptProgress {
    state: DbScriptState;
    executed: number;
    failed: number;
    affectedRows: number;
    rowsReturned: number;
    bytesRead: number;
    totalBytes: number;
    elapsedMs: number;
    errors: { statement: number; line: number; error: DbStudioError; preview: string }[];
    current?: string;
}

/** A pushed message from the database host. */
/* ---------- Background tasks ---------- */

export type DbTaskType =
    | 'export'
    | 'import'
    | 'script'
    | 'backup'
    | 'restore'
    | 'bulk-update'
    | 'index'
    | 'query'
    | 'parse';

export type DbTaskState =
    'PENDING' | 'RUNNING' | 'PAUSED' | 'CANCELLING' | 'CANCELLED' | 'COMPLETED' | 'FAILED';

export const DB_TASK_FINAL_STATES: readonly DbTaskState[] = ['COMPLETED', 'FAILED', 'CANCELLED'];

export interface DbTaskIssue {
    record?: number;
    statement?: number;
    line?: number;
    message: string;
}

/** What the task center shows for one background operation. No field is a file path. */
export interface DbTaskSnapshot {
    id: string;
    name: string;
    type: DbTaskType;
    state: DbTaskState;
    stage: string;
    source?: string;
    destination?: string;
    database?: string;
    target?: string;
    file?: string;
    connectionId?: string;
    totalBytes?: number;
    totalRows?: number;
    bytesProcessed: number;
    rowsProcessed: number;
    percent: number | null;
    startedAt: number | null;
    endedAt: number | null;
    elapsedMs: number;
    errorCount: number;
    issues: DbTaskIssue[];
    message?: string;
    error?: DbStudioError;
    /** Where a resumed run would start; opaque to the window. */
    checkpoint?: unknown;
    resumable?: boolean;
}

export type DbExportFormat = 'csv' | 'json' | 'ndjson' | 'sql' | 'bson';
export type DbImportFormat = 'csv' | 'json' | 'ndjson' | 'bson';

export interface DbExportRequest {
    connectionId: string;
    taskId: string;
    source:
        | { kind: 'table'; database?: string; schema?: string; name: string }
        | { kind: 'query'; text: string; label?: string };
    format: DbExportFormat;
    csv?: {
        delimiter?: string;
        header?: boolean;
        bom?: boolean;
        eol?: 'crlf' | 'lf';
        /** What a NULL is written as; empty by default. */
        nullText?: string;
    };
    sql?: { rowsPerStatement?: number; includeCreate?: boolean; includeDrop?: boolean };
    fetchSize?: number;
    /** The name offered in the save dialog. */
    suggestedName?: string;
}

export interface DbImportRequest {
    connectionId: string;
    taskId: string;
    /** The token of a file chosen in the file dialog. */
    fileToken: string;
    format: DbImportFormat;
    target: { database?: string; schema?: string; name: string };
    mode?: 'append' | 'truncate';
    batchSize?: number;
    onError?: 'stop' | 'skip';
    transaction?: 'none' | 'batch' | 'all';
    csv?: {
        delimiter?: string;
        header?: boolean;
        columnMap?: Record<string, string>;
        nullToken?: string;
        emptyAsNull?: boolean;
    };
    /** Write rejected records to a file beside the input. */
    saveRejects?: boolean;
    resume?: unknown;
}

export interface DbScriptTaskRequest {
    connectionId: string;
    taskId: string;
    fileToken: string;
    dialect: 'mysql' | 'postgresql';
    onError: 'stop' | 'continue';
    transaction?: 'none' | 'single';
    statementTimeoutMs?: number;
}

/** Reply to starting a task that asks for a destination: the user may cancel the dialog. */
export type DbTaskStarted = { started: true; taskId: string } | { started: false };

export type DbHostEvent =
    | { topic: 'conn.status'; payload: { connectionId: string; status: DbConnectionStatus } }
    | { topic: 'task.state'; payload: { snapshot: DbTaskSnapshot } }
    | { topic: 'task.lost'; payload: { reason: string } }
    | {
          topic: 'query.state';
          payload: { queryId: string; connectionId: string; snapshot: DbQuerySnapshot };
      }
    | {
          topic: 'script.progress';
          payload: { scriptId: string; connectionId: string; progress: DbScriptProgress };
      };

/** Operations the window may ask the database host for. Everything else is refused in main. */
export const DB_HOST_OPS = [
    'engines.list',
    'conn.test',
    'conn.open',
    'conn.close',
    'meta.list',
    'meta.definition',
    'meta.sessions',
    'meta.kill',
    'meta.status',
    'query.start',
    'query.page',
    'query.cell',
    'query.demand',
    'query.fetchAll',
    'query.cancel',
    'query.close',
    'query.explain',
    'tx.begin',
    'tx.commit',
    'tx.rollback',
    'sql.split',
    'sql.statementAt',
    'script.start',
    'script.cancel',
    'script.close',
    'task.export',
    'task.import',
    'task.script',
    'task.list',
    'task.cancel',
    'task.pause',
    'task.resume',
    'task.remove',
] as const;

export type DbHostOp = (typeof DB_HOST_OPS)[number];

export interface DbConnectionBridge {
    /**
     * Sends one request to the database host. `conn.test` and `conn.open` take
     * `{ connectionId, settings, profileId }`: the password is looked up in the credential store
     * by `profileId` in the main process and never passes through here. `script.start` takes a
     * `fileId` of an open file, not a path.
     */
    dbRequest(op: DbHostOp, payload?: unknown): Promise<DbResult<unknown>>;
    onDbEvent(listener: (event: DbHostEvent) => void): () => void;
    /** Stores a password in the OS credential store; it cannot be read back. */
    setDbPassword(profileId: string, password: string): Promise<boolean>;
    hasDbPassword(profileId: string): Promise<boolean>;
    deleteDbPassword(profileId: string): Promise<void>;
}

export const isDbHostEvent = (value: unknown): value is DbHostEvent =>
    isRecord(value) &&
    typeof value.topic === 'string' &&
    ['conn.status', 'query.state', 'script.progress', 'task.state', 'task.lost'].includes(
        value.topic,
    ) &&
    isRecord(value.payload);

/* ---------- Schema objects (as the explorer shows them) ---------- */

export interface DbDatabaseInfo {
    name: string;
    system: boolean;
}

export interface DbTableInfo {
    database?: string;
    schema?: string;
    name: string;
    kind: string;
    rows?: number;
    bytes?: number;
    comment?: string;
}

export interface DbColumnInfo {
    name: string;
    position: number;
    type: string;
    nullable: boolean;
    default?: string;
    primaryKey: boolean;
    autoIncrement?: boolean;
    comment?: string;
}

export interface DbIndexInfo {
    name: string;
    columns: string[];
    unique: boolean;
    primary: boolean;
    method?: string;
}

export interface DbConstraintInfo {
    name: string;
    kind: string;
    columns: string[];
    references?: { table: string; columns: string[] };
}

export interface DbRoutineInfo {
    database?: string;
    schema?: string;
    name: string;
    kind: 'procedure' | 'function';
    returns?: string;
}

export interface DbTriggerInfo {
    database?: string;
    schema?: string;
    name: string;
    table: string;
    timing: string;
    event: string;
}

export interface DbEventInfo {
    name: string;
    status: string;
    schedule: string;
}

export interface DbSessionInfo {
    id: string;
    user?: string;
    database?: string;
    state?: string;
    seconds?: number;
    statement?: string;
}

export interface DbExplainPlan {
    text: string;
    tree?: unknown;
}

export type DbMetaKind =
    | 'databases'
    | 'schemas'
    | 'tables'
    | 'columns'
    | 'indexes'
    | 'constraints'
    | 'routines'
    | 'triggers'
    | 'events';
