/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { createHash, randomBytes } from 'node:crypto';
import {
    DbError,
    STUDIO_BUDGETS,
    toDbError,
    type DbErrorInfo,
    type RangeIndex,
} from '@httpreq/db-core';
import { buildLineIndex, fingerprintFile } from './indexer';
import type { IndexStore } from './indexStore';
import type { IndexView, LineIndex } from './lineIndex';
import {
    describeItem,
    itemKindOf,
    readItemText,
    resolveItemFormat,
    scanItems,
    type ItemFormat,
    type ItemKind,
    type ItemSummary,
} from './items';
import { LineSource, type LineSlice } from './lineSource';
import { assertSafeLocalPath, displayName } from './pathPolicy';
import { ChunkReader } from './reader';
import { replaceInFile } from './replace';
import { searchFile, type SearchHit, type SearchQuery } from './search';
import { openFileSource, statFile, type OpenedFile } from './source';
import { detectLineEnding, writePieces, type LineEnding, type SavePiece } from './writer';

export type FileIndexState = 'indexing' | 'ready' | 'failed' | 'cancelled';

/** Pushed to the UI while a file is indexed. */
export interface FileProgressEvent {
    fileId: string;
    state: FileIndexState;
    bytesRead: number;
    totalBytes: number;
    lines: number;
    error?: DbErrorInfo;
}

export interface FileOpenedResult {
    fileId: string;
    name: string;
    size: number;
    /** The line ending the file uses; added lines are written with it. */
    eol: LineEnding;
    /** Stable for this path, so unsaved work can be matched to the file after a restart. */
    fileKey: string;
    mtimeMs: number;
}

/** A small file's whole text, for the full editor. */
export interface FileTextResult {
    text: string;
    eol: LineEnding;
    /** The file is not valid UTF-8; editing it as text would change those bytes. */
    lossy: boolean;
}

export interface FileSavedResult {
    name: string;
    size: number;
    eol: LineEnding;
    fileKey: string;
    mtimeMs: number;
}

export interface EditProgressEvent {
    fileId: string;
    op: 'save' | 'replace';
    bytes: number;
    totalBytes: number;
}

export interface FileLinesResult {
    lines: LineSlice[];
    /** Lines readable now; the final count once `complete`. */
    lineCount: number;
    complete: boolean;
}

/** What the host needs from whoever serves it (a worker process, or a test). */
export interface FileHostContext {
    emit: (topic: string, payload: unknown) => void;
    signal: AbortSignal;
}

export interface FileHostOptions {
    indexStore?: IndexStore;
    /** Replaces the real file system; tests stand a synthetic file in here. */
    openSource?: (path: unknown) => Promise<OpenedFile>;
    chunkSize?: number;
    progressIntervalMs?: number;
    maxOpenFiles?: number;
}

interface OpenFile {
    reader: ChunkReader;
    lines: LineSource;
    view: () => IndexView;
    abort: AbortController;
    done: Promise<void>;
    name: string;
    realPath: string;
    eol: LineEnding;
    emit: FileHostContext['emit'];
    items?: {
        format: ItemFormat;
        index: RangeIndex;
        complete: boolean;
        abort: AbortController;
        done: Promise<void>;
    };
    searches: Map<string, AbortController>;
}

export type ItemsState = 'scanning' | 'ready' | 'failed' | 'cancelled';

/** Pushed while a file is split into statements or documents. */
export interface ItemsProgressEvent {
    fileId: string;
    state: ItemsState;
    bytesRead: number;
    totalBytes: number;
    count: number;
    error?: DbErrorInfo;
}

export interface ItemsAnalyzed {
    /** `null` when the file is not a kind that is split into items. */
    format: ItemFormat | null;
    kind: ItemKind | null;
}

export interface ItemsListResult {
    items: ItemSummary[];
    count: number;
    complete: boolean;
}

export interface SearchProgressEvent {
    searchId: string;
    fileId: string;
    state: 'running' | 'done' | 'failed' | 'cancelled';
    bytesRead: number;
    totalBytes: number;
    hits: number;
    truncated: boolean;
    error?: DbErrorInfo;
}

export interface SearchHitsEvent {
    searchId: string;
    fileId: string;
    hits: SearchHit[];
}

/** Searches running at once across all files. */
const MAX_SEARCHES = 4;

const integer = (value: unknown, name: string, max = Number.MAX_SAFE_INTEGER): number => {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > max) {
        throw new DbError('INVALID_REQUEST', `${name} must be a non-negative integer.`);
    }
    return value;
};

const parseQuery = (value: unknown): SearchQuery => {
    const query = record(value);
    if (typeof query.text !== 'string') {
        throw new DbError('INVALID_REQUEST', 'The search text is required.');
    }
    return {
        text: query.text,
        caseSensitive: query.caseSensitive === true,
        regex: query.regex === true,
        wholeWord: query.wholeWord === true,
    };
};

/** At most this many pieces and added characters are accepted in one save. */
const MAX_PIECES = 500_000;
const MAX_ADDED_CHARS = 512 * 1024 * 1024;

/** Validates the pieces of a save request; anything malformed is refused before any I/O. */
const parsePieces = (value: unknown, lineCount: number): SavePiece[] => {
    if (!Array.isArray(value) || value.length > MAX_PIECES) {
        throw new DbError('INVALID_REQUEST', 'The document to save is malformed.');
    }
    let characters = 0;
    return value.map((item): SavePiece => {
        const piece = record(item);
        if (piece.kind === 'original') {
            const from = integer(piece.from, 'from');
            const count = integer(piece.count, 'count');
            if (from + count > lineCount) {
                throw new DbError(
                    'INVALID_REQUEST',
                    'The document refers to lines the file does not have.',
                );
            }
            return { kind: 'original', from, count };
        }
        if (piece.kind === 'added' && Array.isArray(piece.lines)) {
            const lines = piece.lines.map((line: unknown) => {
                if (typeof line !== 'string') {
                    throw new DbError('INVALID_REQUEST', 'The document to save is malformed.');
                }
                characters += line.length + 1;
                return line;
            });
            if (characters > MAX_ADDED_CHARS) {
                throw new DbError('LIMIT_EXCEEDED', 'There is too much new text to save at once.');
            }
            return { kind: 'added', lines };
        }
        throw new DbError('INVALID_REQUEST', 'The document to save is malformed.');
    });
};

const record = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== 'object') {
        throw new DbError('INVALID_REQUEST', 'The request is malformed.');
    }
    return value as Record<string, unknown>;
};

/**
 * The service that runs inside the File Host process. It owns every open file, builds and caches
 * their indexes in the background, and answers line-range reads. Nothing here touches the UI, so
 * it is plain Node and testable without Electron.
 *
 * A file is browsable the moment it is opened: the index builds behind it, and reads are limited
 * to what the scan has already passed. A corrupt or hostile file can only fail its own job.
 */
export class FileHostService {
    private readonly files = new Map<string, OpenFile>();
    /** Which file each running search belongs to. */
    private readonly searchOwners = new Map<string, string>();
    private readonly openSource: (path: unknown) => Promise<OpenedFile>;
    private readonly maxOpenFiles: number;

    constructor(private readonly options: FileHostOptions = {}) {
        this.openSource = options.openSource ?? openFileSource;
        this.maxOpenFiles = options.maxOpenFiles ?? STUDIO_BUDGETS.maxOpenFiles;
    }

    get openCount(): number {
        return this.files.size;
    }

    /** The dispatcher a worker server calls with each request. */
    handle = async (op: string, payload: unknown, context: FileHostContext): Promise<unknown> => {
        switch (op) {
            case 'file.open':
                return this.open(record(payload).path, context);
            case 'file.lines': {
                const request = record(payload);
                return this.readLines(
                    request.fileId,
                    integer(request.from, 'from'),
                    integer(request.count, 'count', STUDIO_BUDGETS.maxLinesPerRead),
                    context.signal,
                );
            }
            case 'file.close':
                await this.close(record(payload).fileId);
                return {};
            case 'items.analyze': {
                const request = record(payload);
                return this.analyze(request.fileId, request.format);
            }
            case 'items.list': {
                const request = record(payload);
                return this.listItems(
                    request.fileId,
                    integer(request.from, 'from'),
                    integer(request.count, 'count', 200),
                );
            }
            case 'items.read': {
                const request = record(payload);
                return this.readItem(request.fileId, integer(request.index, 'index'));
            }
            case 'items.at': {
                const request = record(payload);
                return this.itemAt(request.fileId, integer(request.offset, 'offset'));
            }
            case 'search.start': {
                const request = record(payload);
                return this.startSearch(
                    request.fileId,
                    request.query,
                    request.maxHits,
                    request.searchId,
                );
            }
            case 'search.cancel':
                this.cancelSearch(record(payload).searchId);
                return {};
            case 'file.readText':
                return this.readText(record(payload).fileId);
            case 'edit.save': {
                const request = record(payload);
                return this.save(request.fileId, request.pieces, request.eol, request.path);
            }
            case 'edit.replaceAll': {
                const request = record(payload);
                return this.replaceAll(request.fileId, request.query, request.replacement);
            }
            case 'host.stats':
                return { openFiles: this.files.size };
            default:
                throw new DbError('UNSUPPORTED', `Unknown operation “${op}”.`);
        }
    };

    async open(path: unknown, context: Pick<FileHostContext, 'emit'>): Promise<FileOpenedResult> {
        if (this.files.size >= this.maxOpenFiles) {
            throw new DbError('LIMIT_EXCEEDED', 'Too many files are open. Close one first.');
        }
        const opened = await this.openSource(path);
        const fileId = randomBytes(8).toString('hex');
        const file = {
            name: displayName(opened.realPath),
            realPath: opened.realPath,
            eol: '\n' as LineEnding,
            emit: context.emit,
            searches: new Map<string, AbortController>(),
        } as OpenFile;
        this.attach(fileId, file, opened);
        this.files.set(fileId, file);
        file.eol = await detectLineEnding(file.reader).catch(() => '\n' as LineEnding);
        return this.describe(fileId, file);
    }

    private describe(fileId: string, file: OpenFile): FileOpenedResult {
        return {
            fileId,
            name: file.name,
            size: file.reader.size,
            eol: file.eol,
            fileKey: createHash('sha256').update(file.realPath).digest('hex').slice(0, 16),
            mtimeMs: file.reader.mtimeMs,
        };
    }

    /**
     * Binds an opened file to its line index: readers, the line source and the background scan.
     * Used at open and again after a save, which replaces the file under the same id.
     */
    private attach(fileId: string, file: OpenFile, opened: OpenedFile): void {
        const reader = new ChunkReader(opened.source, this.options.chunkSize);
        const abort = new AbortController();
        let view: () => IndexView = () => ({
            interval: STUDIO_BUDGETS.lineCheckpointInterval,
            checkpoints: new Float64Array([0]),
            lineCount: 0,
            terminatedLines: 0,
            scannedBytes: 0,
            complete: false,
            byteLength: reader.size,
        });
        file.reader = reader;
        file.lines = new LineSource(reader, () => view());
        file.view = () => view();
        file.abort = abort;
        file.realPath = opened.realPath;
        file.name = displayName(opened.realPath);

        const emitProgress = (
            state: FileIndexState,
            bytesRead: number,
            lines: number,
            error?: DbErrorInfo,
        ) =>
            file.emit('file.progress', {
                fileId,
                state,
                bytesRead,
                totalBytes: reader.size,
                lines,
                ...(error ? { error } : {}),
            } satisfies FileProgressEvent);

        file.done = (async () => {
            try {
                const fingerprint = await fingerprintFile(reader);
                const cached = await this.options.indexStore?.load(opened.realPath, fingerprint);
                if (cached) {
                    view = () => cached;
                    emitProgress('ready', reader.size, cached.lineCount);
                    return;
                }
                const index: LineIndex = await buildLineIndex(reader, {
                    signal: abort.signal,
                    chunkSize: this.options.chunkSize,
                    progressIntervalMs: this.options.progressIntervalMs,
                    onStart: (partial) => (view = partial),
                    onProgress: (p) => emitProgress('indexing', p.bytesRead, p.lines),
                });
                view = () => index;
                emitProgress('ready', reader.size, index.lineCount);
                // A cache failure (full disk, read-only profile) must not fail the open.
                await this.options.indexStore
                    ?.save(opened.realPath, fingerprint, index)
                    .catch(() => undefined);
                await this.options.indexStore?.prune().catch(() => undefined);
            } catch (error) {
                const info = toDbError(error).toInfo();
                emitProgress(
                    info.code === 'CANCELLED' ? 'cancelled' : 'failed',
                    0,
                    file.view().lineCount,
                    info,
                );
            }
        })();
    }

    /** Stops everything running against a file's current content and releases its handle. */
    private async detach(file: OpenFile): Promise<void> {
        file.abort.abort();
        file.items?.abort.abort();
        for (const [searchId, controller] of file.searches) {
            controller.abort();
            this.searchOwners.delete(searchId);
        }
        file.searches.clear();
        await file.done;
        await file.items?.done;
        file.items = undefined;
        await file.reader.close().catch(() => undefined);
    }

    /** Re-opens a file after it was rewritten on disk; the id stays, the content is the new one. */
    private async reload(fileId: string, file: OpenFile, path: string): Promise<void> {
        await this.detach(file);
        const opened = await this.openSource(path);
        this.attach(fileId, file, opened);
        file.eol = await detectLineEnding(file.reader).catch(() => file.eol);
    }

    async readLines(
        fileId: unknown,
        from: number,
        count: number,
        signal?: AbortSignal,
    ): Promise<FileLinesResult> {
        const file = this.require(fileId);
        const lines = await file.lines.readLines(from, count, signal);
        // Cap the response, not just the line count: 1,000 lines of 64 KiB is 64 MB.
        let bytes = 0;
        const kept: LineSlice[] = [];
        for (const line of lines) {
            bytes += line.text.length * 2;
            if (kept.length > 0 && bytes > STUDIO_BUDGETS.maxReadResponseBytes) break;
            kept.push(line);
        }
        const view = file.view();
        return { lines: kept, lineCount: view.lineCount, complete: view.complete };
    }

    async close(fileId: unknown): Promise<void> {
        const file = typeof fileId === 'string' ? this.files.get(fileId) : undefined;
        if (!file || typeof fileId !== 'string') return;
        this.files.delete(fileId);
        await this.detach(file);
    }

    async closeAll(): Promise<void> {
        await Promise.all([...this.files.keys()].map((id) => this.close(id)));
    }

    /* ---------- Statements and documents ---------- */

    /**
     * Starts splitting the file into statements or documents in the background and returns what it
     * was recognized as. Calling it again re-scans (for example with another SQL dialect).
     */
    async analyze(fileId: unknown, requested?: unknown): Promise<ItemsAnalyzed> {
        const file = this.require(fileId);
        const format = await resolveItemFormat(file.reader, file.name, requested);
        file.items?.abort.abort();
        await file.items?.done;
        file.items = undefined;
        if (!format) return { format: null, kind: null };

        const id = fileId as string;
        const abort = new AbortController();
        const emit = (state: ItemsState, bytesRead: number, count: number, error?: DbErrorInfo) =>
            file.emit('items.progress', {
                fileId: id,
                state,
                bytesRead,
                totalBytes: file.reader.size,
                count,
                ...(error ? { error } : {}),
            } satisfies ItemsProgressEvent);

        // The index exists as soon as scanning starts, so listing works on a partial result.
        let live: RangeIndex | undefined;
        const scan = scanItems(file.reader, format, {
            signal: abort.signal,
            chunkSize: this.options.chunkSize,
            progressIntervalMs: this.options.progressIntervalMs,
            onStart: (index) => (live = index),
            onProgress: (bytesRead, count) => emit('scanning', bytesRead, count),
        });
        const entry = {
            format,
            index: live as unknown as RangeIndex,
            complete: false,
            abort,
            done: scan.then(
                (finished) => {
                    entry.complete = true;
                    emit('ready', file.reader.size, finished.count);
                },
                (error: unknown) => {
                    const info = toDbError(error).toInfo();
                    emit(
                        info.code === 'CANCELLED' ? 'cancelled' : 'failed',
                        0,
                        live?.count ?? 0,
                        info,
                    );
                },
            ),
        };
        file.items = entry;
        return { format, kind: itemKindOf(format) };
    }

    async listItems(fileId: unknown, from: number, count: number): Promise<ItemsListResult> {
        const file = this.require(fileId);
        const items = file.items;
        if (!items) throw new DbError('NOT_FOUND', 'This file has not been analyzed.');
        const out: ItemSummary[] = [];
        for (let i = from; i < Math.min(items.index.count, from + count); i++) {
            out.push(await describeItem(file.reader, items.format, i, items.index.get(i)!));
        }
        return { items: out, count: items.index.count, complete: items.complete };
    }

    async readItem(fileId: unknown, index: number) {
        const file = this.require(fileId);
        const range = file.items?.index.get(index);
        if (!range) throw new DbError('NOT_FOUND', 'There is no such item.');
        const { text, truncated } = await readItemText(file.reader, range);
        return { index, start: range.start, length: range.end - range.start, text, truncated };
    }

    /** The index of the statement or document containing a byte offset (-1 if there is none). */
    itemAt(fileId: unknown, offset: number): { index: number } {
        const file = this.require(fileId);
        if (!file.items) throw new DbError('NOT_FOUND', 'This file has not been analyzed.');
        return { index: file.items.index.indexAt(offset) };
    }

    /* ---------- Search ---------- */

    /** Starts a background search; hits and progress arrive as events. Returns its id. */
    startSearch(
        fileId: unknown,
        query: unknown,
        maxHits?: unknown,
        requestedId?: unknown,
    ): { searchId: string } {
        const file = this.require(fileId);
        if (this.searchOwners.size >= MAX_SEARCHES) {
            throw new DbError('LIMIT_EXCEEDED', 'Too many searches are running. Cancel one first.');
        }
        const parsed = parseQuery(query);
        const cap = maxHits === undefined ? undefined : integer(maxHits, 'maxHits', 1_000_000);
        // The caller may choose the id so it can match events that arrive before the reply.
        if (
            requestedId !== undefined &&
            (typeof requestedId !== 'string' ||
                !/^[0-9a-f]{16}$/.test(requestedId) ||
                this.searchOwners.has(requestedId))
        ) {
            throw new DbError('INVALID_REQUEST', 'Invalid search id.');
        }
        const searchId = (requestedId as string | undefined) ?? randomBytes(8).toString('hex');
        const abort = new AbortController();
        file.searches.set(searchId, abort);
        this.searchOwners.set(searchId, fileId as string);
        const id = fileId as string;

        const progress = (
            state: SearchProgressEvent['state'],
            bytesRead: number,
            hits: number,
            truncated = false,
            error?: DbErrorInfo,
        ) =>
            file.emit('search.progress', {
                searchId,
                fileId: id,
                state,
                bytesRead,
                totalBytes: file.reader.size,
                hits,
                truncated,
                ...(error ? { error } : {}),
            } satisfies SearchProgressEvent);

        void searchFile(file.reader, parsed, {
            signal: abort.signal,
            maxHits: cap,
            chunkSize: this.options.chunkSize,
            flushMs: this.options.progressIntervalMs,
            onHits: (hits) =>
                file.emit('search.hits', { searchId, fileId: id, hits } satisfies SearchHitsEvent),
            onProgress: (p) => progress('running', p.bytesRead, p.hits),
        })
            .then((result) => progress('done', file.reader.size, result.hits, result.truncated))
            .catch((error: unknown) => {
                const info = toDbError(error).toInfo();
                progress(info.code === 'CANCELLED' ? 'cancelled' : 'failed', 0, 0, false, info);
            })
            .finally(() => {
                file.searches.delete(searchId);
                this.searchOwners.delete(searchId);
            });
        return { searchId };
    }

    cancelSearch(searchId: unknown): void {
        if (typeof searchId !== 'string') return;
        const fileId = this.searchOwners.get(searchId);
        if (fileId) this.files.get(fileId)?.searches.get(searchId)?.abort();
    }

    /* ---------- Editing ---------- */

    /**
     * The whole text of a small file, for the full editor. Files above the size limit are edited a
     * line at a time instead and are refused here, so this can never read a large file whole.
     */
    async readText(fileId: unknown): Promise<FileTextResult> {
        const file = this.require(fileId);
        if (file.reader.size > STUDIO_BUDGETS.maxFullEditBytes) {
            throw new DbError('LIMIT_EXCEEDED', 'This file is too large to edit as a whole.');
        }
        const parts: Buffer[] = [];
        for await (const chunk of file.reader.chunks({ chunkSize: this.options.chunkSize })) {
            parts.push(Buffer.from(chunk.data));
        }
        const bytes = Buffer.concat(parts);
        const text = bytes.toString('utf8');
        // A leading byte order mark is kept in the text so that saving writes it back.
        return { text, eol: file.eol, lossy: !Buffer.from(text, 'utf8').equals(bytes) };
    }

    /**
     * Writes the edited document to disk and re-opens the file on the new content. With no `path`
     * the file is replaced in place (refused if it changed on disk since it was opened); with one
     * (chosen by the user in a save dialog) the document is written there and that file is opened.
     */
    async save(
        fileId: unknown,
        piecesInput: unknown,
        eolInput?: unknown,
        path?: unknown,
    ): Promise<FileSavedResult> {
        const file = this.require(fileId);
        const id = fileId as string;
        const pieces = parsePieces(piecesInput, file.view().lineCount);
        const eol = eolInput === '\r\n' || eolInput === '\n' ? eolInput : file.eol;
        const target = path === undefined ? file.realPath : assertSafeLocalPath(path);
        if (target === file.realPath) await this.assertUnchanged(file);

        const inPlace = target === file.realPath;
        let written: { bytes: number };
        try {
            written = await writePieces(file.reader, file.view(), pieces, target, eol, {
                onProgress: (bytes) =>
                    file.emit('edit.progress', {
                        fileId: id,
                        op: 'save',
                        bytes,
                        totalBytes: file.reader.size,
                    } satisfies EditProgressEvent),
                beforeReplace: inPlace ? () => this.detach(file) : undefined,
            });
        } catch (error) {
            // The reader may have been released just before a failed replacement: reopen the file.
            if (inPlace) await this.reload(id, file, file.realPath).catch(() => undefined);
            throw error;
        }
        await this.reload(id, file, target);
        file.eol = eol;
        return { ...this.describe(id, file), size: written.bytes };
    }

    /** Replaces every match in place, line by line, and re-opens the file. */
    async replaceAll(
        fileId: unknown,
        query: unknown,
        replacement: unknown,
    ): Promise<{ replacements: number } & FileSavedResult> {
        const file = this.require(fileId);
        const id = fileId as string;
        if (typeof replacement !== 'string' || replacement.length > 10_000) {
            throw new DbError('INVALID_REQUEST', 'The replacement text is invalid.');
        }
        await this.assertUnchanged(file);
        const parsed = parseQuery(query);
        let replacements = 0;
        try {
            ({ replacements } = await replaceInFile(
                file.reader,
                parsed,
                replacement,
                file.realPath,
                {
                    chunkSize: this.options.chunkSize,
                    onProgress: (bytesRead) =>
                        file.emit('edit.progress', {
                            fileId: id,
                            op: 'replace',
                            bytes: bytesRead,
                            totalBytes: file.reader.size,
                        } satisfies EditProgressEvent),
                    beforeReplace: () => this.detach(file),
                },
            ));
        } catch (error) {
            // The reader may have been released just before a failed replacement: reopen the file.
            await this.reload(id, file, file.realPath).catch(() => undefined);
            throw error;
        }
        // Reopen on the new content (or the unchanged file when nothing matched).
        await this.reload(id, file, file.realPath);
        return { ...this.describe(id, file), replacements };
    }

    /** Refuses to overwrite a file somebody else changed after it was opened. */
    private async assertUnchanged(file: OpenFile): Promise<void> {
        const now = await statFile(file.realPath);
        if (now.size !== file.reader.size || now.mtimeMs !== file.reader.mtimeMs) {
            throw new DbError(
                'CONFLICT',
                'The file was changed on disk after it was opened. Reopen it, or save a copy elsewhere.',
            );
        }
    }

    private require(fileId: unknown): OpenFile {
        const file = typeof fileId === 'string' ? this.files.get(fileId) : undefined;
        if (!file) throw new DbError('NOT_FOUND', 'That file is no longer open.');
        return file;
    }
}
