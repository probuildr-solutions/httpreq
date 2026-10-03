/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { constants } from 'node:fs';
import { open, realpath, stat, type FileHandle } from 'node:fs/promises';
import { DbError, toDbError } from '@httpreq/db-core';
import { assertSafeLocalPath } from './pathPolicy';

/**
 * Random access to bytes, and nothing else. The chunk reader and every index are written against
 * this, so a test can stand a synthetic 3 GB "file" in for the disk, and nothing above this
 * interface can ask for a whole file.
 */
export interface ByteSource {
    readonly size: number;
    /** Last modification time in milliseconds; part of the index-cache key. */
    readonly mtimeMs: number;
    /** Reads up to `length` bytes at `position` into `target`; returns how many were read. */
    readInto(target: Uint8Array, length: number, position: number): Promise<number>;
    close(): Promise<void>;
}

/** What the OS reports about an opened file. */
export interface OpenedFile {
    source: ByteSource;
    /** The path after resolving symbolic links: the stable identity of the file. */
    realPath: string;
}

class FileSource implements ByteSource {
    constructor(
        private readonly handle: FileHandle,
        readonly size: number,
        readonly mtimeMs: number,
    ) {}

    async readInto(target: Uint8Array, length: number, position: number): Promise<number> {
        let total = 0;
        // read() may return fewer bytes than asked for even before the end of the file.
        while (total < length) {
            const { bytesRead } = await this.handle.read(
                target,
                total,
                length - total,
                position + total,
            );
            if (bytesRead === 0) break;
            total += bytesRead;
        }
        return total;
    }

    close(): Promise<void> {
        return this.handle.close();
    }
}

/**
 * Opens a user-chosen path for reading and checks the handle, not the path: the file is opened
 * first and then `fstat`ed, so nothing can be swapped for a device or a FIFO between the check and
 * the read. `O_NONBLOCK` keeps opening a FIFO from hanging on POSIX before that check runs.
 */
export const openFileSource = async (path: unknown): Promise<OpenedFile> => {
    const checked = assertSafeLocalPath(path);
    let handle: FileHandle | undefined;
    try {
        const realPath = await realpath(checked);
        assertSafeLocalPath(realPath);
        handle = await open(realPath, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
        const info = await handle.stat();
        if (!info.isFile()) {
            throw new DbError('INVALID_REQUEST', 'Only regular files can be opened.');
        }
        return { source: new FileSource(handle, info.size, info.mtimeMs), realPath };
    } catch (error) {
        await handle?.close().catch(() => undefined);
        throw toDbError(error);
    }
};

/** Size and modification time of a path, without opening it for reading. */
export const statFile = async (path: string): Promise<{ size: number; mtimeMs: number }> => {
    try {
        const info = await stat(path);
        return { size: info.size, mtimeMs: info.mtimeMs };
    } catch (error) {
        throw toDbError(error);
    }
};
