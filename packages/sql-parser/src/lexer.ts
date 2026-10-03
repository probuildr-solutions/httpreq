/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import type { SqlDialect } from './scanner';

export type TokenType =
    | 'keyword'
    | 'identifier'
    | 'quotedIdentifier'
    | 'string'
    | 'number'
    | 'comment'
    | 'operator'
    | 'punctuation'
    | 'parameter'
    | 'whitespace';

export interface Token {
    type: TokenType;
    /** Character offsets within the line (or text) that was tokenized. */
    start: number;
    end: number;
}

/**
 * What a line ends inside, so the next line can continue it. Highlighting a screenful of a huge
 * file starts from a stored state a few hundred lines above, never from the top of the file.
 */
export interface LexState {
    mode: 'code' | 'block' | 'string' | 'quotedIdentifier' | 'dollar';
    /** Block comment depth (PostgreSQL nests them). */
    depth: number;
    /** The quote character, or the dollar-quote tag including its dollars. */
    quote: string;
    /** Whether backslashes escape inside the current string. */
    escapes: boolean;
}

export const INITIAL_LEX_STATE: LexState = { mode: 'code', depth: 0, quote: '', escapes: false };

const KEYWORDS = new Set(
    (
        'ADD ALL ALTER ANALYZE AND ANY AS ASC BEGIN BETWEEN BY CASE CAST CHECK COLLATE COLUMN COMMIT CONSTRAINT ' +
        'CREATE CROSS CURRENT_DATE CURRENT_TIME CURRENT_TIMESTAMP DATABASE DEFAULT DELETE DESC DESCRIBE DISTINCT ' +
        'DROP ELSE END ESCAPE EXCEPT EXISTS EXPLAIN FALSE FETCH FOR FOREIGN FROM FULL FUNCTION GRANT GROUP HAVING ' +
        'IF ILIKE IN INDEX INNER INSERT INTERSECT INTO IS JOIN KEY LEFT LIKE LIMIT NATURAL NOT NULL OFFSET ON OR ' +
        'ORDER OUTER PRIMARY PROCEDURE REFERENCES REPLACE RETURNING RETURNS REVOKE RIGHT ROLLBACK SCHEMA SELECT SET ' +
        'SHOW TABLE THEN TO TRIGGER TRUE TRUNCATE UNION UNIQUE UPDATE USE USING VALUES VIEW WHEN WHERE WITH ' +
        'AUTO_INCREMENT ENGINE DELIMITER CALL DECLARE LOOP WHILE REPEAT UNTIL RETURN SAVEPOINT START TRANSACTION ' +
        'MATERIALIZED SEQUENCE EXTENSION OVER PARTITION WINDOW RECURSIVE LATERAL DO NOTHING CONFLICT'
    ).split(' '),
);

const isDigit = (c: string) => c >= '0' && c <= '9';
const isWordStart = (c: string) => /[A-Za-z_\u0080-￿]/.test(c);
const isWordChar = (c: string) => /[A-Za-z0-9_$\u0080-￿]/.test(c);

/**
 * Tokenizes one line of SQL, given the state the previous line ended in, and returns the state
 * this line ends in. Lexing is deliberately shallow (comments, strings, identifiers, numbers,
 * keywords, operators): enough for highlighting and for finding what a statement is, with no
 * grammar behind it.
 */
export const tokenizeLine = (
    line: string,
    from: LexState,
    dialect: SqlDialect,
): { tokens: Token[]; state: LexState } => {
    const mysql = dialect === 'mysql';
    const tokens: Token[] = [];
    let { mode, depth, quote, escapes } = from;
    let i = 0;
    const n = line.length;
    const emit = (type: TokenType, start: number, end: number) => {
        if (end > start) tokens.push({ type, start, end });
    };

    // Where the token being continued began, when it opened earlier on this line.
    let opened = -1;

    while (i < n) {
        const start = opened >= 0 ? opened : i;
        opened = -1;
        if (mode === 'block') {
            while (i < n) {
                if (line[i] === '*' && line[i + 1] === '/') {
                    i += 2;
                    if (--depth === 0) {
                        mode = 'code';
                        break;
                    }
                } else if (!mysql && line[i] === '/' && line[i + 1] === '*') {
                    i += 2;
                    depth++;
                } else {
                    i++;
                }
            }
            emit('comment', start, i);
            continue;
        }
        if (mode === 'string' || mode === 'quotedIdentifier') {
            let closed = false;
            while (i < n) {
                const c = line[i]!;
                if (c === '\\' && escapes) {
                    i += 2;
                } else if (c === quote) {
                    if (line[i + 1] === quote) {
                        i += 2; // a doubled quote stays inside the literal
                    } else {
                        i++;
                        closed = true;
                        break;
                    }
                } else {
                    i++;
                }
            }
            i = Math.min(i, n);
            emit(mode === 'string' ? 'string' : 'quotedIdentifier', start, i);
            if (closed) mode = 'code';
            continue;
        }
        if (mode === 'dollar') {
            const found = line.indexOf(quote, i);
            if (found === -1) {
                i = n;
            } else {
                i = found + quote.length;
                mode = 'code';
            }
            emit('string', start, i);
            continue;
        }

        const c = line[i]!;
        if (c === ' ' || c === '\t' || c === '\r') {
            while (i < n && (line[i] === ' ' || line[i] === '\t' || line[i] === '\r')) i++;
            emit('whitespace', start, i);
        } else if (
            c === '-' &&
            line[i + 1] === '-' &&
            (!mysql || i + 2 >= n || /\s/.test(line[i + 2]!))
        ) {
            emit('comment', start, n);
            i = n;
        } else if (c === '#' && mysql) {
            emit('comment', start, n);
            i = n;
        } else if (c === '/' && line[i + 1] === '*') {
            mode = 'block';
            depth = 1;
            opened = i;
            i += 2;
        } else if (c === "'" || (c === '"' && mysql)) {
            mode = 'string';
            quote = c;
            // PostgreSQL: backslashes escape only inside E'...' strings.
            escapes = mysql || (/[eE]/.test(line[i - 1] ?? '') && !isWordChar(line[i - 2] ?? ' '));
            opened = i;
            i++;
        } else if (c === '"' || (c === '`' && mysql)) {
            mode = 'quotedIdentifier';
            quote = c;
            escapes = false;
            opened = i;
            i++;
        } else if (c === '$' && !mysql) {
            const tag = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(line.slice(i, i + 70));
            if (tag) {
                mode = 'dollar';
                quote = tag[0];
                opened = i;
                i += tag[0].length;
            } else {
                // A positional parameter ($1) or a stray dollar.
                i++;
                while (i < n && isDigit(line[i]!)) i++;
                emit('parameter', start, i);
            }
        } else if (isDigit(c) || (c === '.' && isDigit(line[i + 1] ?? ''))) {
            while (i < n && /[0-9a-fA-FxX._]/.test(line[i]!)) i++;
            emit('number', start, i);
        } else if (isWordStart(c)) {
            while (i < n && isWordChar(line[i]!)) i++;
            emit(
                KEYWORDS.has(line.slice(start, i).toUpperCase()) ? 'keyword' : 'identifier',
                start,
                i,
            );
        } else if (c === '@' || c === ':' || c === '?') {
            i++;
            while (i < n && isWordChar(line[i]!)) i++;
            emit('parameter', start, i);
        } else if ('(),;.[]{}'.includes(c)) {
            i++;
            emit('punctuation', start, i);
        } else {
            i++;
            while (i < n && '+-*/%=<>!|&^~'.includes(line[i]!)) i++;
            emit('operator', start, i);
        }
    }
    // A quote opened at the very end of the line still carries over (nothing left to emit).
    if (opened >= 0)
        emit(
            mode === 'block'
                ? 'comment'
                : mode === 'quotedIdentifier'
                  ? 'quotedIdentifier'
                  : 'string',
            opened,
            n,
        );
    return { tokens, state: { mode, depth, quote, escapes } };
};

/** Tokenizes a whole (small) text, carrying state across its lines. Offsets are into the text. */
export const tokenize = (text: string, dialect: SqlDialect): Token[] => {
    const out: Token[] = [];
    let state = INITIAL_LEX_STATE;
    let offset = 0;
    for (const line of text.split('\n')) {
        const result = tokenizeLine(line, state, dialect);
        for (const token of result.tokens) {
            out.push({ type: token.type, start: token.start + offset, end: token.end + offset });
        }
        state = result.state;
        offset += line.length + 1;
    }
    return out;
};
