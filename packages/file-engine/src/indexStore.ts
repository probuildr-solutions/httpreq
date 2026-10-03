/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { STUDIO_BUDGETS } from '@httpreq/db-core';
import { LineIndex } from './lineIndex';

/*
 * Sidecar layout, little endian:
 *   0   4  magic "HRLX"
 *   4   4  format version
 *   8   4  checkpoint interval
 *   12  4  checkpoint count
 *   16  8  line count
 *   24  8  byte length
 *   32  8  longest line (bytes)
 *   40  16 fingerprint (raw bytes of the 32-hex-char fingerprint)
 *   56  8 * count  checkpoints
 */
const MAGIC = 0x584c5248; // "HRLX" read as a little-endian u32
const VERSION = 1;
const HEADER_BYTES = 56;
const EXTENSION = '.hrlx';

/** A cache entry is bounded: a hostile file must not make a sidecar larger than this. */
const MAX_CHECKPOINTS = 64 * 1024 * 1024;

const nameFor = (realPath: string): string =>
    createHash('sha256').update(realPath).digest('hex').slice(0, 32) + EXTENSION;

/**
 * An on-disk cache of line indexes, so reopening an unchanged file is instant. The cache is keyed
 * by the file's real path and validated by its fingerprint; a mismatch, a corrupt file or an
 * unknown version is simply a miss, never an error, because the index can always be rebuilt.
 *
 * This is the one place in the add-on that reads a file whole, and only ever its own small
 * sidecars (a 3 GB file's index is tens of kilobytes), never user data.
 */
export class IndexStore {
    constructor(private readonly directory: string) {}

    async load(realPath: string, fingerprint: string): Promise<LineIndex | undefined> {
        const path = join(this.directory, nameFor(realPath));
        let bytes: Buffer;
        try {
            bytes = await readFile(path);
        } catch {
            return undefined;
        }
        const index = this.parse(bytes, fingerprint);
        if (!index) {
            await rm(path, { force: true }).catch(() => undefined);
            return undefined;
        }
        // Touch it so eviction treats it as recently used.
        const now = new Date();
        await utimes(path, now, now).catch(() => undefined);
        return index;
    }

    async save(realPath: string, fingerprint: string, index: LineIndex): Promise<void> {
        await mkdir(this.directory, { recursive: true });
        const count = index.checkpoints.length;
        const bytes = Buffer.alloc(HEADER_BYTES + count * 8);
        bytes.writeUInt32LE(MAGIC, 0);
        bytes.writeUInt32LE(VERSION, 4);
        bytes.writeUInt32LE(index.interval, 8);
        bytes.writeUInt32LE(count, 12);
        bytes.writeDoubleLE(index.lineCount, 16);
        bytes.writeDoubleLE(index.byteLength, 24);
        bytes.writeDoubleLE(index.longestLineBytes, 32);
        Buffer.from(fingerprint, 'hex').copy(bytes, 40, 0, 16);
        for (let i = 0; i < count; i++)
            bytes.writeDoubleLE(index.checkpoints[i]!, HEADER_BYTES + i * 8);
        const path = join(this.directory, nameFor(realPath));
        const temporary = `${path}.${process.pid}.tmp`;
        await writeFile(temporary, bytes);
        await rename(temporary, path);
    }

    /** Deletes the least recently used entries until the cache fits `maxBytes`. */
    async prune(maxBytes: number = STUDIO_BUDGETS.maxIndexCacheBytes): Promise<number> {
        let names: string[];
        try {
            names = (await readdir(this.directory)).filter((name) => name.endsWith(EXTENSION));
        } catch {
            return 0;
        }
        const entries: { path: string; size: number; used: number }[] = [];
        for (const name of names) {
            const path = join(this.directory, name);
            try {
                const info = await stat(path);
                entries.push({ path, size: info.size, used: info.mtimeMs });
            } catch {
                // Removed while we were looking: nothing to do.
            }
        }
        let total = entries.reduce((sum, entry) => sum + entry.size, 0);
        let removed = 0;
        for (const entry of entries.sort((a, b) => a.used - b.used)) {
            if (total <= maxBytes) break;
            await rm(entry.path, { force: true }).catch(() => undefined);
            total -= entry.size;
            removed++;
        }
        return removed;
    }

    async clear(): Promise<void> {
        await rm(this.directory, { recursive: true, force: true });
    }

    private parse(bytes: Buffer, fingerprint: string): LineIndex | undefined {
        if (bytes.length < HEADER_BYTES) return undefined;
        if (bytes.readUInt32LE(0) !== MAGIC || bytes.readUInt32LE(4) !== VERSION) return undefined;
        const interval = bytes.readUInt32LE(8);
        const count = bytes.readUInt32LE(12);
        if (interval < 1 || count < 1 || count > MAX_CHECKPOINTS) return undefined;
        if (bytes.length !== HEADER_BYTES + count * 8) return undefined;
        const lineCount = bytes.readDoubleLE(16);
        const byteLength = bytes.readDoubleLE(24);
        const longest = bytes.readDoubleLE(32);
        if (![lineCount, byteLength, longest].every((n) => Number.isFinite(n) && n >= 0))
            return undefined;
        if (!bytes.subarray(40, 56).equals(Buffer.from(fingerprint, 'hex').subarray(0, 16)))
            return undefined;
        const checkpoints = new Float64Array(count);
        let previous = -1;
        for (let i = 0; i < count; i++) {
            const offset = bytes.readDoubleLE(HEADER_BYTES + i * 8);
            // Offsets must be inside the file and strictly increasing, or the sidecar is damaged.
            if (!(offset > previous)) return undefined;
            if (offset > byteLength) return undefined;
            checkpoints[i] = offset;
            previous = offset;
        }
        if (checkpoints[0] !== 0) return undefined;
        // The checkpoint count must be exactly what the line count implies.
        if (Math.floor((lineCount - 1) / interval) + 1 !== count) return undefined;
        return new LineIndex(interval, lineCount, byteLength, checkpoints, longest);
    }
}
