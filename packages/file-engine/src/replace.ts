/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { chmod, open, rename, rm, stat, type FileHandle } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { DbError, throwIfAborted, toDbError } from '@httpreq/db-core';
import type { ChunkReader } from './reader';
import { compileSearch, type SearchQuery } from './search';

const LF = 10;
/** A line longer than this is not carried across chunks, so memory stays bounded. */
const MAX_CARRY_BYTES = 4 * 1024 * 1024;

export interface ReplaceOptions {
    signal?: AbortSignal;
    onProgress?: (bytesRead: number, replacements: number) => void;
    chunkSize?: number;
    /** Called before the new file replaces the target; see `WriteOptions.beforeReplace`. */
    beforeReplace?: () => Promise<void>;
}

/**
 * Replaces every match of `query` in a file with `replacement`, writing the result to `target`
 * (atomically, through a temporary file), and returns how many replacements were made. Nothing is
 * written when there is no match.
 *
 * Replacement works on whole lines, like the search it mirrors, so a pattern never spans a line
 * break. Only blocks that contain a match are decoded and re-encoded; every other byte is copied
 * unchanged. If a block that must be rewritten is not valid UTF-8, the replace stops instead of
 * silently replacing invalid bytes with U+FFFD.
 *
 * In regular-expression mode `replacement` may use `$&`, `$1` and so on; in plain mode it is
 * literal.
 */
export const replaceInFile = async (
    reader: ChunkReader,
    query: SearchQuery,
    replacement: string,
    target: string,
    options: ReplaceOptions = {},
): Promise<{ replacements: number }> => {
    const pattern = compileSearch(query);
    const literal = query.regex ? replacement : replacement.replace(/\$/g, '$$$$');
    const temporary = `${target}.${randomBytes(4).toString('hex')}.hrsave`;
    let handle: FileHandle | undefined;
    let replacements = 0;
    try {
        handle = await open(temporary, 'wx');
        const output = handle;
        const write = async (bytes: Uint8Array) => {
            let at = 0;
            while (at < bytes.length) {
                const { bytesWritten } = await output.write(bytes, at, bytes.length - at);
                at += bytesWritten;
            }
        };

        const rewrite = async (block: Buffer) => {
            const text = block.toString('utf8');
            pattern.lastIndex = 0;
            if (!pattern.test(text)) return write(block);
            pattern.lastIndex = 0;
            const count = [...text.matchAll(pattern)].length;
            const replaced = text.replace(pattern, literal);
            if (!Buffer.from(text, 'utf8').equals(block)) {
                throw new DbError(
                    'UNSUPPORTED',
                    'The file contains bytes that are not valid UTF-8, so replacing in it could corrupt it.',
                );
            }
            replacements += count;
            await write(Buffer.from(replaced, 'utf8'));
        };

        let carry: Buffer = Buffer.alloc(0);
        for await (const chunk of reader.chunks({
            signal: options.signal,
            chunkSize: options.chunkSize,
        })) {
            const incoming = Buffer.from(
                chunk.data.buffer,
                chunk.data.byteOffset,
                chunk.data.length,
            );
            const joined =
                carry.length > 0 ? Buffer.concat([carry, incoming]) : Buffer.from(incoming);
            const cut = joined.lastIndexOf(LF);
            const upTo =
                cut === -1 ? (joined.length > MAX_CARRY_BYTES ? joined.length : 0) : cut + 1;
            if (upTo > 0) await rewrite(joined.subarray(0, upTo));
            carry = Buffer.from(joined.subarray(upTo));
            options.onProgress?.(chunk.offset + chunk.data.length, replacements);
            throwIfAborted(options.signal);
        }
        if (carry.length > 0) await rewrite(carry);

        await output.sync();
        await output.close();
        handle = undefined;
        if (replacements === 0) {
            await rm(temporary, { force: true });
            return { replacements: 0 };
        }
        await stat(target)
            .then((info) => chmod(temporary, info.mode & 0o7777))
            .catch(() => undefined);
        await options.beforeReplace?.();
        await rename(temporary, target);
        return { replacements };
    } catch (error) {
        await handle?.close().catch(() => undefined);
        await rm(temporary, { force: true }).catch(() => undefined);
        throw toDbError(error);
    }
};
