/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { RangeIndex } from '@httpreq/db-core';
import {
    FLAG_ERROR,
    FLAG_UNTERMINATED,
    StatementKind,
    kindFromKeyword,
    type StatementKindValue,
} from './kinds';

export type SqlDialect = 'mysql' | 'postgresql';

/**
 * Called as each statement is found, in file order. `delimiter` is the one in effect for that
 * statement (a `DELIMITER` command may change it later in the same chunk), so a caller can strip
 * it from the text before sending the statement to a server that does not know it.
 */
export type StatementListener = (statement: {
    start: number;
    end: number;
    flags: number;
    delimiter: string;
}) => void;

/* Scanner states. */
const NORMAL = 0;
const LINE_COMMENT = 1;
const BLOCK_COMMENT = 2;
const SQUOTE = 3;
const DQUOTE = 4;
const BTICK = 5;
const DOLLAR = 6;
const DOLLAR_TAG = 7;
/** Saw a quote inside a quoted run: either `''` (an escaped quote) or the end of it. */
const SQUOTE_END = 8;
const DQUOTE_END = 9;
const BTICK_END = 10;
/** Saw `--` (MySQL needs whitespace after it for it to be a comment). */
const DASH_DASH = 11;
/** Matching a multi-byte delimiter. */
const DELIM_MATCH = 12;
/** Reading the rest of a `DELIMITER x` line. */
const DELIM_DIRECTIVE = 13;

/* Where the scanner is within the current statement. */
const BEFORE = 0; // nothing significant yet
const WORD = 1; // reading the first keyword
const INSIDE = 2; // past the first keyword

const LF = 10;
const MAX_WORD = 24;
const MAX_DELIMITER = 16;

const isSpace = (b: number) => b === 32 || (b >= 9 && b <= 13);
const isWordStart = (b: number) => (b >= 65 && b <= 90) || (b >= 97 && b <= 122) || b === 95;
const isWordByte = (b: number) => isWordStart(b) || (b >= 48 && b <= 57);
const upper = (b: number) => (b >= 97 && b <= 122 ? b - 32 : b);

/**
 * Finds where each statement of an SQL script begins and ends, one chunk at a time.
 *
 * This is a scanner, not a parser. It knows only enough SQL lexing to know when a `;` is a
 * terminator: it skips comments, string and identifier quotes (with the doubled-quote and
 * backslash escapes of each dialect), PostgreSQL dollar-quoted bodies and nested block comments,
 * and MySQL's `DELIMITER` command, so stored procedures, functions and triggers stay in one
 * piece. Everything else about a statement is left for the lazy parser, which looks at one
 * statement at a time.
 *
 * All state lives in fields, so the input may be cut anywhere, even between the two bytes of `--`
 * or inside a dollar-quote tag, and the resulting index is identical (the tests feed one byte at
 * a time). Every structural byte is ASCII, which never occurs inside a UTF-8 multi-byte sequence,
 * so the scanner works on raw bytes without decoding.
 *
 * Statements are contiguous ranges: each starts where the previous one ended, so leading
 * whitespace and comments belong to the statement that follows them. Ranges that hold no
 * statement (a stray `;`, trailing comments) are not indexed.
 *
 * Not handled, on purpose: `BEGIN ... END` bodies without a `DELIMITER` command (MySQL's own
 * command-line client cannot split those either), and PostgreSQL's `BEGIN ATOMIC` bodies.
 */
export class SqlScanner {
    readonly index = new RangeIndex();
    private readonly mysql: boolean;

    private state = NORMAL;
    private phase = BEFORE;
    private statementStart = 0;
    private scanned = 0;
    /** The last two bytes of ordinary text, for two-byte openers (`--`, `/*`) and `E'...'`. */
    private previous = 0;
    private beforePrevious = 0;
    private nesting = 0; // block comment depth (PostgreSQL nests)
    private escapes = false; // backslash escapes inside the current string

    private readonly word: number[] = [];
    private kind: StatementKindValue = StatementKind.Other;

    private delimiter = new Uint8Array([59]); // ';'
    private delimiterMatched = 0;
    private directive: number[] = [];

    private dollarTag: number[] = [];
    private dollarOpening: number[] = [];
    private dollarMatched = 0;

    constructor(
        readonly dialect: SqlDialect = 'mysql',
        private readonly onStatement?: StatementListener,
    ) {
        this.mysql = dialect === 'mysql';
    }

    /** Begins at a byte offset other than 0: the scan then covers a part of a file. */
    startAt(offset: number): void {
        this.statementStart = offset;
        this.scanned = offset;
    }

    /** Bytes consumed so far. */
    get bytesScanned(): number {
        return this.scanned;
    }

    /** Statements found so far. */
    get statementCount(): number {
        return this.index.count;
    }

    /** The delimiter currently in effect (`;` unless a `DELIMITER` command changed it). */
    get currentDelimiter(): string {
        return Buffer.from(this.delimiter).toString('latin1');
    }

    feed(data: Uint8Array, offset: number): void {
        const length = data.length;
        const buffer = Buffer.from(data.buffer, data.byteOffset, length);
        let i = 0;
        while (i < length) {
            switch (this.state) {
                case LINE_COMMENT: {
                    const found = buffer.indexOf(LF, i);
                    if (found === -1) {
                        i = length;
                    } else {
                        this.state = NORMAL;
                        this.push(LF);
                        i = found + 1;
                    }
                    continue;
                }
                case BLOCK_COMMENT:
                    i = this.skipBlockComment(buffer, i);
                    continue;
                case SQUOTE:
                case DQUOTE:
                case BTICK:
                    i = this.skipQuoted(buffer, i);
                    continue;
                case SQUOTE_END:
                case DQUOTE_END:
                case BTICK_END: {
                    const close =
                        this.state === SQUOTE_END ? 39 : this.state === DQUOTE_END ? 34 : 96;
                    if (buffer[i] === close) {
                        // A doubled quote: still inside the string.
                        this.state -= 5; // *_END → the matching quoted state
                        this.previous = 0;
                        i++;
                    } else {
                        this.state = NORMAL; // it closed; this byte is ordinary code
                    }
                    continue;
                }
                case DOLLAR:
                    i = this.skipDollarBody(buffer, i);
                    continue;
                case DOLLAR_TAG: {
                    const b = buffer[i]!;
                    if (b === 36) {
                        this.dollarOpening = [36, ...this.dollarTag, 36];
                        this.dollarMatched = 0;
                        this.state = DOLLAR;
                        i++;
                    } else if (
                        (this.dollarTag.length === 0 ? isWordStart(b) : isWordByte(b)) &&
                        this.dollarTag.length < 64
                    ) {
                        this.dollarTag.push(b);
                        i++;
                    } else {
                        this.state = NORMAL; // not a dollar quote (`$1`, or just a `$`)
                    }
                    continue;
                }
                case DASH_DASH:
                    // `--` opens a comment; in MySQL only when whitespace follows it.
                    this.state = !this.mysql || isSpace(buffer[i]!) ? LINE_COMMENT : NORMAL;
                    continue;
                case DELIM_DIRECTIVE: {
                    const found = buffer.indexOf(LF, i);
                    const end = found === -1 ? length : found;
                    for (let k = i; k < end && this.directive.length < MAX_DELIMITER + 8; k++) {
                        this.directive.push(buffer[k]!);
                    }
                    if (found === -1) {
                        i = length;
                    } else {
                        this.applyDirective(offset + found + 1);
                        i = found + 1;
                    }
                    continue;
                }
                case DELIM_MATCH: {
                    if (buffer[i] === this.delimiter[this.delimiterMatched]) {
                        i++;
                        if (++this.delimiterMatched === this.delimiter.length) {
                            this.state = NORMAL;
                            this.terminate(offset + i);
                        }
                    } else {
                        this.state = NORMAL; // not the delimiter after all; this byte is ordinary
                    }
                    continue;
                }
            }

            // NORMAL: ordinary SQL text.
            const b = buffer[i]!;
            if (this.phase === BEFORE) {
                if (isSpace(b)) {
                    this.push(b);
                    i++;
                    continue;
                }
                if (isWordStart(b)) {
                    this.phase = WORD;
                    this.word.length = 0;
                    this.word.push(upper(b));
                    this.push(b);
                    i++;
                    continue;
                }
                // Anything that can open a comment or end a statement is handled below without
                // starting one; every other byte starts a statement of no particular kind.
                if (!this.opensCommentOrEnds(b)) {
                    this.phase = INSIDE;
                    this.kind = b === 40 ? StatementKind.Select : StatementKind.Other;
                }
            } else if (this.phase === WORD) {
                if (isWordByte(b)) {
                    if (this.word.length < MAX_WORD) this.word.push(upper(b));
                    this.push(b);
                    i++;
                    continue;
                }
                this.finishWord();
                if (this.state !== NORMAL) continue; // a DELIMITER command took over
            } else {
                // Ordinary bytes cannot change anything: jump to the next one that might.
                const start = i;
                i = this.skipOrdinary(buffer, i);
                if (i > start) {
                    this.beforePrevious = i - start >= 2 ? buffer[i - 2]! : this.previous;
                    this.previous = buffer[i - 1]!;
                    if (i >= length) continue;
                }
            }

            this.dispatch(buffer[i]!, offset + i);
            i++;
        }
        this.scanned = offset + length;
    }

    /**
     * Ends the scan. A last statement with no terminator is still indexed, flagged as
     * unterminated, and flagged as an error too if the file ended inside a quote or comment.
     */
    finish(totalBytes: number): RangeIndex {
        if (this.state === DELIM_DIRECTIVE) {
            this.applyDirective(totalBytes);
        } else if (this.phase !== BEFORE) {
            if (this.phase === WORD) this.kind = kindFromKeyword(String.fromCharCode(...this.word));
            const inside =
                this.state === BLOCK_COMMENT ||
                this.state === SQUOTE ||
                this.state === DQUOTE ||
                this.state === BTICK ||
                this.state === DOLLAR;
            this.record(
                this.statementStart,
                totalBytes,
                this.kind | FLAG_UNTERMINATED | (inside ? FLAG_ERROR : 0),
            );
        }
        this.statementStart = totalBytes;
        this.phase = BEFORE;
        return this.index;
    }

    /** Adds a statement to the index and tells the listener. */
    private record(start: number, end: number, flags: number): void {
        this.index.add(start, end, flags);
        this.onStatement?.({ start, end, flags, delimiter: this.currentDelimiter });
    }

    private push(b: number): void {
        this.beforePrevious = this.previous;
        this.previous = b;
    }

    private opensCommentOrEnds(b: number): boolean {
        return (
            b === 45 || // -
            b === 47 || // /
            (b === 42 && this.previous === 47) || // the * of /*
            b === this.delimiter[0] ||
            (this.mysql && b === 35) // #
        );
    }

    /** Index of the next byte that could start a quote, comment, dollar quote or terminator. */
    private skipOrdinary(buffer: Buffer, from: number): number {
        const first = this.delimiter[0]!;
        const mysql = this.mysql;
        let j = from;
        for (; j < buffer.length; j++) {
            const c = buffer[j]!;
            if (c === first || c === 39 || c === 34 || c === 45 || c === 47 || c === 42) break;
            if (mysql ? c === 96 || c === 35 : c === 36) break;
        }
        return j;
    }

    private skipBlockComment(buffer: Buffer, from: number): number {
        let i = from;
        for (; i < buffer.length; i++) {
            const b = buffer[i]!;
            if (this.previous === 42 && b === 47) {
                this.previous = 0;
                if (--this.nesting === 0) {
                    this.state = NORMAL;
                    return i + 1;
                }
            } else if (!this.mysql && this.previous === 47 && b === 42) {
                this.previous = 0;
                this.nesting++;
            } else {
                this.previous = b;
            }
        }
        return i;
    }

    private skipQuoted(buffer: Buffer, from: number): number {
        const close = this.state === SQUOTE ? 39 : this.state === DQUOTE ? 34 : 96;
        const escapes = this.escapes && this.state !== BTICK;
        let i = from;
        for (; i < buffer.length; i++) {
            const b = buffer[i]!;
            if (this.previous === 92 && escapes) {
                this.previous = 0; // the byte after a backslash is literal, even a quote
            } else if (b === close) {
                this.state += 5; // quoted → the matching *_END state
                this.previous = b;
                return i + 1;
            } else {
                this.previous = b;
            }
        }
        return i;
    }

    private skipDollarBody(buffer: Buffer, from: number): number {
        const opening = this.dollarOpening;
        let i = from;
        for (; i < buffer.length; i++) {
            const b = buffer[i]!;
            if (b === opening[this.dollarMatched]) {
                if (++this.dollarMatched === opening.length) {
                    this.state = NORMAL;
                    this.previous = 36;
                    return i + 1;
                }
            } else {
                this.dollarMatched = b === 36 ? 1 : 0;
            }
        }
        return i;
    }

    private finishWord(): void {
        this.phase = INSIDE;
        this.kind = kindFromKeyword(String.fromCharCode(...this.word));
        if (this.mysql && this.kind === StatementKind.Delimiter) {
            // The rest of this line is the new delimiter.
            this.directive = [];
            this.state = DELIM_DIRECTIVE;
        }
    }

    /** Handles one byte of ordinary SQL text that may open a quote, comment or end a statement. */
    private dispatch(b: number, absolute: number): void {
        const previous = this.previous;
        const beforePrevious = this.beforePrevious;
        this.push(b);

        if (b === this.delimiter[0]) {
            if (this.delimiter.length === 1) {
                this.terminate(absolute + 1);
            } else {
                this.delimiterMatched = 1;
                this.state = DELIM_MATCH;
            }
            return;
        }
        switch (b) {
            case 39: // '
                this.state = SQUOTE;
                // PostgreSQL: backslashes escape only inside E'...' strings.
                this.escapes =
                    this.mysql ||
                    ((previous === 69 || previous === 101) && !isWordByte(beforePrevious));
                this.previous = 0;
                break;
            case 34: // "
                this.state = DQUOTE;
                this.escapes = this.mysql;
                this.previous = 0;
                break;
            case 96: // ` (MySQL identifiers)
                if (this.mysql) {
                    this.state = BTICK;
                    this.previous = 0;
                }
                break;
            case 45: // -
                if (previous === 45) {
                    this.state = DASH_DASH;
                    this.previous = 0;
                }
                break;
            case 35: // # (MySQL line comment)
                if (this.mysql) this.state = LINE_COMMENT;
                break;
            case 42: // *
                if (previous === 47) {
                    this.state = BLOCK_COMMENT;
                    this.nesting = 1;
                    this.previous = 0;
                }
                break;
            case 36: // $ (PostgreSQL dollar quoting; not part of an identifier or `$1`)
                if (!this.mysql && !isWordByte(previous)) {
                    this.state = DOLLAR_TAG;
                    this.dollarTag = [];
                }
                break;
        }
    }

    /** Closes the current statement at `end` (exclusive). */
    private terminate(end: number): void {
        // A terminator with nothing before it is stray: it stays in the next statement's range.
        if (this.phase !== BEFORE) {
            this.record(this.statementStart, end, this.kind);
            this.statementStart = end;
        }
        this.phase = BEFORE;
        this.word.length = 0;
        this.kind = StatementKind.Other;
    }

    private applyDirective(end: number): void {
        const text = Buffer.from(this.directive).toString('latin1').trim();
        // Only the first word is the delimiter; the rest of the line is ignored, as mysql does.
        const candidate = text.split(/\s+/)[0] ?? '';
        if (candidate.length > 0 && candidate.length <= MAX_DELIMITER) {
            this.delimiter = Uint8Array.from(Buffer.from(candidate, 'latin1'));
        }
        this.record(this.statementStart, end, StatementKind.Delimiter);
        this.statementStart = end;
        this.phase = BEFORE;
        this.state = NORMAL;
        this.kind = StatementKind.Other;
        this.directive = [];
    }
}
