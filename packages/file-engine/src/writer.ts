/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { chmod, open, rename, rm, stat, type FileHandle } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { DbError, throwIfAborted, toDbError } from '@httpreq/db-core';
import type { IndexView } from './lineIndex';
import type { ChunkReader } from './reader';

/** A run of lines of the document being saved. */
export type SavePiece =
    { kind: 'original'; from: number; count: number } | { kind: 'added'; lines: string[] };

export type LineEnding = '\n' | '\r\n';

const FLUSH_CHARS = 64 * 1024;

/**
 * Byte offset where `line` starts. Reads at most one checkpoint interval of lines (a few hundred
 * kilobytes), using the sparse index to get close first. A line past the end is the file's size.
 */
export const lineByteOffset = async (
    reader: ChunkReader,
    view: IndexView,
    line: number,
    signal?: AbortSignal,
): Promise<number> => {
    if (line <= 0) return 0;
    if (line >= view.lineCount) return reader.size;
    const checkpoint = Math.floor(line / view.interval);
    let remaining = line - checkpoint * view.interval;
    const start = view.checkpoints[checkpoint] ?? 0;
    if (remaining === 0) return start;
    for await (const chunk of reader.chunks({ start, end: view.scannedBytes, signal })) {
        const bytes = Buffer.from(chunk.data.buffer, chunk.data.byteOffset, chunk.data.length);
        for (let at = bytes.indexOf(10); at !== -1; at = bytes.indexOf(10, at + 1)) {
            if (--remaining === 0) return chunk.offset + at + 1;
        }
    }
    return reader.size;
};

/** The line ending the file uses, judged by its first line break. */
export const detectLineEnding = async (reader: ChunkReader): Promise<LineEnding> => {
    const head = await reader.readRange(0, 64 * 1024);
    const at = head.indexOf(10);
    return at > 0 && head[at - 1] === 13 ? '\r\n' : '\n';
};

export interface WriteOptions {
    signal?: AbortSignal;
    /** Called with the number of bytes written so far. */
    onProgress?: (bytesWritten: number) => void;
    /**
     * Called once everything is written and before the new file replaces the target. Windows will
     * not replace a file that is still open, so a caller saving over the file it is reading
     * releases its reader here.
     */
    beforeReplace?: () => Promise<void>;
}

/**
 * Writes `pieces` as a new file at `target`, then replaces `target` with it atomically.
 *
 * The original file is read in chunks and copied byte for byte, so its encoding, byte order mark
 * and line endings survive exactly in every part the user did not touch; added lines are written
 * with `eol`. Memory use is one chunk plus a 64 KiB text buffer, whatever the file's size. The
 * data goes to a temporary file in the same folder, is flushed to disk, and only then renamed over
 * the target, so a crash or a full disk leaves the old file intact.
 *
 * Document lines are separated by one line ending: an original run that ends at the end of the
 * file has none after it, and one is supplied when more lines follow.
 */
export const writePieces = async (
    reader: ChunkReader,
    view: IndexView,
    pieces: readonly SavePiece[],
    target: string,
    eol: LineEnding,
    options: WriteOptions = {},
): Promise<{ bytes: number }> => {
    if (!view.complete) {
        throw new DbError(
            'INVALID_REQUEST',
            'The file is still being indexed. Try again in a moment.',
        );
    }
    const temporary = `${target}.${randomBytes(4).toString('hex')}.hrsave`;
    let handle: FileHandle | undefined;
    let written = 0;
    let buffered = '';
    try {
        handle = await open(temporary, 'wx');
        const output = handle;
        const writeBytes = async (bytes: Uint8Array) => {
            let at = 0;
            while (at < bytes.length) {
                const { bytesWritten } = await output.write(bytes, at, bytes.length - at);
                at += bytesWritten;
            }
            written += bytes.length;
            options.onProgress?.(written);
        };
        const flush = async () => {
            if (buffered.length === 0) return;
            const text = buffered;
            buffered = '';
            await writeBytes(Buffer.from(text, 'utf8'));
        };

        // The last piece with any lines: the document ends there, so its final line has no line
        // ending after it, even when the file continued with lines that were deleted.
        let lastIndex = -1;
        pieces.forEach((piece, index) => {
            if (piece.kind === 'added' ? piece.lines.length > 0 : piece.count > 0)
                lastIndex = index;
        });

        let pending = false; // the last line written has no line ending after it yet
        for (const [index, piece] of pieces.entries()) {
            throwIfAborted(options.signal);
            if (piece.kind === 'added') {
                if (piece.lines.length === 0) continue;
                if (pending) buffered += eol;
                for (let i = 0; i < piece.lines.length; i++) {
                    buffered += (i > 0 ? eol : '') + piece.lines[i];
                    if (buffered.length >= FLUSH_CHARS) await flush();
                }
                pending = true;
                continue;
            }
            if (piece.count <= 0) continue;
            await flush();
            const isLast = piece.from + piece.count >= view.lineCount;
            const start = await lineByteOffset(reader, view, piece.from, options.signal);
            let end = isLast
                ? reader.size
                : await lineByteOffset(reader, view, piece.from + piece.count, options.signal);
            if (!isLast && index === lastIndex && end > start) {
                // End of the document: drop the line ending that belonged to a line now gone.
                const tail = await reader.readRange(
                    Math.max(start, end - 2),
                    Math.min(2, end - start),
                );
                if (tail[tail.length - 1] === 10)
                    end -= tail.length === 2 && tail[0] === 13 ? 2 : 1;
            }
            if (pending) await writeBytes(Buffer.from(eol));
            for await (const chunk of reader.chunks({ start, end, signal: options.signal })) {
                await writeBytes(chunk.data);
            }
            // Every line of the run but the file's last is followed by its own line ending.
            pending = isLast;
        }
        await flush();
        await output.sync();
        await output.close();
        handle = undefined;

        // Keep the file's permissions across the replacement (a no-op where they do not apply).
        await stat(target)
            .then((info) => chmod(temporary, info.mode & 0o7777))
            .catch(() => undefined);
        await options.beforeReplace?.();
        await rename(temporary, target);
        return { bytes: written };
    } catch (error) {
        await handle?.close().catch(() => undefined);
        await rm(temporary, { force: true }).catch(() => undefined);
        throw toDbError(error);
    }
};
