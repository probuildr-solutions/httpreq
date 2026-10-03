/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { DbError, STUDIO_BUDGETS, throwIfAborted } from '@httpreq/db-core';
import type { ChunkReader } from '@httpreq/file-engine';
import {
    FLAG_ERROR,
    FLAG_UNTERMINATED,
    SqlScanner,
    StatementKind,
    kindOf,
    type SqlDialect,
} from '@httpreq/sql-parser';

/** A statement of a script, with its text ready to send to a server. */
export interface ScriptStatement {
    /** 0-based position among the statements sent (client commands are not counted). */
    index: number;
    /** The statement as the server should see it: comments kept, delimiter removed. */
    sql: string;
    /** Where it starts and ends in the source, in bytes. */
    start: number;
    end: number;
    kind: number;
    /** The source ended inside a quote or comment: this statement is not well-formed. */
    malformed: boolean;
    /** 1-based line of the statement's first non-blank character, counted from where reading began. */
    line: number;
}

const countNewlines = (text: string): number => {
    let count = 0;
    for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) count++;
    return count;
};

/** Removes surrounding whitespace and the statement terminator, which belongs to the client, not the server. */
const stripDelimiter = (text: string, delimiter: string, terminated: boolean): string => {
    let sql = text.trim();
    if (terminated && sql.endsWith(delimiter)) sql = sql.slice(0, sql.length - delimiter.length);
    return sql.trimEnd();
};

/**
 * Splits text into statements: `start` and `end` are character offsets into `text` (as an editor
 * counts them), and `sql` is what to send. Client commands such as MySQL's `DELIMITER` are left
 * out. Meant for text held in memory (a query editor); a file goes through `streamStatements`.
 */
export const splitStatements = (
    text: string,
    dialect: SqlDialect,
): { start: number; end: number; sql: string; kind: number; malformed: boolean }[] => {
    const bytes = Buffer.from(text, 'utf8');
    const found: { start: number; end: number; flags: number; delimiter: string }[] = [];
    const scanner = new SqlScanner(dialect, (statement) => found.push(statement));
    scanner.feed(bytes, 0);
    scanner.finish(bytes.length);

    // Convert byte offsets to character offsets in one pass.
    const wanted = new Set<number>();
    for (const statement of found) {
        wanted.add(statement.start);
        wanted.add(statement.end);
    }
    const chars = new Map<number, number>();
    let byte = 0;
    let char = 0;
    if (wanted.has(0)) chars.set(0, 0);
    for (const codePoint of text) {
        byte += Buffer.byteLength(codePoint, 'utf8');
        char += codePoint.length;
        if (wanted.has(byte)) chars.set(byte, char);
    }
    return found
        .filter((statement) => kindOf(statement.flags) !== StatementKind.Delimiter)
        .map((statement) => {
            const start = chars.get(statement.start) ?? 0;
            const end = chars.get(statement.end) ?? text.length;
            const raw = text.slice(start, end);
            const terminated = (statement.flags & FLAG_UNTERMINATED) === 0;
            return {
                start,
                end,
                sql: stripDelimiter(raw, statement.delimiter, terminated),
                kind: kindOf(statement.flags),
                malformed: (statement.flags & FLAG_ERROR) !== 0,
            };
        });
};

/**
 * The statement the cursor is in: the one containing `offset`, or, between statements (or after
 * the last one), the nearest one before it.
 */
export const statementAt = (
    text: string,
    offset: number,
    dialect: SqlDialect,
): { start: number; end: number; sql: string; kind: number } | null => {
    const statements = splitStatements(text, dialect);
    if (statements.length === 0) return null;
    let best = statements[0]!;
    for (const statement of statements) {
        // Leading blank lines and comments belong to a statement's range; the cursor on them still
        // means "this statement", so the first statement that ends at or after the cursor wins.
        if (offset <= statement.end) return statement;
        best = statement;
    }
    return best;
};

export interface StreamOptions {
    signal?: AbortSignal;
    /** First byte to read; must be where a statement starts. */
    start?: number;
    /** One past the last byte to read. */
    end?: number;
}

/**
 * Reads a script from disk and yields its statements one at a time, as soon as each is complete.
 * Nothing is indexed and nothing is kept: memory is one chunk plus the statement being gathered,
 * which is capped, so a 3 GB script runs in constant space and starts executing at once.
 */
export async function* streamStatements(
    reader: ChunkReader,
    dialect: SqlDialect,
    options: StreamOptions = {},
): AsyncGenerator<ScriptStatement & { bytesRead: number }, void, void> {
    const start = options.start ?? 0;
    const pending: { start: number; end: number; flags: number; delimiter: string }[] = [];
    const scanner = new SqlScanner(dialect, (statement) => pending.push(statement));
    if (start > 0) scanner.startAt(start);
    // Bytes from `windowStart` on, enough to cut every statement still being gathered.
    let window: Buffer = Buffer.alloc(0);
    let windowStart = start;
    let index = 0;
    let linesBefore = 0; // line breaks in everything already handed out

    const emit = function* (bytesRead: number): Generator<ScriptStatement & { bytesRead: number }> {
        for (const statement of pending.splice(0)) {
            const slice = window.subarray(
                statement.start - windowStart,
                statement.end - windowStart,
            );
            const text = slice.toString('utf8');
            const leading = /^\s*/.exec(text)![0];
            const line = linesBefore + countNewlines(leading) + 1;
            linesBefore += countNewlines(text);
            if (kindOf(statement.flags) !== StatementKind.Delimiter) {
                const terminated = (statement.flags & FLAG_UNTERMINATED) === 0;
                yield {
                    index: index++,
                    sql: stripDelimiter(text, statement.delimiter, terminated),
                    start: statement.start,
                    end: statement.end,
                    kind: kindOf(statement.flags),
                    malformed: (statement.flags & FLAG_ERROR) !== 0,
                    line,
                    bytesRead,
                };
            }
            // Everything up to the end of this statement is no longer needed.
            window = window.subarray(statement.end - windowStart);
            windowStart = statement.end;
        }
    };

    for await (const chunk of reader.chunks({ start, end: options.end, signal: options.signal })) {
        const bytes = Buffer.from(chunk.data.buffer, chunk.data.byteOffset, chunk.data.length);
        window = window.length === 0 ? Buffer.from(bytes) : Buffer.concat([window, bytes]);
        scanner.feed(bytes, chunk.offset);
        yield* emit(chunk.offset + chunk.data.length);
        if (window.length > STUDIO_BUDGETS.maxSingleItemBytes) {
            throw new DbError(
                'LIMIT_EXCEEDED',
                'A single statement in this script is larger than 64 MiB.',
            );
        }
        throwIfAborted(options.signal);
    }
    scanner.finish(windowStart + window.length);
    yield* emit(windowStart + window.length);
}
