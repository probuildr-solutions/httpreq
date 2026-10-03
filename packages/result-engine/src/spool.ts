/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { deserialize, serialize } from 'node:v8';
import { DbError, type ColumnMeta, type DbValue } from '@httpreq/db-core';
import { SpoolFile, type SpoolEntry } from '@httpreq/file-engine';

export interface ResultSpoolOptions {
    /** Folder for the temporary file. */
    directory: string;
    /** Rows per page. */
    pageRows?: number;
    /** A page is also closed when its rows add up to about this many bytes. */
    pageBytes?: number;
    /** Largest the temporary file may grow; further rows are not stored. */
    maxBytes?: number;
    /** Pages kept decoded in memory for quick re-reading. */
    cachePages?: number;
}

const DEFAULT_PAGE_ROWS = 1_000;
const DEFAULT_PAGE_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_CACHE_PAGES = 8;

/** A rough memory size of a value, for closing pages that hold wide rows. */
const sizeOf = (value: DbValue): number => {
    if (value === null || typeof value === 'boolean') return 8;
    if (typeof value === 'string') return value.length * 2 + 16;
    if (value instanceof Uint8Array) return value.length + 16;
    if (typeof value === 'number' || typeof value === 'bigint') return 16;
    if (value instanceof Date) return 16;
    if (Array.isArray(value)) return value.reduce<number>((sum, item) => sum + sizeOf(item), 24);
    return Object.values(value).reduce<number>((sum, item) => sum + sizeOf(item), 24);
};

/**
 * One result set, kept on disk as it arrives so that a result of any size can be scrolled with
 * bounded memory.
 *
 * Rows collect in a page. When the page is full (by rows or by bytes) it is serialized and
 * appended to a temporary file, and only its offset is remembered. Reading a page decodes it from
 * the file, and the most recent few stay cached. Memory is therefore one partial page plus the
 * cache, however many rows there are.
 */
export class ResultSpool {
    columns: ColumnMeta[] = [];
    /** Rows stored (flushed or in the open page). */
    rowCount = 0;
    /** The file reached its size limit: rows after this point were dropped. */
    capped = false;

    private readonly flushed: { entry: SpoolEntry; rows: number }[] = [];
    private open: DbValue[][] = [];
    private openBytes = 0;
    private readonly cache = new Map<number, DbValue[][]>();

    private constructor(
        private readonly file: SpoolFile,
        private readonly pageRows: number,
        private readonly pageBytes: number,
        private readonly cachePages: number,
    ) {}

    static async create(options: ResultSpoolOptions): Promise<ResultSpool> {
        const file = await SpoolFile.create(
            options.directory,
            options.maxBytes ?? DEFAULT_MAX_BYTES,
        );
        return new ResultSpool(
            file,
            options.pageRows ?? DEFAULT_PAGE_ROWS,
            options.pageBytes ?? DEFAULT_PAGE_BYTES,
            options.cachePages ?? DEFAULT_CACHE_PAGES,
        );
    }

    get pageSize(): number {
        return this.pageRows;
    }

    /** Pages available, counting a partly filled last one. */
    get pageCount(): number {
        return this.flushed.length + (this.open.length > 0 ? 1 : 0);
    }

    /** Bytes the result occupies on disk. */
    get diskBytes(): number {
        return this.file.bytes;
    }

    /**
     * Stores rows. Returns false once the file is full: that row and every later one is dropped,
     * and `capped` is set, so the caller can stop the statement.
     */
    async append(rows: DbValue[][]): Promise<boolean> {
        for (const row of rows) {
            if (this.capped) return false;
            this.open.push(row);
            this.rowCount++;
            for (const cell of row) this.openBytes += sizeOf(cell);
            if (this.open.length >= this.pageRows || this.openBytes >= this.pageBytes) {
                if (!(await this.flushPage())) return false;
            }
        }
        return true;
    }

    /** Writes the last, partly filled page to disk. Call when the result has ended. */
    async finish(): Promise<void> {
        if (this.open.length > 0 && !this.capped) await this.flushPage();
    }

    /**
     * The rows of page `index` (0-based), or `null` past the end. A page holds `pageSize` rows
     * unless it was closed early because its rows were wide.
     */
    async page(index: number): Promise<{ rows: DbValue[][]; firstRow: number } | null> {
        if (!Number.isInteger(index) || index < 0) return null;
        let firstRow = 0;
        for (let i = 0; i < Math.min(index, this.flushed.length); i++)
            firstRow += this.flushed[i]!.rows;
        if (index < this.flushed.length) {
            const cached = this.cache.get(index);
            if (cached) {
                // Re-insert so the cache evicts the page that was used longest ago.
                this.cache.delete(index);
                this.cache.set(index, cached);
                return { rows: cached, firstRow };
            }
            const bytes = await this.file.read(this.flushed[index]!.entry);
            const rows = deserialize(bytes) as DbValue[][];
            this.cache.set(index, rows);
            if (this.cache.size > this.cachePages)
                this.cache.delete(this.cache.keys().next().value as number);
            return { rows, firstRow };
        }
        if (index === this.flushed.length && this.open.length > 0) {
            return { rows: [...this.open], firstRow };
        }
        return null;
    }

    /** Finds the page that holds a row, and the row's place in it. */
    locate(row: number): { page: number; offset: number } | null {
        if (row < 0 || row >= this.rowCount) return null;
        let first = 0;
        for (let page = 0; page < this.flushed.length; page++) {
            const count = this.flushed[page]!.rows;
            if (row < first + count) return { page, offset: row - first };
            first += count;
        }
        return { page: this.flushed.length, offset: row - first };
    }

    async cell(row: number, column: number): Promise<DbValue> {
        const where = this.locate(row);
        if (!where) throw new DbError('NOT_FOUND', 'There is no such row.');
        const page = await this.page(where.page);
        const value = page?.rows[where.offset]?.[column];
        if (value === undefined) throw new DbError('NOT_FOUND', 'There is no such cell.');
        return value;
    }

    async dispose(): Promise<void> {
        this.cache.clear();
        this.open = [];
        await this.file.dispose();
    }

    private async flushPage(): Promise<boolean> {
        const rows = this.open;
        const bytes = serialize(rows);
        if (!this.file.fits(bytes.length)) {
            this.capped = true;
            this.rowCount -= rows.length;
            this.open = [];
            this.openBytes = 0;
            return false;
        }
        const entry = await this.file.append(bytes);
        this.flushed.push({ entry, rows: rows.length });
        this.open = [];
        this.openBytes = 0;
        return true;
    }
}

/* ---------- Sending pages to a window ---------- */

/** Text cells longer than this are cut when a page is sent; the full value is fetched on demand. */
export const MAX_CELL_CHARS = 2_000;
/** Binary cells longer than this are cut likewise. */
export const MAX_CELL_BYTES = 256;

export interface ClippedCell {
    row: number;
    column: number;
    /** The cell's real length (characters or bytes). */
    length: number;
}

/**
 * Cuts the widest cells so a page stays small to send. The cut cells are listed, so the grid can
 * show that they are cut and offer to load the whole value.
 */
export const clipPage = (rows: DbValue[][]): { rows: DbValue[][]; clipped: ClippedCell[] } => {
    const clipped: ClippedCell[] = [];
    const out = rows.map((row, r) =>
        row.map((cell, c) => {
            if (typeof cell === 'string' && cell.length > MAX_CELL_CHARS) {
                clipped.push({ row: r, column: c, length: cell.length });
                return cell.slice(0, MAX_CELL_CHARS);
            }
            if (cell instanceof Uint8Array && cell.length > MAX_CELL_BYTES) {
                clipped.push({ row: r, column: c, length: cell.length });
                return cell.slice(0, MAX_CELL_BYTES);
            }
            return cell;
        }),
    );
    return { rows: out, clipped };
};
