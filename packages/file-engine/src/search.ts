/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { DbError, throwIfAborted } from '@httpreq/db-core';
import type { ChunkReader } from './reader';

export interface SearchQuery {
    text: string;
    caseSensitive?: boolean;
    /** Treat `text` as a JavaScript regular expression, matched line by line. */
    regex?: boolean;
    /** Only match whole words (letters, digits and underscore are word characters). */
    wholeWord?: boolean;
}

export interface SearchHit {
    /** Byte offset of the match in the file. */
    offset: number;
    /** Zero-based line number. */
    line: number;
    /** Length of the match in bytes. */
    length: number;
    /** The line around the match, cut to a short window. */
    preview: string;
    /** Where the match starts within `preview`, in characters. */
    previewStart: number;
}

export interface SearchProgress {
    bytesRead: number;
    totalBytes: number;
    hits: number;
}

export interface SearchOptions {
    signal?: AbortSignal;
    /** Stops after this many hits and reports `truncated`. */
    maxHits?: number;
    chunkSize?: number;
    /** Receives hits in batches, in file order, while the scan is still running. */
    onHits: (hits: SearchHit[]) => void;
    onProgress?: (progress: SearchProgress) => void;
    /** How often a partial batch or progress report is flushed. */
    flushMs?: number;
}

export interface SearchResult {
    hits: number;
    /** The scan stopped at `maxHits`; there are more matches. */
    truncated: boolean;
}

const DEFAULT_MAX_HITS = 100_000;
const MAX_PATTERN_CHARS = 1_000;
const MAX_BATCH = 500;
/** A regex line longer than this is split, so one huge line cannot grow memory without bound. */
const MAX_CARRY_BYTES = 4 * 1024 * 1024;
const PREVIEW_BEFORE = 60;
const PREVIEW_AFTER = 140;
const LF = 10;

const isWordByte = (b: number | undefined) =>
    b !== undefined &&
    ((b >= 48 && b <= 57) || (b >= 65 && b <= 90) || b === 95 || (b >= 97 && b <= 122) || b >= 128);

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Scans a file for a pattern in bounded chunks, emitting matches as they are found.
 *
 * Plain searches work on bytes with no decoding (`Buffer.indexOf`), so they run at memory speed.
 * Regular expressions need text, so they run over whole lines decoded from UTF-8; a match
 * therefore never spans a line break boundary the file does not already contain within one block,
 * and `^`/`$` match at line starts and ends. Case-insensitive plain search folds ASCII letters
 * only; a needle containing other letters is handled as an escaped regular expression instead.
 *
 * The scan holds one chunk, a short tail carried between chunks (so a match that straddles a
 * chunk boundary is found exactly once) and one batch of hits, whatever the file's size.
 */
export const searchFile = async (
    reader: ChunkReader,
    query: SearchQuery,
    options: SearchOptions,
): Promise<SearchResult> => {
    if (typeof query.text !== 'string' || query.text.length === 0) {
        throw new DbError('INVALID_REQUEST', 'Enter something to search for.');
    }
    if (query.text.length > MAX_PATTERN_CHARS) {
        throw new DbError('INVALID_REQUEST', 'The search text is too long.');
    }
    const ascii = [...query.text].every((character) => character.charCodeAt(0) < 128);
    const useRegex = !!query.regex || (!query.caseSensitive && !ascii);
    const pattern = useRegex ? compileSearch(query) : null;
    const state = new Emitter(options);

    if (pattern) await scanRegex(reader, pattern, options, state);
    else await scanBytes(reader, query, options, state);

    state.flush(reader.size);
    return { hits: state.total, truncated: state.truncated };
};

/** The regular expression a query stands for; also used by replace so both agree on matches. */
export const compileSearch = (query: SearchQuery): RegExp => {
    let source = query.regex ? query.text : escapeRegex(query.text);
    if (query.wholeWord) source = `(?<![\\p{L}\\p{N}_])(?:${source})(?![\\p{L}\\p{N}_])`;
    try {
        return new RegExp(source, `gmu${query.caseSensitive ? '' : 'i'}`);
    } catch {
        throw new DbError('INVALID_REQUEST', 'That is not a valid regular expression.');
    }
};

/** Batches hits and progress reports, and enforces the hit cap. */
class Emitter {
    total = 0;
    truncated = false;
    private batch: SearchHit[] = [];
    private last = Date.now();
    private readonly max: number;

    constructor(private readonly options: SearchOptions) {
        this.max = options.maxHits ?? DEFAULT_MAX_HITS;
    }

    /** Whether the cap has been reached. */
    get full(): boolean {
        return this.total >= this.max;
    }

    add(hit: SearchHit): boolean {
        if (this.total >= this.max) {
            this.truncated = true;
            return false;
        }
        this.batch.push(hit);
        this.total++;
        if (this.batch.length >= MAX_BATCH) this.send();
        return true;
    }

    /** Called after each chunk: flushes on the timer, so hits appear while the scan runs. */
    tick(bytesRead: number, totalBytes: number): void {
        const now = Date.now();
        if (now - this.last < (this.options.flushMs ?? 100)) return;
        this.last = now;
        this.send();
        this.options.onProgress?.({ bytesRead, totalBytes, hits: this.total });
    }

    flush(totalBytes: number): void {
        this.send();
        this.options.onProgress?.({ bytesRead: totalBytes, totalBytes, hits: this.total });
    }

    private send(): void {
        if (this.batch.length === 0) return;
        const out = this.batch;
        this.batch = [];
        this.options.onHits(out);
    }
}

/** The line containing `index` in `bytes`, cut around the match. */
const previewOf = (
    bytes: Uint8Array,
    index: number,
    length: number,
): { text: string; start: number } => {
    const from = Math.max(0, index - PREVIEW_BEFORE);
    const to = Math.min(bytes.length, index + length + PREVIEW_AFTER);
    let start = from;
    for (let i = index - 1; i >= from; i--) {
        if (bytes[i] === LF) {
            start = i + 1;
            break;
        }
    }
    let end = to;
    for (let i = index + length; i < to; i++) {
        if (bytes[i] === LF) {
            end = i;
            break;
        }
    }
    const before = new TextDecoder().decode(bytes.subarray(start, index));
    const text = new TextDecoder().decode(bytes.subarray(start, end)).replace(/\r$/, '');
    return { text, start: before.length };
};

/** Plain and ASCII case-insensitive search, directly on bytes. */
const scanBytes = async (
    reader: ChunkReader,
    query: SearchQuery,
    options: SearchOptions,
    emitter: Emitter,
): Promise<void> => {
    const fold = !query.caseSensitive;
    const needle = Buffer.from(fold ? query.text.toLowerCase() : query.text, 'utf8');
    // Enough carry for a whole match plus the byte before it (the word-boundary check).
    const keep = needle.length + 1;
    let tail: Buffer = Buffer.alloc(0);
    let tailOffset = 0; // file offset of tail[0]
    let line = 0; // newlines before tail[0]
    let nextAllowed = 0; // matches may not start before this file offset

    for await (const chunk of reader.chunks({
        signal: options.signal,
        chunkSize: options.chunkSize,
    })) {
        const incoming = Buffer.from(chunk.data.buffer, chunk.data.byteOffset, chunk.data.length);
        const window = tail.length > 0 ? Buffer.concat([tail, incoming]) : Buffer.from(incoming);
        const base = tailOffset; // file offset of window[0]
        const atEnd = chunk.offset + chunk.data.length >= reader.size;
        // A whole-word match needs to see the byte after it, so the last byte waits for the
        // next chunk (unless this is the last chunk).
        const searchEnd = query.wholeWord && !atEnd ? window.length - 1 : window.length;
        const haystack = fold ? lowerAscii(window) : window;

        let from = Math.max(0, nextAllowed - base);
        let lineAt = line;
        // The next newline in the window, found once and advanced only when a hit passes it. Looking
        // it up per hit would rescan a window that has no newline at all for every hit.
        let nextLf = window.indexOf(LF);
        for (;;) {
            const found = haystack.indexOf(needle, from);
            if (found === -1 || found + needle.length > searchEnd) break;
            from = found + needle.length;
            // A match at the very start of a later window has lost its preceding byte. It was
            // already judged, with that byte, in the previous window, so it is not judged again.
            if (query.wholeWord && found === 0 && base > 0) {
                from = 1;
                continue;
            }
            if (
                query.wholeWord &&
                (isWordByte(found > 0 ? window[found - 1] : undefined) ||
                    isWordByte(window[found + needle.length]))
            ) {
                from = found + 1;
                continue;
            }
            // Count the newlines between the last hit and this one to get the line number.
            while (nextLf !== -1 && nextLf < found) {
                lineAt++;
                nextLf = window.indexOf(LF, nextLf + 1);
            }
            const { text, start } = previewOf(window, found, needle.length);
            const accepted = emitter.add({
                offset: base + found,
                line: lineAt,
                length: needle.length,
                preview: text,
                previewStart: start,
            });
            nextAllowed = base + found + needle.length;
            if (!accepted) return;
        }

        // Carry the end of the window forward, and the line count up to where the carry begins.
        const carryFrom = Math.max(0, window.length - keep);
        for (
            let at = window.indexOf(LF);
            at !== -1 && at < carryFrom;
            at = window.indexOf(LF, at + 1)
        )
            line++;
        tail = Buffer.from(window.subarray(carryFrom));
        tailOffset = base + carryFrom;
        emitter.tick(chunk.offset + chunk.data.length, reader.size);
        throwIfAborted(options.signal);
    }
};

const lowerAscii = (bytes: Buffer): Buffer => {
    const out = Buffer.allocUnsafe(bytes.length);
    for (let i = 0; i < bytes.length; i++) {
        const b = bytes[i]!;
        out[i] = b >= 65 && b <= 90 ? b + 32 : b;
    }
    return out;
};

/** Regular-expression search over blocks of whole lines. */
const scanRegex = async (
    reader: ChunkReader,
    pattern: RegExp,
    options: SearchOptions,
    emitter: Emitter,
): Promise<void> => {
    let carry: Buffer = Buffer.alloc(0);
    let carryOffset = 0; // file offset of carry[0]
    let line = 0; // newlines before carry[0]

    const searchBlock = (block: Buffer, blockOffset: number): boolean => {
        const text = block.toString('utf8');
        pattern.lastIndex = 0;
        let characters = 0; // characters of `text` already converted to bytes
        let bytes = 0;
        let lineAt = line;
        let nextNl = text.indexOf('\n');
        for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
            if (match[0].length === 0) {
                pattern.lastIndex++;
                continue;
            }
            bytes += Buffer.byteLength(text.slice(characters, match.index));
            characters = match.index;
            while (nextNl !== -1 && nextNl < match.index) {
                lineAt++;
                nextNl = text.indexOf('\n', nextNl + 1);
            }
            // Only the preview window is searched for line breaks, however long the line is.
            const windowStart = Math.max(0, match.index - PREVIEW_BEFORE);
            const windowEnd = Math.min(text.length, match.index + match[0].length + PREVIEW_AFTER);
            const before = text.slice(windowStart, match.index).lastIndexOf('\n');
            const from = before >= 0 ? windowStart + before + 1 : windowStart;
            const after = text.slice(match.index, windowEnd).indexOf('\n');
            const to = after >= 0 ? match.index + after : windowEnd;
            const accepted = emitter.add({
                offset: blockOffset + bytes,
                line: lineAt,
                length: Buffer.byteLength(match[0]),
                preview: text.slice(from, to).replace(/\r$/, ''),
                previewStart: match.index - from,
            });
            if (!accepted) return false;
        }
        return true;
    };

    const countLines = (block: Buffer) => {
        let count = 0;
        for (let at = block.indexOf(LF); at !== -1; at = block.indexOf(LF, at + 1)) count++;
        return count;
    };

    for await (const chunk of reader.chunks({
        signal: options.signal,
        chunkSize: options.chunkSize,
    })) {
        const incoming = Buffer.from(chunk.data.buffer, chunk.data.byteOffset, chunk.data.length);
        const joined = carry.length > 0 ? Buffer.concat([carry, incoming]) : Buffer.from(incoming);
        const cut = joined.lastIndexOf(LF);
        // Search up to the last complete line; an oversized unterminated line is searched as is.
        const searchTo =
            cut === -1 ? (joined.length > MAX_CARRY_BYTES ? joined.length : 0) : cut + 1;
        if (searchTo > 0) {
            const block = joined.subarray(0, searchTo);
            if (!searchBlock(block, carryOffset)) return;
            line += countLines(block);
            carryOffset += searchTo;
        }
        carry = Buffer.from(joined.subarray(searchTo));
        emitter.tick(chunk.offset + chunk.data.length, reader.size);
        throwIfAborted(options.signal);
    }
    if (carry.length > 0) searchBlock(carry, carryOffset);
};
