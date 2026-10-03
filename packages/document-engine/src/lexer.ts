/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

export type JsonTokenType =
    'key' | 'string' | 'number' | 'keyword' | 'punctuation' | 'whitespace' | 'invalid';

export interface JsonToken {
    type: JsonTokenType;
    /** Character offsets within the line. */
    start: number;
    end: number;
}

const isDigit = (c: string) => c >= '0' && c <= '9';

/**
 * Tokenizes one line of JSON for highlighting. JSON has no multi-line tokens (a string cannot
 * contain a raw line break), so a line needs no state from the one before it, which is what lets
 * the viewer highlight any screenful of a huge file on its own.
 *
 * A string followed by `:` is a `key`. Anything that is not valid JSON at that position is
 * `invalid`; the lexer keeps going so one stray character does not turn the rest of the line off.
 */
export const tokenizeJsonLine = (line: string): JsonToken[] => {
    const tokens: JsonToken[] = [];
    const n = line.length;
    let i = 0;
    const emit = (type: JsonTokenType, start: number, end: number) =>
        tokens.push({ type, start, end });

    while (i < n) {
        const start = i;
        const c = line[i]!;
        if (c === ' ' || c === '\t' || c === '\r') {
            while (i < n && (line[i] === ' ' || line[i] === '\t' || line[i] === '\r')) i++;
            emit('whitespace', start, i);
        } else if (c === '"') {
            i++;
            while (i < n && line[i] !== '"') i += line[i] === '\\' ? 2 : 1;
            i = Math.min(n, i + 1);
            // A key is a string that the next significant character follows with a colon.
            let after = i;
            while (after < n && (line[after] === ' ' || line[after] === '\t')) after++;
            emit(line[after] === ':' ? 'key' : 'string', start, i);
        } else if (c === '-' || isDigit(c)) {
            i++;
            while (i < n && /[0-9.eE+-]/.test(line[i]!)) i++;
            emit('number', start, i);
        } else if ('{}[],:'.includes(c)) {
            i++;
            emit('punctuation', start, i);
        } else if (/[a-z]/.test(c)) {
            while (i < n && /[a-z]/.test(line[i]!)) i++;
            emit(
                ['true', 'false', 'null'].includes(line.slice(start, i)) ? 'keyword' : 'invalid',
                start,
                i,
            );
        } else {
            i++;
            emit('invalid', start, i);
        }
    }
    return tokens;
};
