/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { DbError } from '@httpreq/db-core';

/**
 * CSV (RFC 4180) read incrementally and written field by field.
 *
 * The parser is a state machine over text it is fed in pieces; a quoted field, a doubled quote or a
 * CRLF may be cut between two pieces and the records come out the same. It holds one record at a
 * time, never the file, and refuses a record larger than `maxRecordChars` (a quote that is never
 * closed would otherwise swallow the rest of the file into one field).
 */
export interface CsvRecordInfo {
    /** 1-based record number, counting the header. */
    record: number;
    /** The line the record starts on (1-based), counting lines inside quoted fields. */
    line: number;
    /** Bytes (UTF-8) of the input up to the end of this record's terminator. */
    byteEnd: number;
    /** The line the next record starts on. */
    nextLine: number;
}

export interface CsvParserOptions {
    delimiter?: string;
    quote?: string;
    maxRecordChars?: number;
    onRecord: (fields: string[], info: CsvRecordInfo) => void;
    /** Byte offset of the first text fed, line and record number likewise, when resuming. */
    startByte?: number;
    startLine?: number;
    startRecord?: number;
}

const FIELD_START = 0;
const UNQUOTED = 1;
const QUOTED = 2;
const QUOTE_IN_QUOTED = 3;

/** UTF-8 bytes of one UTF-16 code unit; a surrogate pair is two units of two bytes each. */
const utf8Units = (code: number): number =>
    code < 0x80 ? 1 : code < 0x800 ? 2 : code >= 0xd800 && code <= 0xdfff ? 2 : 3;

export class CsvParser {
    private readonly delimiter: string;
    private readonly quote: string;
    private readonly maxRecordChars: number;
    private readonly onRecord: CsvParserOptions['onRecord'];
    private state = FIELD_START;
    private fields: string[] = [];
    private field = '';
    private recordChars = 0;
    private pendingCr = false;
    /** Something (even an empty quoted field) has been read in the current record. */
    private started = false;
    private line: number;
    private recordLine: number;
    private record: number;
    private bytes: number;

    constructor(options: CsvParserOptions) {
        this.delimiter = options.delimiter ?? ',';
        this.quote = options.quote ?? '"';
        if (this.delimiter.length !== 1 || this.quote.length !== 1) {
            throw new DbError(
                'INVALID_REQUEST',
                'The delimiter and the quote must be single characters.',
            );
        }
        this.maxRecordChars = options.maxRecordChars ?? 16 * 1024 * 1024;
        this.onRecord = options.onRecord;
        this.line = options.startLine ?? 1;
        this.recordLine = this.line;
        this.record = options.startRecord ?? 1;
        this.bytes = options.startByte ?? 0;
    }

    feed(text: string): void {
        for (let i = 0; i < text.length; i++) {
            const c = text[i]!;
            this.bytes += utf8Units(text.charCodeAt(i));
            if (this.pendingCr) {
                this.pendingCr = false;
                // The \n of a \r\n ends the record that already ended at the \r.
                if (c === '\n') continue;
            }
            this.step(c);
            if (++this.recordChars > this.maxRecordChars) {
                throw new DbError(
                    'LIMIT_EXCEEDED',
                    `Record ${this.record} (line ${this.recordLine}) is larger than ${Math.round(this.maxRecordChars / 1048576)} MB. A quote may have been opened and never closed.`,
                );
            }
        }
    }

    private step(c: string): void {
        switch (this.state) {
            case QUOTED:
                if (c === this.quote) this.state = QUOTE_IN_QUOTED;
                else {
                    this.field += c;
                    if (c === '\n') this.line++;
                }
                return;
            case QUOTE_IN_QUOTED:
                if (c === this.quote) {
                    this.field += this.quote;
                    this.state = QUOTED;
                } else {
                    // The quoted part ended; what follows is handled as the rest of the field.
                    this.state = UNQUOTED;
                    this.step(c);
                }
                return;
            default:
                if (c === this.delimiter) {
                    this.fields.push(this.field);
                    this.field = '';
                    this.started = true;
                    this.state = FIELD_START;
                } else if (c === '\n' || c === '\r') {
                    this.endRecord(c === '\r');
                } else if (c === this.quote && this.state === FIELD_START) {
                    this.state = QUOTED;
                    this.started = true;
                } else {
                    this.field += c;
                    this.started = true;
                    this.state = UNQUOTED;
                }
        }
    }

    private endRecord(cr: boolean): void {
        this.line++;
        this.pendingCr = cr;
        const blank = !this.started && this.fields.length === 0 && this.field === '';
        if (!blank) this.deliver();
        this.recordLine = this.line;
        this.started = false;
        this.state = FIELD_START;
        this.recordChars = 0;
    }

    private deliver(): void {
        this.fields.push(this.field);
        this.field = '';
        const fields = this.fields;
        this.fields = [];
        const info: CsvRecordInfo = {
            record: this.record++,
            line: this.recordLine,
            byteEnd: this.bytes,
            nextLine: this.line,
        };
        this.onRecord(fields, info);
    }

    /** Ends the input: a last record with no line break is delivered. */
    finish(): void {
        if (this.state === QUOTED) {
            throw new DbError(
                'INVALID_REQUEST',
                `The file ends inside a quoted field that starts on line ${this.recordLine}.`,
            );
        }
        if (this.started || this.fields.length > 0 || this.field !== '') this.deliver();
        this.started = false;
        this.state = FIELD_START;
    }
}

/** Guesses the delimiter from the first lines: the one that splits them into the same number of fields. */
export const detectDelimiter = (sample: string): string => {
    const lines = sample
        .split(/\r?\n/)
        .filter((line) => line.length > 0)
        .slice(0, 10);
    let best = ',';
    let bestScore = -1;
    for (const candidate of [',', ';', '\t', '|']) {
        const counts = lines.map((line) => {
            let count = 0;
            let quoted = false;
            for (const char of line) {
                if (char === '"') quoted = !quoted;
                else if (char === candidate && !quoted) count++;
            }
            return count;
        });
        if (counts.length === 0 || counts[0] === 0) continue;
        const consistent = counts.every((count) => count === counts[0]);
        const score = (consistent ? 1000 : 0) + counts[0]!;
        if (score > bestScore) {
            bestScore = score;
            best = candidate;
        }
    }
    return best;
};

/** One field as it must be written: quoted when it holds the delimiter, a quote or a line break. */
export const csvField = (text: string, delimiter = ','): string =>
    text.includes(delimiter) ||
    text.includes('"') ||
    text.includes('\n') ||
    text.includes('\r') ||
    text !== text.trim()
        ? `"${text.replace(/"/g, '""')}"`
        : text;

export const csvLine = (fields: string[], delimiter = ',', eol = '\r\n'): string =>
    `${fields.map((f) => csvField(f, delimiter)).join(delimiter)}${eol}`;
