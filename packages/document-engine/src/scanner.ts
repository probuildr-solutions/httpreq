/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { RangeIndex } from '@httpreq/db-core';

/**
 * How the documents of a file are laid out.
 *
 * - `jsonl`: one document per line (JSON Lines, NDJSON, `mongoexport` without `--jsonArray`).
 * - `array`: one top-level JSON array whose elements are the documents (`--jsonArray`).
 * - `sequence`: top-level values one after another, in any layout; this is also how a single
 *   pretty-printed document is read.
 */
export type JsonFormat = 'jsonl' | 'array' | 'sequence';

/** The content at this range is not well-formed; it was skipped. */
export const DOC_ERROR = 0b01;
/** The file ended in the middle of this document. */
export const DOC_TRUNCATED = 0b10;

const LF = 10;
const MAX_DEPTH = 4096;

const isSpace = (b: number) => b === 32 || b === 9 || b === 10 || b === 13;

/**
 * Guesses the layout from the start of the file. `hint` is the file extension, which decides the
 * unambiguous cases (`.jsonl`, `.ndjson`).
 */
export const detectJsonFormat = (head: Uint8Array, hint?: string): JsonFormat => {
    const extension = hint?.toLowerCase().replace(/^\./, '');
    if (extension === 'jsonl' || extension === 'ndjson') return 'jsonl';
    let i = 0;
    // A UTF-8 byte order mark.
    if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) i = 3;
    while (i < head.length && isSpace(head[i]!)) i++;
    if (head[i] === 91) return 'array'; // [
    if (head[i] !== 123) return 'sequence'; // not an object: let the scanner report it
    // An object: JSON Lines if the first line is itself a complete object.
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (; i < head.length; i++) {
        const b = head[i]!;
        if (inString) {
            if (escaped) escaped = false;
            else if (b === 92) escaped = true;
            else if (b === 34) inString = false;
        } else if (b === 34) inString = true;
        else if (b === 123 || b === 91) depth++;
        else if (b === 125 || b === 93) depth--;
        else if (b === LF && depth === 0) return 'jsonl';
        else if (b === LF) return 'sequence'; // a newline inside the first object
    }
    return 'jsonl';
};

/* Array / sequence scanner states. */
const BETWEEN = 0; // between elements
const IN_STRING = 1; // inside a string that is itself the element or part of one
const IN_CONTAINER = 2; // inside an object or array element
const IN_SCALAR = 3; // a number, true, false or null
const SKIPPING = 4; // recovering from malformed content
const DONE = 5; // after the closing `]`

/**
 * Finds the byte range of every document in a file, incrementally.
 *
 * It never builds the documents: it tracks just enough (string and escape state, bracket depth
 * and type) to know where each top-level value starts and ends, and records `(start, end)`. A
 * document is parsed later, only when something needs it. State is held in fields, so the input
 * may be cut anywhere and the result is identical (tested with one-byte chunks).
 *
 * Malformed content does not stop the scan. The damaged element is recorded with `DOC_ERROR` and
 * the scanner skips ahead to the next line that starts a new value, so one bad document in a
 * 10-million-document export costs one entry. This resynchronisation is a heuristic: it assumes a
 * damaged element ends by the end of its line, which holds for tool-written exports but not for
 * arbitrary hand-edited JSON.
 */
export class JsonDocumentScanner {
    readonly index = new RangeIndex();

    private scanned = 0;

    // jsonl
    private lineStart = 0;
    private contentStart = -1;
    private contentEnd = 0;

    // array / sequence
    private state = BETWEEN;
    private started = false; // the opening `[` of an array has been seen
    private elementStart = 0;
    private depth = 0;
    private readonly stack = new Uint8Array(MAX_DEPTH); // 1 = object, 2 = array
    private escaped = false;
    private stringIsElement = false;
    private sawNewline = false;

    constructor(readonly format: JsonFormat) {}

    get bytesScanned(): number {
        return this.scanned;
    }

    get documentCount(): number {
        return this.index.count;
    }

    feed(data: Uint8Array, offset: number): void {
        const buffer = Buffer.from(data.buffer, data.byteOffset, data.length);
        if (this.format === 'jsonl') this.feedLines(buffer, offset);
        else this.feedValues(buffer, offset);
        this.scanned = offset + buffer.length;
    }

    finish(totalBytes: number): RangeIndex {
        if (this.format === 'jsonl') {
            if (this.contentStart >= 0) this.index.add(this.contentStart, this.contentEnd, 0);
        } else if (
            this.state === IN_STRING ||
            this.state === IN_CONTAINER ||
            this.state === IN_SCALAR
        ) {
            // The file ended inside a document. A bare scalar is complete; anything else is cut.
            this.index.add(
                this.elementStart,
                totalBytes,
                this.state === IN_SCALAR ? 0 : DOC_ERROR | DOC_TRUNCATED,
            );
        }
        return this.index;
    }

    /* ---------- JSON Lines ---------- */

    private feedLines(buffer: Buffer, offset: number): void {
        let position = 0;
        while (position < buffer.length) {
            const found = buffer.indexOf(LF, position);
            const end = found === -1 ? buffer.length : found;
            this.takeLinePart(buffer, position, end, offset);
            if (found === -1) return;
            if (this.contentStart >= 0) this.index.add(this.contentStart, this.contentEnd, 0);
            this.contentStart = -1;
            position = found + 1;
        }
    }

    /** Folds the part of a line that lies in this chunk into the line's content range. */
    private takeLinePart(buffer: Buffer, from: number, to: number, offset: number): void {
        let first = from;
        if (this.contentStart < 0) {
            while (first < to && isSpace(buffer[first]!)) first++;
            if (first === to) return; // nothing but whitespace so far
            this.contentStart = offset + first;
        }
        let last = to;
        while (last > first && isSpace(buffer[last - 1]!)) last--;
        if (last > first) this.contentEnd = offset + last;
    }

    /* ---------- array and sequence ---------- */

    private feedValues(buffer: Buffer, offset: number): void {
        const length = buffer.length;
        let i = 0;
        while (i < length) {
            const b = buffer[i]!;
            switch (this.state) {
                case DONE:
                    i++; // anything after the closing bracket is ignored
                    break;

                case SKIPPING:
                    if (b === LF) {
                        this.sawNewline = true;
                    } else if (!isSpace(b) && b !== 44) {
                        // The first value-opening byte on a new line starts the next element.
                        if (this.sawNewline && (b === 123 || b === 91)) {
                            this.sawNewline = false;
                            this.state = BETWEEN;
                            continue;
                        }
                        this.sawNewline = false;
                    }
                    i++;
                    break;

                case BETWEEN:
                    i = this.between(buffer, i, offset);
                    break;

                case IN_STRING:
                    i = this.inString(buffer, i, offset);
                    break;

                case IN_SCALAR:
                    if (isSpace(b) || b === 44 || b === 93 || b === 125) {
                        this.index.add(this.elementStart, offset + i, 0);
                        this.state = BETWEEN;
                    } else {
                        i++;
                    }
                    break;

                case IN_CONTAINER:
                    i = this.inContainer(buffer, i, offset);
                    break;
            }
        }
    }

    private between(buffer: Buffer, from: number, offset: number): number {
        let i = from;
        const length = buffer.length;
        while (i < length) {
            const b = buffer[i]!;
            if (isSpace(b) || b === 44) {
                i++;
                continue;
            }
            if (this.format === 'array' && !this.started) {
                // Skip a BOM, then expect the opening bracket.
                if (b === 0xef || b === 0xbb || b === 0xbf) {
                    i++;
                    continue;
                }
                if (b === 91) {
                    this.started = true;
                    i++;
                    continue;
                }
                this.fail(offset + i, offset + i + 1);
                return i + 1;
            }
            if (b === 93 && this.format === 'array') {
                this.state = DONE;
                return i + 1;
            }
            this.elementStart = offset + i;
            if (b === 123 || b === 91) {
                this.stack[0] = b === 123 ? 1 : 2;
                this.depth = 1;
                this.state = IN_CONTAINER;
                return i + 1;
            }
            if (b === 34) {
                this.state = IN_STRING;
                this.stringIsElement = true;
                this.escaped = false;
                return i + 1;
            }
            if (b === 125 || b === 93 || b === 58) {
                this.fail(offset + i, offset + i + 1);
                return i + 1;
            }
            this.state = IN_SCALAR;
            return i + 1;
        }
        return i;
    }

    private inString(buffer: Buffer, from: number, offset: number): number {
        let i = from;
        const length = buffer.length;
        for (; i < length; i++) {
            const b = buffer[i]!;
            if (this.escaped) this.escaped = false;
            else if (b === 92) this.escaped = true;
            else if (b === 34) {
                i++;
                if (this.stringIsElement) {
                    this.index.add(this.elementStart, offset + i, 0);
                    this.state = BETWEEN;
                } else {
                    this.state = IN_CONTAINER;
                }
                return i;
            }
        }
        return i;
    }

    private inContainer(buffer: Buffer, from: number, offset: number): number {
        let i = from;
        const length = buffer.length;
        for (; i < length; i++) {
            const b = buffer[i]!;
            if (b === 34) {
                this.state = IN_STRING;
                this.stringIsElement = false;
                this.escaped = false;
                return i + 1;
            }
            if (b === 123 || b === 91) {
                if (this.depth >= MAX_DEPTH) {
                    this.fail(this.elementStart, offset + i + 1);
                    return i + 1;
                }
                this.stack[this.depth++] = b === 123 ? 1 : 2;
            } else if (b === 125 || b === 93) {
                const expected = this.stack[this.depth - 1];
                if ((b === 125 && expected !== 1) || (b === 93 && expected !== 2)) {
                    this.fail(this.elementStart, offset + i + 1);
                    return i + 1;
                }
                if (--this.depth === 0) {
                    this.index.add(this.elementStart, offset + i + 1, 0);
                    this.state = BETWEEN;
                    return i + 1;
                }
            }
        }
        return i;
    }

    /** Records the damaged element and skips to the next line that begins a value. */
    private fail(start: number, end: number): void {
        this.index.add(start, end, DOC_ERROR);
        this.depth = 0;
        this.escaped = false;
        this.sawNewline = false;
        this.state = SKIPPING;
    }
}
