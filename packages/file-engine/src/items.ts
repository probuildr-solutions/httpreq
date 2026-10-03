/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { DbError, RangeIndex, STUDIO_BUDGETS } from '@httpreq/db-core';
import {
    DOC_ERROR,
    DOC_TRUNCATED,
    JsonDocumentScanner,
    detectJsonFormat,
    previewText,
} from '@httpreq/document-engine';
import { FLAG_ERROR, FLAG_UNTERMINATED, SqlScanner, kindName, kindOf } from '@httpreq/sql-parser';
import type { ChunkReader } from './reader';

/** What a file is made of: statements or documents, and how they are laid out. */
export type ItemFormat = 'sql-mysql' | 'sql-postgresql' | 'jsonl' | 'json-array' | 'json-sequence';

export const ITEM_FORMATS: readonly ItemFormat[] = [
    'sql-mysql',
    'sql-postgresql',
    'jsonl',
    'json-array',
    'json-sequence',
];

/** SQL statements or JSON documents. */
export type ItemKind = 'statement' | 'document';

export const itemKindOf = (format: ItemFormat): ItemKind =>
    format.startsWith('sql') ? 'statement' : 'document';

const extensionOf = (name: string): string => {
    const dot = name.lastIndexOf('.');
    return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
};

/**
 * Chooses a format from the file name and its first bytes, unless the user asked for one. `null`
 * means the file is not one we split into items (it is still browsable and searchable by line).
 */
export const resolveItemFormat = async (
    reader: ChunkReader,
    fileName: string,
    requested?: unknown,
): Promise<ItemFormat | null> => {
    if (requested !== undefined && requested !== 'auto') {
        if (!ITEM_FORMATS.includes(requested as ItemFormat)) {
            throw new DbError('INVALID_REQUEST', 'Unknown file format.');
        }
        return requested as ItemFormat;
    }
    const extension = extensionOf(fileName);
    if (extension === 'sql') return 'sql-mysql';
    if (extension === 'json' || extension === 'jsonl' || extension === 'ndjson') {
        const detected = detectJsonFormat(await reader.readRange(0, 64 * 1024), extension);
        return detected === 'jsonl'
            ? 'jsonl'
            : detected === 'array'
              ? 'json-array'
              : 'json-sequence';
    }
    return null;
};

export interface ScanItemsOptions {
    signal?: AbortSignal;
    chunkSize?: number;
    onProgress?: (bytesRead: number, items: number) => void;
    progressIntervalMs?: number;
    /** Receives the live index, readable while the scan runs. */
    onStart?: (index: RangeIndex) => void;
}

/** Scans the whole file once, in chunks, building the offset index of its statements or documents. */
export const scanItems = async (
    reader: ChunkReader,
    format: ItemFormat,
    options: ScanItemsOptions = {},
): Promise<RangeIndex> => {
    const scanner =
        format === 'sql-mysql'
            ? new SqlScanner('mysql')
            : format === 'sql-postgresql'
              ? new SqlScanner('postgresql')
              : new JsonDocumentScanner(
                    format === 'jsonl' ? 'jsonl' : format === 'json-array' ? 'array' : 'sequence',
                );
    options.onStart?.(scanner.index);
    const every = options.progressIntervalMs ?? 100;
    let last = 0;
    for await (const chunk of reader.chunks({
        signal: options.signal,
        chunkSize: options.chunkSize,
    })) {
        scanner.feed(chunk.data, chunk.offset);
        const now = Date.now();
        if (options.onProgress && now - last >= every) {
            last = now;
            options.onProgress(scanner.bytesScanned, scanner.index.count);
        }
    }
    return scanner.finish(reader.size);
};

/** One row of an item list. */
export interface ItemSummary {
    index: number;
    start: number;
    length: number;
    /** `SELECT`, `INSERT`… for statements; `document` for documents. */
    label: string;
    /** The beginning of the item's text on one line. */
    preview: string;
    /** The item is damaged or cut off. */
    problem?: 'malformed' | 'unterminated';
}

const PREVIEW_BYTES = 400;

export const describeItem = async (
    reader: ChunkReader,
    format: ItemFormat,
    index: number,
    range: { start: number; end: number; flags: number },
): Promise<ItemSummary> => {
    const length = range.end - range.start;
    const head = await reader.readRange(range.start, Math.min(length, PREVIEW_BYTES));
    let label = 'document';
    let problem: ItemSummary['problem'];
    if (itemKindOf(format) === 'statement') {
        label = kindName(kindOf(range.flags));
        if (range.flags & FLAG_ERROR) problem = 'malformed';
        else if (range.flags & FLAG_UNTERMINATED) problem = 'unterminated';
    } else if (range.flags & (DOC_ERROR | DOC_TRUNCATED)) {
        problem = range.flags & DOC_TRUNCATED ? 'unterminated' : 'malformed';
    }
    return {
        index,
        start: range.start,
        length,
        label,
        preview: previewText(new TextDecoder().decode(head), 160),
        ...(problem ? { problem } : {}),
    };
};

/** Reads one item's text, cut at `STUDIO_BUDGETS.maxItemReadBytes`. */
export const readItemText = async (
    reader: ChunkReader,
    range: { start: number; end: number },
): Promise<{ text: string; truncated: boolean }> => {
    const length = range.end - range.start;
    const take = Math.min(length, STUDIO_BUDGETS.maxItemReadBytes);
    const bytes = await reader.readRange(range.start, take);
    return { text: new TextDecoder().decode(bytes), truncated: take < length };
};
