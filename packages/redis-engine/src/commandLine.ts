/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { DbError } from '@httpreq/db-core';

const HEX = /^[0-9a-fA-F]{2}$/;

/**
 * Splits a command line into arguments the way `redis-cli` does: words separated by spaces,
 * `"double quotes"` with `\n \r \t \b \a \xHH \\ \"` escapes, and `'single quotes'` where only
 * `\'` is special.
 */
export const parseCommandLine = (line: string): string[] => {
    const args: string[] = [];
    let i = 0;
    const n = line.length;
    while (i < n) {
        while (i < n && /\s/.test(line[i]!)) i++;
        if (i >= n) break;
        let arg = '';
        const quote = line[i];
        if (quote === '"') {
            i++;
            let closed = false;
            const bytes: number[] = [];
            const flush = () => {
                if (bytes.length > 0) {
                    arg += Buffer.from(bytes).toString('utf8');
                    bytes.length = 0;
                }
            };
            while (i < n) {
                const c = line[i]!;
                if (c === '\\' && i + 1 < n) {
                    const next = line[i + 1]!;
                    if (next === 'x' && HEX.test(line.slice(i + 2, i + 4))) {
                        bytes.push(parseInt(line.slice(i + 2, i + 4), 16));
                        i += 4;
                        continue;
                    }
                    flush();
                    arg += { n: '\n', r: '\r', t: '\t', b: '\b', a: '\x07' }[next] ?? next;
                    i += 2;
                    continue;
                }
                if (c === '"') {
                    closed = true;
                    i++;
                    break;
                }
                flush();
                arg += c;
                i++;
            }
            flush();
            if (!closed) throw new DbError('INVALID_REQUEST', 'A double quote is not closed.');
            if (i < n && !/\s/.test(line[i]!)) {
                throw new DbError(
                    'INVALID_REQUEST',
                    'A closing quote must be followed by a space.',
                );
            }
        } else if (quote === "'") {
            i++;
            let closed = false;
            while (i < n) {
                const c = line[i]!;
                if (c === '\\' && line[i + 1] === "'") {
                    arg += "'";
                    i += 2;
                    continue;
                }
                if (c === "'") {
                    closed = true;
                    i++;
                    break;
                }
                arg += c;
                i++;
            }
            if (!closed) throw new DbError('INVALID_REQUEST', 'A single quote is not closed.');
            if (i < n && !/\s/.test(line[i]!)) {
                throw new DbError(
                    'INVALID_REQUEST',
                    'A closing quote must be followed by a space.',
                );
            }
        } else {
            while (i < n && !/\s/.test(line[i]!)) arg += line[i++];
        }
        args.push(arg);
    }
    return args;
};

/** Quotes a value so `parseCommandLine` reads it back unchanged. */
export const quoteArgument = (value: string): string => {
    if (value !== '' && /^[A-Za-z0-9_.:/@#%+=,-]+$/.test(value)) return value;
    return `"${value
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
        .replace(/\t/g, '\\t')}"`;
};

/**
 * Splits a script into commands: one per line. Blank lines and lines that start with `#` or `//`
 * are comments. Ranges are offsets into the text, as for SQL statements.
 */
export const splitCommandLines = (
    text: string,
): { start: number; end: number; sql: string; kind: number }[] => {
    const out: { start: number; end: number; sql: string; kind: number }[] = [];
    let offset = 0;
    for (const line of text.split('\n')) {
        const trimmed = line.replace(/\r$/, '');
        const lead = trimmed.length - trimmed.trimStart().length;
        const body = trimmed.trim();
        if (body && !body.startsWith('#') && !body.startsWith('//')) {
            out.push({
                start: offset + lead,
                end: offset + lead + body.length,
                sql: body,
                kind: 0,
            });
        }
        offset += line.length + 1;
    }
    return out;
};
