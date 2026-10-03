/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { DbError, toDbError, type RelationalSession, type TaskContext } from '@httpreq/db-core';
import {
    categoryOfType,
    formatNode,
    fromDbValue,
    parseDocument,
    type ObjectName,
    type SqlDialect,
    type SqlValue,
} from '@httpreq/db-admin';
import { decodeDocument, type BsonDocument } from '@httpreq/db-protocol-mongo';
import { detectJsonFormat } from '@httpreq/document-engine';
import type { ChunkReader, FileSink } from '@httpreq/file-engine';
import { BoundedQueue } from '@httpreq/streaming-engine';
import { CsvParser, detectDelimiter } from './csv';
import { JsonDocumentStream } from './jsonStream';

/**
 * Imports a file into a table or a collection as a pipeline:
 *
 *     file → read chunks → incremental parser → bounded queue → batch writer → database
 *
 * Each stage waits for the next: the reader does not read ahead of the parser, and the parser
 * cannot fill the queue past its byte limit, so a 10 GB file moves through a few megabytes. Rows are
 * written in batches (one INSERT with many rows, or one insertMany), in a transaction per batch or
 * for the whole import if asked. A bad record never costs more than itself unless the import was
 * told to stop: a failed batch is rolled back and retried a row at a time to find the rows that
 * fail, which are reported with their record number and line and optionally saved to a file.
 */
export type ImportFormat = 'csv' | 'json' | 'ndjson' | 'bson';

export type ImportTarget =
    | {
          kind: 'table';
          dialect: SqlDialect;
          table: ObjectName;
          columns: { name: string; type: string }[];
      }
    | { kind: 'collection'; database?: string; collection: string };

export interface ImportCheckpoint {
    /** Offset of the first byte not yet imported. */
    byteOffset: number;
    /** Number and line of the next record. */
    record: number;
    line: number;
    /** The CSV header, which a resumed run cannot read again. */
    header?: string[];
}

export interface ImportRunOptions {
    session: RelationalSession;
    reader: ChunkReader;
    format: ImportFormat;
    target: ImportTarget;
    context: TaskContext;
    /** `truncate` empties the table or collection first. */
    mode?: 'append' | 'truncate';
    batchSize?: number;
    onError?: 'stop' | 'skip';
    /** Per batch, for the whole import, or none (each statement on its own). */
    transaction?: 'none' | 'batch' | 'all';
    csv?: {
        delimiter?: string;
        header?: boolean;
        /** File column name to table column name. */
        columnMap?: Record<string, string>;
        /** Text that means NULL (besides an empty field in a non-text column). */
        nullToken?: string;
        emptyAsNull?: boolean;
    };
    /** Rejected records are written here as NDJSON, one object per record. */
    rejects?: FileSink;
    resume?: ImportCheckpoint;
    /** Most bytes of parsed batches waiting for the writer. */
    queueBytes?: number;
    /** Most bytes of statement text in one batch. */
    batchBytes?: number;
}

export interface ImportResult {
    imported: number;
    rejected: number;
    records: number;
}

interface Item {
    record: number;
    line: number;
    /** A row of values by table column, or a document as shell text. */
    payload: Record<string, SqlValue> | string;
    bytes: number;
    /** Where the input stands after this record. */
    byteEnd: number;
    /** The line the next record starts on. */
    nextLine: number;
}

interface Batch {
    items: Item[];
    bytes: number;
    byteEnd: number;
    nextRecord: number;
    nextLine: number;
}

class Reject extends Error {
    constructor(
        message: string,
        readonly record: number,
        readonly line: number,
        readonly raw: unknown,
    ) {
        super(message);
    }
}

/* ---------- Writers (one per kind of target) ---------- */

interface BatchWriter {
    prepare(mode: 'append' | 'truncate'): Promise<void>;
    write(items: Item[]): Promise<number>;
    begin(): Promise<void>;
    commit(): Promise<void>;
    rollback(): Promise<void>;
}

const drain = async (
    session: RelationalSession,
    statement: string,
    signal: AbortSignal,
): Promise<number> => {
    let affected = 0;
    const execution = session.execute(statement, { signal, timeoutMs: 0 });
    for await (const event of execution) {
        if (event.kind === 'end' && event.affectedRows) affected += event.affectedRows;
    }
    return affected;
};

const tableWriter = (
    session: RelationalSession,
    target: Extract<ImportTarget, { kind: 'table' }>,
    signal: AbortSignal,
): BatchWriter => {
    const { dialect, table } = target;
    const name = dialect.qualify(table);
    return {
        prepare: async (mode) => {
            if (mode === 'truncate') await drain(session, `TRUNCATE TABLE ${name}`, signal);
        },
        write: async (items) => {
            const columns = [
                ...new Set(
                    items.flatMap((i) => Object.keys(i.payload as Record<string, SqlValue>)),
                ),
            ];
            const rows = items.map((item) => {
                const payload = item.payload as Record<string, SqlValue>;
                return `(${columns.map((c) => dialect.literal(payload[c] ?? { kind: 'default' })).join(', ')})`;
            });
            await drain(
                session,
                `INSERT INTO ${name} (${columns.map((c) => dialect.quote(c)).join(', ')}) VALUES\n${rows.join(',\n')}`,
                signal,
            );
            return items.length;
        },
        begin: async () =>
            void (await drain(
                session,
                dialect.id === 'mysql' ? 'START TRANSACTION' : 'BEGIN',
                signal,
            )),
        commit: async () => void (await drain(session, 'COMMIT', signal)),
        rollback: async () =>
            void (await drain(session, 'ROLLBACK', new AbortController().signal).catch(() => 0)),
    };
};

const collectionWriter = (
    session: RelationalSession,
    target: Extract<ImportTarget, { kind: 'collection' }>,
    signal: AbortSignal,
): BatchWriter => {
    const root = target.database ? `db.getSiblingDB(${JSON.stringify(target.database)})` : 'db';
    const collection = `${root}.getCollection(${JSON.stringify(target.collection)})`;
    return {
        prepare: async (mode) => {
            if (mode === 'truncate') await drain(session, `${collection}.deleteMany({})`, signal);
        },
        write: async (items) => {
            await drain(
                session,
                `${collection}.insertMany([${items.map((i) => i.payload as string).join(', ')}], { ordered: false })`,
                signal,
            );
            return items.length;
        },
        // MongoDB's transactions need a replica set; an import is ordered by batch instead.
        begin: async () => undefined,
        commit: async () => undefined,
        rollback: async () => undefined,
    };
};

/* ---------- Converting input records ---------- */

const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/** What a CSV field means for a column of this type. Throws a message the person can act on. */
export const fieldToSqlValue = (
    type: string,
    text: string,
    options: { nullToken?: string; emptyAsNull?: boolean } = {},
): SqlValue => {
    if (options.nullToken !== undefined && text === options.nullToken) return { kind: 'null' };
    const category = categoryOfType(type);
    if (text === '' && (category !== 'text' || options.emptyAsNull)) return { kind: 'null' };
    switch (category) {
        case 'number':
            if (!NUMBER.test(text.trim()))
                throw new Error(`“${text.slice(0, 40)}” is not a number (column type ${type}).`);
            return { kind: 'number', value: text.trim() };
        case 'boolean': {
            const t = text.trim().toLowerCase();
            if (['true', 't', '1', 'yes', 'y'].includes(t)) return { kind: 'boolean', value: true };
            if (['false', 'f', '0', 'no', 'n'].includes(t))
                return { kind: 'boolean', value: false };
            throw new Error(`“${text.slice(0, 40)}” is not true or false.`);
        }
        case 'json':
            try {
                JSON.parse(text);
            } catch {
                throw new Error('The value is not valid JSON.');
            }
            return { kind: 'json', value: text };
        case 'binary': {
            const hex = text.trim().replace(/^0x/i, '');
            if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0)
                throw new Error('A binary value must be hexadecimal digits, two per byte.');
            return { kind: 'binary', hex };
        }
        default:
            return { kind: 'text', value: text };
    }
};

const jsonToSqlValue = (type: string, value: unknown): SqlValue => {
    if (value === null || value === undefined) return { kind: 'null' };
    if (typeof value === 'boolean') return { kind: 'boolean', value };
    if (typeof value === 'number') return { kind: 'number', value: String(value) };
    if (typeof value === 'string')
        return categoryOfType(type) === 'json' ? { kind: 'json', value } : { kind: 'text', value };
    return { kind: 'json', value: JSON.stringify(value) };
};

const approxBytes = (payload: Record<string, SqlValue> | string): number => {
    if (typeof payload === 'string') return payload.length + 2;
    let total = 16;
    for (const value of Object.values(payload)) {
        total +=
            8 +
            ('value' in value && typeof value.value === 'string'
                ? value.value.length
                : 'hex' in value
                  ? value.hex.length
                  : 4);
    }
    return total;
};

/* ---------- The run ---------- */

const MIB = 1024 * 1024;

export const runImport = async (options: ImportRunOptions): Promise<ImportResult> => {
    const { session, reader, target, context, format } = options;
    const signal = context.signal;
    const batchSize = Math.max(1, options.batchSize ?? (target.kind === 'table' ? 500 : 1000));
    const batchBytes = options.batchBytes ?? 4 * MIB;
    const onError = options.onError ?? 'stop';
    const transaction = target.kind === 'collection' ? 'none' : (options.transaction ?? 'batch');
    const writer: BatchWriter =
        target.kind === 'table'
            ? tableWriter(session, target, signal)
            : collectionWriter(session, target, signal);

    if (options.resume && transaction === 'all') {
        throw new DbError(
            'INVALID_REQUEST',
            'An import that runs as one transaction cannot be resumed: it was rolled back.',
        );
    }
    const columnsByName = new Map(
        target.kind === 'table'
            ? target.columns.map((c) => [c.name.toLowerCase(), c] as const)
            : [],
    );

    let imported = 0;
    let rejected = 0;
    let lastRecord = (options.resume?.record ?? 1) - 1;

    const rejectRecord = async (error: Reject) => {
        rejected++;
        context.issue({ record: error.record, line: error.line, message: error.message });
        if (options.rejects) {
            await options.rejects.write(
                `${JSON.stringify({ record: error.record, line: error.line, error: error.message, data: error.raw })}\n`,
            );
        }
        if (onError === 'stop') {
            throw new DbError(
                'INVALID_REQUEST',
                `The import stopped at record ${error.record} (line ${error.line}): ${error.message}`,
            );
        }
    };

    /* ----- the producer: file → records → batches → queue ----- */

    const queue = new BoundedQueue<Batch>(options.queueBytes ?? 8 * MIB);
    const decoder = new TextDecoder('utf-8', { fatal: false });
    let current: Item[] = [];
    let currentBytes = 0;
    let csvHeader: string[] | undefined = options.resume?.header;
    let mapping: { source: number; column: { name: string; type: string } }[] | null = null;
    const pendingRejects: Reject[] = [];

    const flush = async (byteEnd: number, nextRecord: number, nextLine: number) => {
        if (current.length === 0) return;
        const batch: Batch = { items: current, bytes: currentBytes, byteEnd, nextRecord, nextLine };
        current = [];
        currentBytes = 0;
        await queue.push(batch, Math.max(1, batch.bytes), signal);
    };

    let producerPosition = {
        byteEnd: options.resume?.byteOffset ?? 0,
        nextRecord: options.resume?.record ?? 1,
        nextLine: options.resume?.line ?? 1,
    };

    /** Adds a parsed record to the batch being built; batches go to the queue when they are full. */
    const accept = async (item: Item): Promise<void> => {
        current.push(item);
        currentBytes += item.bytes;
        producerPosition = {
            byteEnd: item.byteEnd,
            nextRecord: item.record + 1,
            nextLine: item.nextLine,
        };
        if (current.length >= batchSize || currentBytes >= batchBytes)
            await flush(item.byteEnd, item.record + 1, item.nextLine);
    };

    const produce = async (): Promise<void> => {
        const emit = async (
            record: number,
            line: number,
            byteEnd: number,
            nextLine: number,
            build: () => Item['payload'] | Reject,
        ) => {
            const built = build();
            if (built instanceof Reject) {
                pendingRejects.push(built);
                return;
            }
            await accept({
                record,
                line,
                payload: built,
                bytes: approxBytes(built),
                byteEnd,
                nextLine,
            });
        };
        // A parser's callback cannot await, so the records it produced are handled right after each
        // chunk: the chunk is bounded (one read), so this holds at most a chunk's worth of records.
        const batchOfCallbacks: (() => Promise<void>)[] = [];
        const later = (task: () => Promise<void>) => void batchOfCallbacks.push(task);
        const settle = async () => {
            const tasks = batchOfCallbacks.splice(0);
            for (const task of tasks) await task();
            for (const rejection of pendingRejects.splice(0)) await rejectRecord(rejection);
        };

        let parser: { feed: (chunk: Uint8Array) => void; finish: () => void };
        let readFrom = options.resume?.byteOffset ?? 0;

        if (format === 'csv') {
            const sample = decoder.decode(
                await reader.readRange(
                    readFrom,
                    Math.min(64 * 1024, Math.max(0, reader.size - readFrom)),
                ),
            );
            const delimiter = options.csv?.delimiter ?? detectDelimiter(sample);
            const hasHeader = options.csv?.header !== false && !options.resume;
            // A byte order mark is decoded away, but its three bytes still count toward offsets.
            const bom = readFrom === 0 && (await reader.readRange(0, 3)).join() === '239,187,191';
            const csv = new CsvParser({
                delimiter,
                startByte: options.resume?.byteOffset ?? (bom ? 3 : 0),
                startLine: options.resume?.line,
                startRecord: options.resume?.record,
                onRecord: (fields, info) => {
                    if (hasHeader && info.record === 1) {
                        csvHeader = fields.map((f) => f.trim());
                        return;
                    }
                    later(async () => {
                        await emit(info.record, info.line, info.byteEnd, info.nextLine, () => {
                            if (target.kind !== 'table')
                                return new Reject(
                                    'CSV can only be imported into a table.',
                                    info.record,
                                    info.line,
                                    fields,
                                );
                            // With no header the first record decides how many of the table's columns the file has.
                            csvHeader ??= target.columns.slice(0, fields.length).map((c) => c.name);
                            const names = csvHeader;
                            if (mapping === null) {
                                mapping = [];
                                names.forEach((name, source) => {
                                    const wanted = options.csv?.columnMap?.[name] ?? name;
                                    const column = columnsByName.get(wanted.toLowerCase());
                                    if (column) mapping!.push({ source, column });
                                });
                                if (mapping.length === 0)
                                    throw new DbError(
                                        'INVALID_REQUEST',
                                        'None of the columns in the file match a column of the table. Check the file’s header, or map the columns.',
                                    );
                            }
                            if (fields.length !== names.length)
                                return new Reject(
                                    `Expected ${names.length} fields but found ${fields.length}.`,
                                    info.record,
                                    info.line,
                                    fields,
                                );
                            const row: Record<string, SqlValue> = {};
                            try {
                                for (const { source, column } of mapping) {
                                    row[column.name] = fieldToSqlValue(
                                        column.type,
                                        fields[source]!,
                                        options.csv,
                                    );
                                }
                            } catch (error) {
                                return new Reject(
                                    error instanceof Error ? error.message : String(error),
                                    info.record,
                                    info.line,
                                    fields,
                                );
                            }
                            return row;
                        });
                    });
                },
            });
            parser = {
                feed: (chunk) => csv.feed(decoder.decode(chunk, { stream: true })),
                finish: () => {
                    csv.feed(decoder.decode());
                    csv.finish();
                },
            };
        } else if (format === 'bson') {
            if (target.kind !== 'collection')
                throw new DbError(
                    'INVALID_REQUEST',
                    'BSON can only be imported into a collection.',
                );
            let held = Buffer.alloc(0);
            let record = options.resume?.record ?? 1;
            let consumed = readFrom;
            parser = {
                feed: (chunk) => {
                    held = held.length ? Buffer.concat([held, chunk]) : Buffer.from(chunk);
                    for (;;) {
                        if (held.length < 4) break;
                        const length = held.readInt32LE(0);
                        if (length < 5 || length > 64 * MIB)
                            throw new DbError(
                                'INVALID_REQUEST',
                                `The BSON file is damaged: a document at byte ${consumed} claims ${length} bytes.`,
                            );
                        if (held.length < length) break;
                        const bytes = Buffer.from(held.subarray(0, length));
                        held = held.subarray(length);
                        consumed += length;
                        const number = record++;
                        const end = consumed;
                        later(async () => {
                            await emit(number, number, end, number + 1, () => {
                                try {
                                    return formatNode(
                                        fromDbValue(decodeDocument(bytes) as BsonDocument),
                                        0,
                                        0,
                                    ).replace(/\s*\n\s*/g, ' ');
                                } catch (error) {
                                    return new Reject(
                                        error instanceof Error ? error.message : String(error),
                                        number,
                                        number,
                                        '(binary)',
                                    );
                                }
                            });
                        });
                    }
                },
                finish: () => {
                    if (held.length > 0)
                        throw new DbError(
                            'INVALID_REQUEST',
                            'The BSON file ends in the middle of a document.',
                        );
                },
            };
        } else {
            // JSON array, JSON Lines
            const head = await reader.readRange(0, Math.min(64 * 1024, reader.size));
            const layout = format === 'ndjson' ? 'jsonl' : detectJsonFormat(head);
            const stream = new JsonDocumentStream({
                format: layout,
                startByte: options.resume?.byteOffset,
                startLine: options.resume?.line,
                startIndex: options.resume?.record,
                onDocument: (text, info) =>
                    later(async () => {
                        await emit(info.index, info.line, info.byteEnd, info.line + 1, () => {
                            let value: unknown;
                            if (target.kind === 'collection') {
                                const parsed = parseDocument(text);
                                if (!parsed.ok)
                                    return new Reject(
                                        parsed.error,
                                        info.index,
                                        info.line,
                                        text.slice(0, 200),
                                    );
                                if (parsed.node.t !== 'object')
                                    return new Reject(
                                        'A document must be a JSON object.',
                                        info.index,
                                        info.line,
                                        text.slice(0, 200),
                                    );
                                return formatNode(parsed.node, 0, 0).replace(/\s*\n\s*/g, ' ');
                            }
                            try {
                                value = JSON.parse(text);
                            } catch (error) {
                                return new Reject(
                                    `Not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
                                    info.index,
                                    info.line,
                                    text.slice(0, 200),
                                );
                            }
                            if (!value || typeof value !== 'object' || Array.isArray(value))
                                return new Reject(
                                    'A record must be a JSON object.',
                                    info.index,
                                    info.line,
                                    text.slice(0, 200),
                                );
                            const row: Record<string, SqlValue> = {};
                            for (const [key, field] of Object.entries(value)) {
                                const column = columnsByName.get(key.toLowerCase());
                                if (column) row[column.name] = jsonToSqlValue(column.type, field);
                            }
                            if (Object.keys(row).length === 0)
                                return new Reject(
                                    'None of the fields match a column of the table.',
                                    info.index,
                                    info.line,
                                    text.slice(0, 200),
                                );
                            return row;
                        });
                    }),
            });
            parser = { feed: (chunk) => stream.feed(chunk), finish: () => stream.finish() };
        }

        for await (const chunk of reader.chunks({ start: readFrom, signal })) {
            await context.waitIfPaused();
            parser.feed(chunk.data);
            readFrom = chunk.offset + chunk.data.length;
            await settle();
        }
        parser.finish();
        await settle();
        await flush(
            producerPosition.byteEnd,
            producerPosition.nextRecord,
            producerPosition.nextLine,
        );
        queue.close();
    };

    const producing = produce().catch((error) => queue.fail(error));

    /* ----- the consumer: queue → batches → database ----- */

    const issue = (item: Item, error: unknown) => {
        const info = toDbError(error);
        return new Reject(info.message, item.record, item.line, undefined);
    };

    try {
        context.report({ stage: 'Preparing', totalBytes: reader.size });
        await writer.prepare(options.mode ?? 'append');
        if (transaction === 'all') await writer.begin();
        context.report({ stage: 'Importing' });

        for await (const batch of queue) {
            await context.waitIfPaused();
            if (signal.aborted) throw new DbError('CANCELLED', 'The import was cancelled.');
            let wrote = 0;
            try {
                if (transaction === 'batch') await writer.begin();
                wrote = await writer.write(batch.items);
                if (transaction === 'batch') await writer.commit();
            } catch (error) {
                if (transaction !== 'none' && transaction !== 'all') await writer.rollback();
                if (signal.aborted || toDbError(error).code === 'CANCELLED') throw error;
                if (transaction === 'all' || onError === 'stop') {
                    // Name the first record of the failed batch's range: the server did not say which row.
                    const first = batch.items[0]!;
                    throw new DbError(
                        'QUERY_FAILED',
                        `The import failed in the batch of records ${first.record} to ${batch.items.at(-1)!.record}: ${toDbError(error).message}${
                            transaction === 'all' ? ' Everything was rolled back.' : ''
                        }`,
                        { cause: error },
                    );
                }
                // Find the rows that fail by writing them one at a time; the rest still go in.
                wrote = 0;
                for (const item of batch.items) {
                    try {
                        await writer.write([item]);
                        wrote++;
                    } catch (rowError) {
                        if (signal.aborted || toDbError(rowError).code === 'CANCELLED')
                            throw rowError;
                        const reject = issue(item, rowError);
                        await rejectRecord(
                            new Reject(
                                reject.message,
                                item.record,
                                item.line,
                                typeof item.payload === 'string'
                                    ? item.payload.slice(0, 200)
                                    : item.payload,
                            ),
                        );
                    }
                }
            }
            imported += wrote;
            lastRecord = batch.nextRecord - 1;
            if (transaction !== 'all') {
                context.checkpoint({
                    byteOffset: batch.byteEnd,
                    record: batch.nextRecord,
                    line: batch.nextLine,
                    ...(csvHeader ? { header: csvHeader } : {}),
                } satisfies ImportCheckpoint);
            }
            context.report({ bytesProcessed: batch.byteEnd, rowsProcessed: imported });
        }
        await producing;
        if (transaction === 'all') {
            context.report({ stage: 'Committing' });
            await writer.commit();
        }
        context.report({
            stage: 'Finishing',
            bytesProcessed: reader.size,
            rowsProcessed: imported,
        });
        return { imported, rejected, records: lastRecord };
    } catch (error) {
        queue.fail(error);
        await producing.catch(() => undefined);
        if (transaction === 'all') await writer.rollback();
        const info = toDbError(error);
        if (signal.aborted && info.code !== 'CANCELLED')
            throw new DbError('CANCELLED', 'The import was cancelled.');
        throw info;
    }
};
