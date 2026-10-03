# Database Studio add-on: architecture proposal

Status: proposal, nothing implemented yet. This document fixes the architecture, package layout, process model, large-file strategy, provider interfaces and phasing, so the first code lands on a plan.

Database Studio is an **add-on module of this application**, not a separate product. Nothing existing changes: the API client, SSH, tunnels, scripts, codegen and workspaces keep working with the add-on absent or disabled. It plugs in at the seams the app already has (see [architecture.md](architecture.md)): a `PlatformCapabilities` flag, a preload bridge, a rail entry, and `services.ts` handlers.

## Implementation status

Phases 0 to 4 are implemented for MySQL, and the PostgreSQL, MongoDB and Redis/Valkey providers are in place on the same host and UI. Everything below describes the target; this table says what exists, and for each engine how far it was tested.

| Area               | State                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Packages           | `db-core`, `streaming-engine`, `file-engine`, `db-workers` exist. The other packages in section 3 are created when their phase starts, so there are no empty placeholders.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Boundaries         | ESLint enforces the allowed imports between these packages, bans Electron, React and `fs` outside `file-engine`, and bans whole-file reads (`readFile`, `.text()`) in them. `eslint.config.js`, `DB_PACKAGE_DEPENDENCIES`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Capability and UI  | `PlatformCapabilities.databaseStudio`, derived from the preload bridge. A "Database Studio" sidebar view (open a large file, background index progress, go to line, preview). Disabled with a tooltip in the browser build. No gating (section 10).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Isolation          | The File Host runs as an Electron utility process (`apps/desktop/src/fileHost.ts`), supervised by `WorkerSupervisor`: crash recovery, restart back-off and a crash-loop limit, cancel with a kill fallback, a V8 heap limit.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| File access        | Files are opened by an opaque token from a native dialog, never a renderer-supplied path. Path policy, regular-file check on the opened handle, bounded double-buffered chunk reader, sparse line index with an on-disk cache.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Benchmarks         | `npm run bench:db` (generators for SQL, JSONL, JSON, CSV and one-line minified JSON; open, index, cached reopen, go-to-line). See `bench/db-studio/README.md`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Files              | SQL and JSON boundary scanners, streaming search (bytes and regex), a virtual line viewer with line-level editing, atomic save, replace-all, a recovery journal. Files up to 8 MiB also open in Monaco.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| MySQL              | In-house wire protocol (`db-protocol-mysql`: TLS, `caching_sha2_password`, `mysql_native_password`, text protocol, multi-result, back-pressure, `KILL QUERY`), `mysql-engine`, streaming result spool on disk, query and script runs with cancel and timeout, connection manager with reconnect, DB Host utility process. Tested against a real `mysqld` (skipped when none is installed).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Connections UI     | Saved connections (passwords only in the OS credential store), test, explorer tree of databases, tables, columns, indexes, routines, triggers and events, SQL editor tabs, paged virtual result grid with on-demand reading, transactions, explain, history that hides statements carrying passwords. Verified in the real desktop app against MySQL 26.7.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| MongoDB            | In-house BSON codec (all types, Decimal128, fuzzed), `OP_MSG` wire protocol, SCRAM-SHA-256 and SCRAM-SHA-1 (checked against the RFC 7677 example), TLS. `mongo-engine` takes shell-style statements (`db.orders.find({…}).sort({…}).limit(20)`, `use`, `show dbs`, inserts, updates, deletes, aggregation, indexes, `explain`), reads them with a parser that never evaluates code, streams cursors batch by batch, cancels with `killOp`, supports transactions, and infers fields from a sample. **Tested against a real mongod 8.2**, including access control and a replica set.                                                                                                                                                                                                                                                                                                                                                              |
| Redis / Valkey     | In-house RESP2 and RESP3 driver (back-pressure, streamed replies, auth, TLS, `HELLO` fallback), `redis-engine` with `redis-cli`-style commands, replies shown as tables, a key browser capped at 5,000 keys per database, key info, `CLIENT` sessions, `MULTI`/`EXEC`. Cancelling a command drops the connection (Redis cannot interrupt one). **Tested only against a scripted in-process server (`startFakeRedis`)**: it proves the protocol handling is self-consistent, not that every real server behaves identically. No Redis or Valkey is installed on the development machine.                                                                                                                                                                                                                                                                                                                                                           |
| PostgreSQL         | In-house v3 driver (simple query flow, SCRAM-SHA-256, md5, cleartext, TLS negotiation, typed text decoding incl. arrays, cancel by `CancelRequest`, back-pressure). `postgres-engine` browses databases, schemas, tables, columns, indexes, constraints, routines and triggers, rebuilds definitions, lists and ends sessions. **Tested only against a scripted server (`startFakePostgres`)**; it does not parse SQL, so the catalog queries are checked for how their answers are mapped, not for being valid PostgreSQL. Run them against a real server before relying on them. Statements run on the database the connection was opened with; other databases are browse-only.                                                                                                                                                                                                                                                                |
| Connection strings | `packages/shared/src/connectionString.ts` parses and writes `mysql://`, `postgresql://`, `mongodb://`, `mongodb+srv://` and `redis://` strings (SSL modes, search path, replica set, auth source, read preference, write concern, retry flags, every other parameter kept by name). The connection form and the string are one model: pasting fills the form, editing the form rewrites the string, and the password is always shown masked. `mongodb+srv` is resolved by the driver (`mongo-engine/src/topology.ts`): SRV and TXT records as the driver specification says, SRV targets refused outside the cluster domain, then the primary is found from a seed list. Failures are classified (DNS, SRV, timeout, refused, TLS, certificate, login, unsupported login method, database unavailable) in `connectionErrors.ts` and never repeat a password. Tested with fake DNS and fake members; **not yet run against a real Atlas cluster**. |
| Admin tools        | `packages/db-admin` holds capabilities (`capabilitiesOf(engine)`), SQL dialect strategies (MySQL, PostgreSQL) and the statement generators for the table designer (create and alter with a diff), row editing, views, functions, procedures, triggers, indexes, sequences, the MongoDB statements, a BSON-aware document model and the relationship graph with auto layout. The window shows only what an engine's capabilities allow. Generated SQL is previewed before it runs. These generators are unit tested for output; the statements have **not** been run against real MySQL or PostgreSQL servers in this change (the MySQL integration test is skipped when no `mysqld` is installed).                                                                                                                                                                                                                                                |
| Editors            | Table data editor (paged, filtered, sorted on the server; staged edits, inserts and deletes written in one transaction after a preview; NULL, JSON and binary cells), table designer, ER diagram (zoom, pan, drag, auto layout, navigation), MongoDB document editor (tree and JSON views, only changed fields saved with `$set`/`$unset`), index and trigger managers, run-a-routine dialog.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Import and export  | `packages/transfer-engine`: incremental CSV and JSON/NDJSON/BSON readers feed a bounded queue and a batch writer (multi-row INSERT or `insertMany`), with transactions per batch or for the whole import, skip-or-stop, rejected records saved to a file, a resumable checkpoint (not for the single-transaction mode), cancellation and progress. Exports stream a server cursor through a formatter into a buffered file writer that writes to a temporary file and renames on success; disk space, permissions and a missing folder fail at the start with a plain message. Measured: 1,000,000 rows exported with a heap growth under 80 MB; 1 GB of CSV imported in 90 s at 211 MB peak (against a fake database, so it times the pipeline, not a server).                                                                                                                                                                                   |
| Background tasks   | `BackgroundTaskManager` in `db-core` (PENDING, RUNNING, PAUSED, CANCELLING, CANCELLED, COMPLETED, FAILED), run inside the database host on a session of their own so query tabs never wait; progress is throttled to one snapshot per task per 250 ms; a crashed host marks running tasks failed in the window. The task list floats over the workbench and has a fixed row layout.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Large files        | `largeFile.ts`: size from metadata decides editor (up to 4 MiB), Large File Mode (up to 32 MiB, costly features off, banner), or no editor (streaming viewer, execute as a script task, import). Limits are configurable up to the file host's 64 MiB ceiling. Monaco was measured in `bench/monaco-large` (see its README): stable to 256 MB for editing, but `getValue()` fails at 256 MB and a JavaScript string cannot exceed about 512 MB, so 1 to 2 GB files are never opened in Monaco.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Not yet            | Table and collection backup and restore tooling, PostgreSQL sequences and extensions in the explorer tree, session and server-status viewers, SSH tunnels for database connections, PostgreSQL `COPY` and extended-query protocol, PostgreSQL SCRAM channel binding, MongoDB X.509 and Kerberos login, Redis pub/sub and `MONITOR`, Redis key tree by prefix, the CI job for the benchmark tiers, applying a MongoDB `retryWrites`/`retryReads` setting (it is stored and kept in the string; the driver does not retry).                                                                                                                                                                                                                                                                                                                                                                                                                         |

First measurements (Windows, NVMe, fixture in the OS file cache, so these time the scanner, not a cold disk): a 3 GB, 20.5-million-line SQL file indexed in 2.1 s (about 1.4 GB/s), first screen in 16 ms, go-to-line p95 6 ms, cached reopen 17 ms; a 3 GB one-line JSON indexed in 1.1 s and showed its first (truncated) line in 14 ms. Resident memory growth stayed within the sampler's resolution. Cold-disk and 1 to 2 GB tiers have not been run.

Differences from the plan above, found while building it:

- The line index is much smaller than budgeted: one 8-byte checkpoint per 4,096 lines, so a 3 GB file of 25 million lines needs about 50 KB. The 16 MB figure in section 6.1 was a worst-case allowance.
- A file is browsable while it is still being indexed, including its in-progress line, which is shown up to the bytes scanned so far. This matters for a one-line 3 GB JSON, which would otherwise show nothing until the whole file had been scanned.
- Reads still travel renderer → main → File Host as ordinary IPC. They are small (at most 1,000 lines and 4 MiB), so the direct `MessagePort` data plane of section 4 is deferred to phase 2, when search hits and query rows make it worthwhile.
- If the File Host dies, its open files die with it. The UI is told and the user reopens the file; automatic re-open is not implemented.
- MongoDB and Redis implement the same session contract as the SQL engines (text statements in, tabular result events out) instead of a separate `DocumentSession`. Documents become rows, a collection is shown like a table, and a key like a row source, so the host, the result spool, cancellation and the grid are shared. What differs is declared by the provider's capabilities and by `packages/ui/src/dbstudio/db/engines.ts` (explorer layout, editor language, how an object is opened). A tree or JSON document editor, a visual query builder and index management dialogs are not built yet.
- The three new engines register in `apps/desktop/src/dbHost.ts`. Statement splitting for them lives in the host (`sql.split` with the dialects `redis` and `mongodb`); scripts from files are SQL-only.
- The "3 GB on a small machine" check is a unit test against a synthetic file source (`PatternSource`), plus the benchmark on real files, so it runs without a 3 GB file in the repository.

## 1. Principles

1. **Additive and removable.** Delete the `db-*` packages and the add-on's bridge and the rest of the app builds and runs unchanged. The shared UI never imports add-on code unconditionally; it is code-split and loaded only when the user opens it.
2. **Large files from day one.** Every file path in the add-on goes through `file-engine`; no module is allowed a `readFile`/`JSON.parse(whole)` path. A lint rule and a test enforce it (section 6.7).
3. **No heavy third-party dependencies.** Wire protocols are implemented in-house on `node:net`, `node:tls`, `node:crypto`, `node:zlib` and `node:worker_threads`. See section 9 for the exact dependency ledger.
4. **Reuse what exists.** Secure credential storage (`safeStorage`-backed `CredentialStore`), SSH tunnels and known-hosts, `redact`, the `IpcResult` envelope and the sender-keyed resource pattern are reused, not rebuilt.
5. **Providers, not branches.** Engine differences live in provider classes. Common code never switches on engine name; it asks a provider for a capability.

## 2. Layering

```text
Desktop UI (React, packages/ui + db-ui)          renderer, sandboxed, no Node
    ↓  typed bridge (preload), validated both ways
Application Services (apps/desktop/src/db/*)     main process: auth of sender,
    ↓                                              worker supervision, brokers MessagePorts
Database Abstraction Layer (db-core)             provider contracts, capability model, commands
    ↓
Database Providers (mysql-/postgresql-/mongodb-engine)
    ↓
Protocol / Driver Layer (in-house wire protocols) node:net / node:tls
```

Dependency rule (enforced by an ESLint `no-restricted-imports` boundary config, like the existing package boundaries): arrows only point downward; `db-core` imports nothing except `shared`; engines import `db-core` and never each other; nothing under `packages/` imports `electron`.

## 3. Package structure

Packages are flat siblings, prefixed `db-`, so the existing `packages/*` workspace glob needs no change. The proposed names from the brief map as follows.

| Package              | Responsibility                                                                                                                                                                            | Notes                                                                                                     |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `db-core`            | `DatabaseProvider` contracts, capability model, `Command` types, error taxonomy, `ProviderRegistry`, value model (`DbValue`).                                                             | Zero runtime deps.                                                                                        |
| `db-protocol-pg`     | PostgreSQL wire protocol v3 (startup, SCRAM-SHA-256/MD5/cleartext, simple and extended query, COPY, cancel request, TLS upgrade).                                                         | Driver layer.                                                                                             |
| `db-protocol-mysql`  | MySQL/MariaDB protocol (handshake, `caching_sha2_password`, `mysql_native_password`, COM_QUERY text protocol, COM_STMT_PREPARE/EXECUTE binary protocol, LOCAL INFILE refused by default). | Driver layer.                                                                                             |
| `db-protocol-mongo`  | OP_MSG, BSON encoder/decoder (incl. Extended JSON v2), SCRAM-SHA-256/1, cursors, `killCursors`.                                                                                           | Driver layer.                                                                                             |
| `mysql-engine`       | `MySqlProvider` on top of `db-protocol-mysql`; `information_schema` metadata queries; events, triggers, processlist, EXPLAIN.                                                             | Implements the relational capability set.                                                                 |
| `postgresql-engine`  | `PgProvider`; `pg_catalog` queries; materialized views, sequences, extensions, `pg_stat_activity`.                                                                                        |                                                                                                           |
| `mongodb-engine`     | `MongoProvider`; document capability set only.                                                                                                                                            | No relational concepts.                                                                                   |
| `connection-manager` | Profiles, lifecycle, pooling, reconnect, timeouts, grouping, favourites, recents, SSH/TLS wiring.                                                                                         | Pool is generic; engines supply a `Connector`.                                                            |
| `query-engine`       | Command pattern for execution (`ExecuteStatement`, `ExecuteScript`, `Explain`), cancellation, timeouts, transactions, history, result cursors.                                            | Engine-agnostic.                                                                                          |
| `sql-parser`         | Incremental SQL scanner and statement boundary index; lazy per-statement classifier and tokenizer. Dialects as data (MySQL, PostgreSQL).                                                  | See section 6.3.                                                                                          |
| `document-engine`    | Incremental JSON / JSONL / Extended JSON scanner, document offset index, lazy document parse, path search.                                                                                | See section 6.4.                                                                                          |
| `schema-engine`      | Relational DDL model and diff (table editor); MongoDB schema inference (sampling, type unions, frequency).                                                                                |                                                                                                           |
| `metadata-engine`    | Normalised explorer tree model from provider metadata, with lazy children and a bounded cache.                                                                                            |                                                                                                           |
| `file-engine`        | Chunk reader, line/byte index, sparse checkpoint index, on-disk index cache, path validation, memory-bounded buffer pool.                                                                 | The only module that opens user files.                                                                    |
| `streaming-engine`   | Bounded queues with backpressure, async-iterable pipelines, spill-to-disk buffer, row-page store.                                                                                         | Used by file, query, import and export.                                                                   |
| `result-engine`      | Result set model, page cache (LRU, byte-budgeted), column typing, cell truncation, value formatting.                                                                                      | Backs the virtualised grid.                                                                               |
| `export-engine`      | Streaming writers: CSV, TSV, JSON, JSONL, SQL INSERT dumps, Extended JSON.                                                                                                                | Write side of the file pipeline.                                                                          |
| `import-engine`      | Streaming readers → batched writes, error policy (abort, skip, log), resumable progress.                                                                                                  |                                                                                                           |
| `editor-core`        | Piece-table over a virtual document, selection, undo, find/replace model, incremental tokenizer interface, viewport model. No DOM.                                                        | See section 6.5.                                                                                          |
| `workspace-engine`   | Add-on state: saved queries, scripts folders, open editor tabs, unsaved-buffer journal. Stored beside, not inside, the HTTP workspace schema.                                             | Reuses `storage` `KeyValueStore`.                                                                         |
| `db-security`        | TLS option validation, path-policy, statement classification for read-only guard, history redaction.                                                                                      | Builds on `shared` `redact`; credential storage itself stays the existing main-process `CredentialStore`. |
| `db-logging`         | Structured, redacting, size-rotated local logs and diagnostics bundle.                                                                                                                    | Local only (section 8).                                                                                   |
| `db-workers`         | Worker protocol (typed messages), supervisor, memory limits, crash policy, job registry.                                                                                                  | Runs in utility processes and worker threads.                                                             |
| `db-ui`              | React views: explorer, SQL editor, document editor, virtual grid, tree/JSON view, builders. Tailwind kit only, 4-space indent.                                                            | Lazy-loaded.                                                                                              |

`credential-store` and `telemetry` from the brief are deliberately **not** new packages. A credential store already exists and is audited; a second one would be a second place for secrets to leak. Telemetry is replaced by local diagnostics: no network reporting is added.

## 4. Process and thread architecture

Isolation boundary = **OS process** for anything that can crash, hang or exhaust memory on untrusted input; **worker thread** for CPU work inside such a process.

```text
Renderer (sandboxed)             one per window; UI only
   │  preload bridge (named operations), control plane
   ▼
Main process                      auth sender, own worker lifecycle
   │  utilityProcess.fork + MessageChannelMain
   ├──► DB Host utility process   providers, connection pools, query execution, cursors
   │        └─ worker_threads:    BSON/row decoding, import/export transforms
   ├──► File Host utility process file index, chunk reads, incremental parse, search
   │        └─ worker_threads:    N search workers (one per CPU-1, capped), index builders
   └──► (renderer ⇄ host data plane: a MessagePort handed over by main; bulk data never transits main)
```

- **Why utility processes, not just worker threads.** A worker thread shares the process heap: an out-of-memory in a parser would take the main process with it. A utility process crashing cannot. `--max-old-space-size` and `resourceLimits` set per host; main restarts a crashed host and tells the UI which jobs failed.
- **Two hosts, not one.** The File Host handles hostile, large files and is expected to die occasionally; the DB Host holds live connections and transactions. A malformed 3 GB JSON cannot kill an open transaction.
- **Control plane vs data plane.** Control messages (open, cancel, list) go renderer → preload → main (validated) → host. For bulk data, main creates a `MessageChannelMain` pair once per (window, host) and hands one port to the renderer and one to the host; rows, file ranges and search hits flow directly. The renderer therefore still has no Node access, and main is never a copy bottleneck. Ports are bound to the creating `webContents` id and closed when it is destroyed, the same rule `services.ts` applies to sockets today.
- **Job model.** Everything long-running is a `Job { id, kind, state, progress, cancel() }` that emits events (observer pattern): `queued → running → (paused) → done | failed | cancelled`. The UI subscribes by job id; cancellation is cooperative with a hard-kill fallback after a grace period.
- **Backpressure everywhere.** Host → renderer ports use credit-based flow control: the renderer grants N pages of credit; the host stops pulling from the database cursor (or file) when credit is exhausted. This is what keeps a `SELECT *` on a billion rows bounded.
- **Message protocol.** Versioned, JSON control messages plus transferable `ArrayBuffer`s for payloads. Every inbound message is validated by the receiver; unknown fields are dropped (matching the existing `parseSshProfile` approach).

## 5. Provider interfaces

Contracts live in `db-core`. The brief's single flat list is split into **capability interfaces**, so MongoDB never has to implement or stub `getProcedures`. A provider declares which capabilities it has; the UI and services query `provider.capabilities` and use `asRelational(p)` / `asDocument(p)` type guards. No code branches on the engine id.

```ts
interface DatabaseProvider {
    readonly id: string; // 'mysql' | 'postgresql' | 'mongodb' | third-party later
    readonly displayName: string;
    readonly capabilities: ReadonlySet<Capability>; // 'sql', 'documents', 'explain', 'transactions', 'procedures', ...
    createConnector(config: ConnectionConfig): Connector; // factory; no I/O
}

interface Connector {
    connect(signal: AbortSignal): Promise<Session>;
    testConnection(signal: AbortSignal): Promise<TestResult>; // connects, checks version/permissions, disconnects
}

interface Session extends AsyncDisposable {
    readonly info: ServerInfo; // version, auth user, TLS state
    disconnect(): Promise<void>;
    cancel(opId: OperationId): Promise<void>; // out-of-band: PG cancel request, MySQL KILL QUERY, Mongo killOp
    getMetadata(path?: MetadataPath): Promise<MetadataNode[]>; // generic explorer tree, lazy
    getPermissions(): Promise<PermissionSet>; // drives "database permission awareness"
}

// Relational capability (MySQL, PostgreSQL)
interface RelationalSession extends Session {
    execute(sql: string, opts: ExecuteOptions): ResultStream; // one statement, streaming
    executeScript(source: StatementSource, opts: ScriptOptions): ScriptRun; // iterates a statement index lazily
    explain(sql: string, opts: ExplainOptions): Promise<ExplainPlan>;
    begin(): Promise<void>;
    commit(): Promise<void>;
    rollback(): Promise<void>;
    getDatabases(): Promise<DatabaseInfo[]>;
    getSchemas(db?: string): Promise<SchemaInfo[]>;
    getTables(ref: SchemaRef): Promise<TableInfo[]>;
    getViews(ref: SchemaRef): Promise<ViewInfo[]>;
    getColumns(ref: TableRef): Promise<ColumnInfo[]>;
    getIndexes(ref: TableRef): Promise<IndexInfo[]>;
    getConstraints(ref: TableRef): Promise<ConstraintInfo[]>;
    getRoutines(ref: SchemaRef): Promise<RoutineInfo[]>; // procedures + functions, kind-tagged
    // optional, capability-gated: getTriggers, getEvents (MySQL), getSequences, getExtensions,
    // getMaterializedViews (PostgreSQL), getSessions / killSession, getServerStatus
}

// Document capability (MongoDB)
interface DocumentSession extends Session {
    listDatabases(): Promise<DocDatabaseInfo[]>;
    listCollections(db: string): Promise<CollectionInfo[]>;
    find(ref: CollectionRef, q: FindQuery, opts: CursorOptions): DocumentStream; // streaming cursor
    aggregate(ref: CollectionRef, pipeline: Stage[], opts: CursorOptions): DocumentStream;
    insertMany(
        ref: CollectionRef,
        docs: AsyncIterable<Doc>,
        opts: WriteOptions,
    ): Promise<WriteSummary>;
    replaceOne(ref: CollectionRef, filter: Filter, doc: Doc): Promise<WriteSummary>;
    deleteMany(ref: CollectionRef, filter: Filter): Promise<WriteSummary>;
    listIndexes(ref: CollectionRef): Promise<DocIndexInfo[]>;
    createIndex(ref: CollectionRef, spec: IndexSpec): Promise<void>;
    dropIndex(ref: CollectionRef, name: string): Promise<void>;
    explain(ref: CollectionRef, q: FindQuery | Stage[]): Promise<ExplainPlan>;
    stats(ref: CollectionRef): Promise<CollectionStats>;
    inferSchema(ref: CollectionRef, sample: SampleOptions): Promise<InferredSchema>; // delegates to schema-engine
}

// Shared streaming primitives (db-core + streaming-engine)
interface ResultStream extends AsyncIterable<ResultPage> {
    readonly columns: Promise<ColumnMeta[]>; // multiple result sets: stream yields ResultSetStart/Page/End events
    cancel(): void;
    readonly stats: ResultStats; // rows, bytes, elapsed
}

// Import / export: provider-neutral, stream-based, provider only supplies the sink/source
interface ImportSink {
    write(batch: Batch): Promise<void>;
    commit(): Promise<void>;
    abort(): Promise<void>;
}
interface ExportSource {
    open(opts: ExportOptions): AsyncIterable<Batch>;
}
```

The brief's `streamResults`, `importData` and `exportData` become `ResultStream`, `ImportSink` and `ExportSource`, so import/export logic lives once in `import-engine`/`export-engine` and each provider only adapts its own bulk path (`COPY ... FROM STDIN` for PostgreSQL, multi-row `INSERT` batches for MySQL, ordered/unordered `insert` batches for MongoDB).

**Patterns:** `ProviderRegistry` (factory) is where engines register; `ExecuteStatement`, `ExecuteScript` and `Explain` are command objects with their own cancellation and history record; the connection pool is a strategy over `Connector`; explorer node renderers are per-provider strategies keyed by `MetadataNode.kind`; `HistoryRepository` is the repository for query history. Adding a fourth engine means: a protocol package (or reusing one), an engine package registering a provider, and a metadata renderer; nothing in `db-core`, `query-engine` or `db-ui` is edited.

## 6. Large-file strategy (3 GB and up)

### 6.1 Memory budget

| Component                        | Budget                                                                                  |
| -------------------------------- | --------------------------------------------------------------------------------------- |
| Chunk reader window              | 1 MiB chunks, at most 4 in flight per file                                              |
| Open-file read cache (hot pages) | 64 MiB per host, LRU                                                                    |
| Statement/document index         | ≤ 24 bytes per entry in typed arrays (~270 MB at 10 M entries, so it is paged; see 6.2) |
| Line checkpoint index            | 1 checkpoint per 4,096 lines (8 bytes/line-block): ~16 MB for 8 M lines                 |
| Result page cache                | 128 MiB total, 1,000-row pages, byte-counted                                            |
| Search worker                    | ≤ 16 MiB each, plus the match list (capped, spills to disk)                             |
| Renderer                         | Visible rows + two buffer pages; cell text truncated at 64 KiB with "load full"         |

Budgets are constants in one config module and are asserted by the benchmarks (section 7), not just documented.

### 6.2 `file-engine` and the index

Files are read with `fs.read` into reusable `Buffer`s from a bounded pool (never `readFile`, never `.text()`). Memory-mapped I/O is **not** used: Node has no portable mmap without a native addon (a dependency we are avoiding), and positioned `read()` plus our own page cache gives the same random-access behaviour deterministically on all three OSes.

Opening a file starts a **background index build** in the File Host:

```text
File → chunk reader → boundary scanner (SQL | JSON | lines) → index writer
        (bounded, backpressured)                              (typed-array pages, spilled to an on-disk
                                                               sidecar in userData/db-index/<hash>.idx)
```

- The index is **sparse**: line index = one checkpoint per 4,096 lines (byte offset); a line lookup seeks to the nearest checkpoint and scans < 4,096 lines. Statement and document indexes store `(start, end)` as `Float64` pairs (safe to 2^53 bytes) in fixed-size pages that are written to the sidecar and loaded on demand.
- The sidecar is keyed by path + size + mtime + a head/tail sample hash, so an unchanged file reopens instantly and a changed one rebuilds. Sidecars are bounded (LRU eviction, default 2 GiB total, user-configurable) and deletable from settings.
- The file is usable **before** indexing finishes: the viewer works on whatever prefix is indexed, shows progress, and "go to line N" beyond the indexed region waits for or reports progress rather than blocking.
- Editing a large file never rewrites it in place: edits live in a **piece table** over the original file (`editor-core`) plus an append-only add-buffer on disk (the unsaved-state journal). Save streams original pieces and added pieces into a temp file and atomically renames it; peak memory is one chunk.
- Encodings: UTF-8 (with BOM handling) and UTF-16 detected from the first chunk; others are refused with a clear message in v1. Chunk boundaries never split a UTF-8 sequence (the reader carries partial bytes over).

### 6.3 Incremental SQL (`sql-parser`)

- A **state-machine scanner**, not a parser: it consumes a chunk at a time, carrying state across chunk boundaries (`inLineComment`, `inBlockComment` with nesting for PostgreSQL, `inSingleQuote`, `inDoubleQuote`, `inBacktick`, PostgreSQL `$tag$ … $tag$` dollar quotes, MySQL `DELIMITER` directives, `BEGIN … END` depth for stored program bodies, E-strings and `''` / `\'` escape rules per dialect).
- Output is the **statement offset index**: `{ start, end, firstTokenKind, flags }`. `firstTokenKind` is a cheap classification (SELECT/INSERT/UPDATE/DELETE/CREATE/ALTER/DROP/TRUNCATE/transaction/…), stored so "execute the next 10,000 INSERTs" or the read-only guard never needs a re-parse.
- A **lazy statement parser** tokenises and classifies one statement on demand (for execution, explain, the guard, outline). There is never a whole-file AST.
- Executing a script walks the index and streams statement text from disk one statement at a time (bounded: a single statement larger than a configured limit, default 64 MiB, is refused with an explanation rather than buffered). Execution can start while the index is still building.
- Fuzz and property tests: any chunking of the same input must produce an identical index (chunk size 1 byte included).

### 6.4 Incremental JSON (`document-engine`)

- JSONL/NDJSON: line framing is the document index; no JSON parsing needed to index.
- JSON array: a byte-level scanner tracks string/escape state and bracket depth across chunks, emitting `(start, end)` for each top-level element. It validates structure only to the extent needed to find boundaries; a malformed region marks an `Error` entry with its offset and **scanning resynchronises** at the next plausible boundary instead of aborting, so one bad document does not stop navigation of the other 10 million.
- A single document that is itself huge (e.g. a 500 MB value) is handled by a depth-limited lazy tree: the viewer gets container offsets and loads children on expand; scalar values over the cell limit are shown truncated.
- Parsing a document into values (`JSON.parse` on that slice only, or an Extended JSON-aware decoder) happens lazily for visible/selected documents, with a size cap. Whole-file `JSON.parse` is banned by the guard in 6.7.
- MongoDB Extended JSON (`$oid`, `$date`, `$numberLong`, …) is decoded to `DbValue` by the same decoder `db-protocol-mongo` uses for BSON, so imported and fetched documents behave identically.

### 6.5 Virtual editor (`editor-core` + `db-ui`)

- The model is a **virtual document**: `lineCount` (from the index), `getLines(from, to)` (reads the byte range, decodes, caches the page), plus the piece table for edits. Memory is independent of file size.
- The view renders **visible lines ± buffer** (≈150–300 DOM lines) inside a fixed-height scroll container. The browser cannot scroll a 3 GB document's true height (element height limits ≈ 33 M px), so the scrollbar is **virtual**: scroll position maps to a line number by ratio, and the DOM is repositioned relative to the viewport. This is the standard technique for giant documents and is the one part of the UI that must be custom.
- **Monaco stays for normal use.** The app already ships Monaco. Files below a threshold (default 8 MiB) and every ordinary query tab use it. Above the threshold the tab switches to the virtual viewer/editor, which uses the incremental tokenizer for the visible region only. Trying to feed Monaco a windowed model would break line numbers, find, undo and selection semantics, so we do not.
- Syntax highlighting: each tokenizer keeps a state snapshot every N lines (N = 256); on scroll it resumes from the nearest snapshot above the viewport and tokenises only the visible region, cached per page. A tokenizer is a pure function `(line, stateIn) → (tokens, stateOut)` and is language-data driven (SQL dialects, JSON).
- Supported: line numbers, go-to-line, selection and copy (selection is stored as offsets and may exceed what is rendered; copying an unrendered selection streams from the document), find/replace, run selection / current statement (via the statement index), multiple tabs, and an unsaved-state journal so a crash does not lose edits.

### 6.6 Search

A `SearchJob` runs in the File Host over file chunks in **overlapping windows** (overlap = pattern length − 1, so a match straddling a boundary is found exactly once). It emits `SearchHit { offset, line?, preview }` batches progressively, every ~100 ms or 500 hits, over the job's port. Modes: plain, case-sensitive/insensitive, whole word, regex. Regex uses the JS engine with an **execution-time budget per chunk** (a slice that exceeds it fails the job with "pattern too expensive") to defuse catastrophic backtracking; very large files are split among search workers by byte range. Document search adds property-path queries (`address.city = "X"`) evaluated against lazily parsed documents. Hit lists are capped in memory and spill to disk; the UI pages through them. Search is always cancellable.

### 6.7 Guard rails

- `no-restricted-syntax`/`no-restricted-properties` ESLint rules ban `readFile`, `readFileSync`, `fs.promises.readFile`, `Blob.text()`, `Response.json()` and `JSON.parse` on file data inside the add-on's packages. The only allowed `fs` surface is `file-engine`.
- Tests open a sparse 3 GB fixture with a mock `read` and assert that no read exceeds the chunk size and that resident memory growth stays within the budget.

### 6.8 Query results

`ResultStream` pages (1,000 rows by default, adaptive by byte size) flow over the job's port under credit-based backpressure into `result-engine`'s page cache. The grid is a virtual grid (rows and columns windowed), and scrolling far beyond the cache re-requests by page: for a streaming cursor that means "spool to a disk-backed buffer as it arrives" so random scrolling works without re-running the query. The spool is capped (default 2 GiB) and removed on tab close; past the cap the grid becomes forward-only with a clear banner. Wide cells are truncated at the protocol level where the protocol permits, and fetched in full on demand.

## 7. Performance targets and benchmarks

Targets are initial, stated so they can be measured and revised from data. Reference machine: 4 cores, 16 GB RAM, NVMe SSD.

| Scenario                                    | Target                                                                                           |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| App startup with the add-on installed       | No added main-process work until the add-on view is first opened; < 100 ms of startup cost added |
| Open any file (first screen visible)        | < 500 ms regardless of size (index builds in background)                                         |
| Index throughput                            | ≥ 300 MB/s for JSONL line index; ≥ 100 MB/s for SQL statement index                              |
| Memory while indexing/searching a 3 GB file | Host RSS growth ≤ 400 MB (excluding the page cache cap)                                          |
| Go-to-line (indexed region)                 | < 50 ms                                                                                          |
| Scroll                                      | 60 fps; any viewport fetch < 16 ms from cache, < 50 ms from disk                                 |
| First search hit on 3 GB                    | < 1 s; full plain-text scan ≥ 500 MB/s                                                           |
| Result grid memory                          | Bounded by cache cap (128 MiB) independent of row count                                          |
| Cancel                                      | UI reflects cancellation < 200 ms; server-side cancel issued immediately                         |
| UI responsiveness during any job            | Main thread long tasks < 50 ms (asserted via PerformanceObserver in tests)                       |

Benchmark suite (`bench/db-studio/`, run by `npm run bench:db`, not by `npm test`): generated fixtures at **100 MB, 500 MB, 1 GB, 2 GB, 3 GB**, produced deterministically by a streaming generator (never committed; cached in the scratchpad) for SQL (mixed DDL/DML, procedures with `DELIMITER`, dollar-quoted bodies), JSON array, JSONL and CSV/TSV. Scenarios: open-to-first-screen, full index time and peak RSS, go-to-line (random and worst-case), search (plain, case, regex, document-property), SQL execution against a local MySQL and PostgreSQL in containers, JSON document navigation, import (file → each engine) and export (each engine → file). CI runs the 100 MB and 500 MB tiers on every PR with regression thresholds; the 1–3 GB tiers run on a nightly job.

## 8. Security

- **Restricted IPC.** Same pattern as `services.ts`: fixed named operations, sender verification, payloads re-validated by shared validators, unknown fields dropped, no raw `fs`/`child_process`/`ipcRenderer` in the renderer, `IpcResult` envelopes instead of throwing.
- **File paths.** The renderer never supplies a path string to open: it gets a file **handle token** from a native open dialog in main (or a drag-drop confirmed by main). Output paths come from native save dialogs. `file-engine` additionally rejects device files, UNC/`\\?\` oddities, and symlink escapes where a directory scope applies.
- **Credentials.** Passwords, SSH passphrases and tokens are stored via the existing `safeStorage`-backed `CredentialStore` (Windows DPAPI, macOS Keychain, Linux Secret Service/kwallet); a `ConnectionProfile` holds only an opaque `credentialId`. If the OS provides no encryption, saving fails; there is no plaintext fallback. The renderer can write or check a secret and never read it. Passwords are masked in all UI and never reach logs or history.
- **TLS.** Verification on by default using the OS trust store; custom CA and client cert/key supported; hostname verification on; "skip verification" is a per-connection, loudly-labelled, non-default option, and never inherited from a profile import. TLS 1.2 minimum. Wire protocols perform the engine-specific TLS upgrade (PG `SSLRequest`, MySQL capability flag) before sending any credentials.
- **SSH.** Reuses the existing tunnel + known-hosts implementation; the engine connects to a local ephemeral tunnel port. Host-key rules (never silently accept a changed key) stay exactly as today.
- **Logs and history.** `db-logging` runs everything through `redact` plus SQL-aware literal masking; query history stores statements, but is opt-out/clearable, scoped per connection, excludes statements containing detected secrets (`IDENTIFIED BY`, `PASSWORD '…'`, connection URIs), and is stored via the same repository abstraction as the workspace.
- **Input validation.** Identifier quoting is done by provider-owned `quoteIdent`/`quoteLiteral`; the app never builds SQL for the explorer or table editor by string-concatenating unquoted names. A **read-only mode** per connection uses the statement classifier plus a server-side read-only transaction where the engine supports it (defence in depth: the classifier is not a security boundary alone).
- **Permission awareness.** On connect, `getPermissions()` is read; the UI disables actions the account cannot perform and explains why, and destructive statements (DROP/TRUNCATE/unfiltered DELETE/UPDATE) require confirmation, configurable per connection.
- **Failure isolation.** Section 4: host processes are supervised; the renderer and main survive any host crash; jobs report `failed` with a diagnostic, not a white screen.
- **No network telemetry.** Diagnostics bundles are generated locally and sent by the user if they choose.

## 9. Dependency ledger

The brief requires each unavoidable dependency to be justified. Current proposal: **zero new runtime dependencies for the add-on core.**

| Need                                     | Decision                                                                | Why not a package                                                                                                                                                                             |
| ---------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PG / MySQL / Mongo wire protocols        | **Implement in-house** (`db-protocol-*`)                                | Protocols are public and stable; implementing the subset we need (see risk below) removes the largest transitive trees (`pg`, `mysql2`, `mongodb`+`bson`+`mongodb-connection-string-url`...). |
| SCRAM, hashing, TLS                      | `node:crypto`, `node:tls` (platform built-ins)                          | Built-in; not a dependency.                                                                                                                                                                   |
| Compression (zstd/snappy for Mongo wire) | Skipped in v1; `node:zlib` (zlib) only                                  | Avoids native addons.                                                                                                                                                                         |
| SSH tunnelling                           | Existing `ssh2` (already a dependency of this app)                      | Implementing SSH is impractical and a security hazard. Already isolated behind the tunnel module; replaceable behind that interface.                                                          |
| Code editor                              | Existing `monaco-editor` (already a dependency) for normal-size content | Not new. The giant-file viewer is custom (no editor library supports 3 GB).                                                                                                                   |
| Worker isolation                         | Electron `utilityProcess`, `node:worker_threads`                        | Built-in.                                                                                                                                                                                     |
| Test containers for integration tests    | **Dev-only**, via plain `docker` CLI invoked from scripts               | No library; dev-time only; not shipped.                                                                                                                                                       |

**Honest risk of the in-house drivers.** Wire protocols are tractable but the long tail is real: MySQL has several auth plugins and version quirks (8.x `caching_sha2_password` full-auth over TLS or RSA, MariaDB differences); PostgreSQL has SCRAM channel binding, `COPY` framing and a large type OID catalogue (arrays, ranges, composites); MongoDB has topology discovery (replica sets, SRV, `mongodb+srv`), retryable writes and sessions. The plan scopes v1 deliberately: single-host and replica-set seed-list for Mongo (SRV via `node:dns`), no Kerberos/LDAP/IAM auth plugins in v1 (documented as unsupported), text/binary protocol subsets only, and every supported server version listed and tested in CI. If a gap is critical (e.g., enterprise auth), the isolating `Connector` interface allows a single, documented, replaceable driver adapter for that case; adding one is a recorded decision, not a default.

## 10. Licensing and distribution

Decision: the add-on ships in this repository under the project's existing `GPL-3.0-only` licence, with **no entitlement or subscription gating** for now. It is available to every user, and the same source-file header (`Copyright (c) 2026 Yamatri Reddy` + SPDX) applies.

- **Capability, not a build flag.** `PlatformCapabilities` gets `databaseStudio`, derived from what the preload actually exposes, like the existing flags. The rail entry is hidden or disabled on the browser build where it cannot work.
- **Monetisation is deferred.** It will be revisited once there is download traction. Because the add-on is isolated behind one lazy-loaded entry point and one capability flag, a gate (per-feature flags with a signed, offline-verifiable token, a separate plug-in, or dual licensing) can be added later without restructuring. None of that is built now, and no licensing network call exists.
- Note for the future: under GPL a client-side check can be removed from a modified copy, so any later gate would be a licence-compliance mechanism, not a technical lock.

## 11. Phased implementation plan

Each phase ends with the app fully working and tests green.

| Phase | Deliverable                                                                                                                                                                                                       | Exit criteria                                                                                   |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 0     | This document accepted; package skeletons, boundary lint rules, `databaseStudio` capability and rail entry, `db-workers` supervisor with crash-restart tests                                                      | Existing test suite unchanged; add-on loads lazily; worker crash test passes                    |
| 1     | `streaming-engine`, `file-engine` (chunk reader, sparse index, sidecar cache, path/handle tokens), benchmark generator + harness                                                                                  | 3 GB fixture opens and scans within memory budget, enforced in CI (100/500 MB tiers)            |
| 2     | `sql-parser` + `document-engine` scanners with chunk-invariance fuzz tests; File Host utility process; search jobs with progressive results                                                                       | Index matches reference on all fixtures; first-hit and throughput targets met                   |
| 3     | `editor-core` + virtual viewer in `db-ui` (virtual scrollbar, incremental highlight, go-to-line, find, tabs, unsaved journal); read-only first, then piece-table editing                                          | 60 fps scroll on 3 GB; edit-and-save round-trip preserves bytes                                 |
| 4     | `db-protocol-pg` + `postgresql-engine` + `connection-manager` (secure credentials, TLS, SSH, pool, reconnect) + DB Host; explorer; query execution with cancel/timeouts                                           | Integration suite green against supported PG versions; cancel verified server-side              |
| 5     | `result-engine` + virtual grid with spool and backpressure; query history; explain; transactions; script execution from the statement index                                                                       | Billion-row `SELECT` keeps memory flat; 3 GB `.sql` executes with progress and cancel           |
| 6     | `db-protocol-mysql` + `mysql-engine` (events, triggers, processlist, status)                                                                                                                                      | Same suites as phase 4–5 pass against MySQL and MariaDB                                         |
| 7     | `db-protocol-mongo` (BSON, OP_MSG, SCRAM) + `mongodb-engine`; document editor, tree/JSON views, aggregation/query builders, index management, schema inference, explain                                           | Document suite green; 3 GB JSONL navigable                                                      |
| 8     | `import-engine` / `export-engine` for all formats and engines, resumable and cancellable; table structure editor (`schema-engine`)                                                                                | Import/export benchmarks at all tiers; round-trip tests                                         |
| 9     | Hardening: threat-model review, fuzzing of all wire decoders and scanners, log-redaction audit, diagnostics bundle, accessibility pass, docs, packaging (`electron-builder` file lists, `verify-packages` checks) | Security checklist signed off; packaged builds for Windows, macOS (x64 + arm64), Linux verified |

Phases 1–3 are file tooling that is useful without any database connection, and they de-risk the hardest requirement before the driver work starts.

## 12. Open decisions

1. ~~Licensing model~~ decided: GPL in this repo, no gating for now (section 10).
2. **In-house drivers vs one vetted driver per engine** (section 9): the proposal is in-house; the cost is a longer phase 4/6/7 and ongoing protocol maintenance.
3. **Minimum supported server versions** (proposed: MySQL 8.0+, MariaDB 10.6+, PostgreSQL 13+, MongoDB 6.0+).
4. **Large-file editing**: read-only viewer first (phase 3a) vs full editing in the first release (3b is the riskier half).
5. **Scope of auth in v1**: password/SCRAM/TLS-client-cert only (proposed) vs enterprise auth (Kerberos, IAM, LDAP).
