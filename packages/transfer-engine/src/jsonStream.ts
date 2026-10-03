/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { DbError } from '@httpreq/db-core';
import type { JsonFormat } from '@httpreq/document-engine';

/**
 * The documents of a JSON file, one at a time, as text.
 *
 * `[ {…}, {…}, … ]`, JSON Lines and a sequence of values all come out the same way: each element is
 * cut out as it completes and handed over, so a 10 GB `mongoexport` array is never a 10 GB string
 * and never one `JSON.parse`. Elements are found by tracking strings, escapes and bracket depth
 * only; whether an element is valid JSON is for the consumer to find out when it parses that one
 * element, and a bad one costs that element, not the file.
 */
export interface JsonDocumentInfo {
    /** 1-based number of the element in the file. */
    index: number;
    /** Line the element starts on (1-based). */
    line: number;
    /** Offset after the element (after its line break, for JSON Lines). */
    byteEnd: number;
}

export interface JsonStreamOptions {
    format: JsonFormat;
    onDocument: (text: string, info: JsonDocumentInfo) => void;
    /** Longest single element accepted. */
    maxDocumentBytes?: number;
    /** Offset, line and element number of the first byte fed, when resuming JSON Lines. */
    startByte?: number;
    startLine?: number;
    startIndex?: number;
}

const BETWEEN = 0;
const IN_STRING = 1;
const IN_CONTAINER = 2;
const IN_SCALAR = 3;
const DONE = 4;

const isSpace = (b: number) => b === 32 || b === 9 || b === 10 || b === 13;
const LF = 10;

export class JsonDocumentStream {
    private readonly format: JsonFormat;
    private readonly onDocument: JsonStreamOptions['onDocument'];
    private readonly maxBytes: number;
    private offset: number;
    private line: number;
    private index: number;

    // The element being collected.
    private pieces: Buffer[] = [];
    private size = 0;
    private elementLine = 1;

    // array / sequence
    private state = BETWEEN;
    private opened = false;
    private depth = 0;
    private escaped = false;
    private inString = false;
    private stringIsElement = false;

    constructor(options: JsonStreamOptions) {
        this.format = options.format;
        this.onDocument = options.onDocument;
        this.maxBytes = options.maxDocumentBytes ?? 64 * 1024 * 1024;
        this.offset = options.startByte ?? 0;
        this.line = options.startLine ?? 1;
        this.index = options.startIndex ?? 1;
    }

    feed(chunk: Uint8Array): void {
        const data = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.length);
        if (this.format === 'jsonl') this.feedLines(data);
        else this.feedValues(data);
        this.offset += data.length;
    }

    finish(): void {
        if (this.format === 'jsonl') {
            this.emitLine(this.offset);
            return;
        }
        if (this.state === IN_SCALAR) this.emit(this.offset);
        else if (this.state === IN_CONTAINER || this.state === IN_STRING) {
            throw new DbError(
                'INVALID_REQUEST',
                `The file ends in the middle of element ${this.index} (line ${this.elementLine}).`,
            );
        }
    }

    /* ---------- JSON Lines ---------- */

    private feedLines(data: Buffer): void {
        let start = 0;
        for (let at = data.indexOf(LF); at !== -1; at = data.indexOf(LF, start)) {
            this.add(data.subarray(start, at));
            this.emitLine(this.offset + at + 1);
            this.line++;
            start = at + 1;
        }
        this.add(data.subarray(start));
    }

    private add(part: Buffer): void {
        if (part.length === 0) return;
        if (this.size === 0) this.elementLine = this.line;
        this.size += part.length;
        if (this.size > this.maxBytes) {
            throw new DbError(
                'LIMIT_EXCEEDED',
                `Element ${this.index} (line ${this.elementLine}) is larger than ${Math.round(this.maxBytes / 1048576)} MB.`,
            );
        }
        // The chunk buffer is reused by the reader; keep our own copy of the part.
        this.pieces.push(Buffer.from(part));
    }

    private emitLine(byteEnd: number): void {
        if (this.size === 0) return;
        let text = Buffer.concat(this.pieces, this.size).toString('utf8');
        this.pieces = [];
        this.size = 0;
        if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
        text = text.replace(/\r$/, '');
        if (text.trim() === '') return;
        this.onDocument(text, { index: this.index++, line: this.elementLine, byteEnd });
    }

    /* ---------- Arrays and sequences ---------- */

    private begin(byteIndex: number): void {
        this.pieces = [];
        this.size = 0;
        this.elementLine = this.line;
        this.elementStartOffset = this.offset + byteIndex;
    }

    private elementStartOffset = 0;
    private partStart = 0;

    private keep(data: Buffer, to: number): void {
        if (to <= this.partStart) return;
        const part = data.subarray(this.partStart, to);
        this.size += part.length;
        if (this.size > this.maxBytes) {
            throw new DbError(
                'LIMIT_EXCEEDED',
                `Element ${this.index} (line ${this.elementLine}) is larger than ${Math.round(this.maxBytes / 1048576)} MB.`,
            );
        }
        this.pieces.push(Buffer.from(part));
    }

    private emit(byteEnd: number): void {
        const text = Buffer.concat(this.pieces, this.size).toString('utf8');
        this.pieces = [];
        this.size = 0;
        this.onDocument(text, { index: this.index++, line: this.elementLine, byteEnd });
        this.state = BETWEEN;
    }

    private feedValues(data: Buffer): void {
        this.partStart = 0;
        let i = 0;
        // A byte order mark at the very start.
        if (this.offset === 0 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) i = 3;
        for (; i < data.length; i++) {
            const b = data[i]!;
            if (b === LF) this.line++;
            switch (this.state) {
                case BETWEEN:
                    if (isSpace(b) || b === 44 /* , */) break;
                    if (this.format === 'array' && !this.opened) {
                        if (b === 91 /* [ */) this.opened = true;
                        else
                            throw new DbError(
                                'INVALID_REQUEST',
                                'The file does not start with [ as a JSON array does.',
                            );
                        break;
                    }
                    if (this.format === 'array' && b === 93 /* ] */) {
                        this.state = DONE;
                        break;
                    }
                    this.begin(i);
                    this.partStart = i;
                    this.depth = 0;
                    this.escaped = false;
                    if (b === 123 || b === 91) {
                        this.state = IN_CONTAINER;
                        this.depth = 1;
                        this.inString = false;
                    } else if (b === 34) {
                        this.state = IN_STRING;
                        this.stringIsElement = true;
                    } else this.state = IN_SCALAR;
                    break;
                case IN_STRING:
                    if (this.escaped) this.escaped = false;
                    else if (b === 92) this.escaped = true;
                    else if (b === 34) {
                        if (this.stringIsElement) {
                            this.keep(data, i + 1);
                            this.partStart = i + 1;
                            this.emit(this.offset + i + 1);
                        } else this.state = IN_CONTAINER;
                    }
                    break;
                case IN_CONTAINER:
                    if (this.inString) {
                        if (this.escaped) this.escaped = false;
                        else if (b === 92) this.escaped = true;
                        else if (b === 34) this.inString = false;
                    } else if (b === 34) this.inString = true;
                    else if (b === 123 || b === 91) this.depth++;
                    else if (b === 125 || b === 93) {
                        if (--this.depth === 0) {
                            this.keep(data, i + 1);
                            this.partStart = i + 1;
                            this.emit(this.offset + i + 1);
                        }
                    }
                    break;
                case IN_SCALAR:
                    if (isSpace(b) || b === 44 || b === 93) {
                        this.keep(data, i);
                        this.partStart = i;
                        this.emit(this.offset + i);
                        if (b === 93 && this.format === 'array') this.state = DONE;
                    }
                    break;
                default:
                    // After the closing ] only whitespace may follow.
                    if (!isSpace(b))
                        throw new DbError(
                            'INVALID_REQUEST',
                            'There is text after the end of the JSON array.',
                        );
            }
        }
        // An element that continues into the next chunk keeps what has been seen of it.
        if (this.state === IN_STRING || this.state === IN_CONTAINER || this.state === IN_SCALAR) {
            this.keep(data, data.length);
        }
    }
}
