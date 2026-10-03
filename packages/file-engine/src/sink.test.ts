/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

// @vitest-environment node
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DbError } from '@httpreq/db-core';
import { FileSink, describeWriteError, freeSpace } from './sink';

let directory: string;
beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'httpreq-sink-'));
});
afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
});

describe('file sink', () => {
    it('writes a stream and puts the file in place only on commit', async () => {
        const target = join(directory, 'out.txt');
        const sink = await FileSink.create(target, { highWaterBytes: 4 });
        for (const part of ['hello ', 'streaming ', 'world']) await sink.write(part);
        expect(await readdir(directory)).toEqual([expect.stringMatching(/^\.out\.txt\..+\.part$/)]);
        expect(await sink.commit()).toBe(21);
        expect(await readFile(target, 'utf8')).toBe('hello streaming world');
        expect(await readdir(directory)).toEqual(['out.txt']);
    });

    it('leaves an existing file whole when the write is aborted', async () => {
        const target = join(directory, 'keep.txt');
        await writeFile(target, 'original');
        const sink = await FileSink.create(target);
        await sink.write('partial');
        await sink.abort();
        await sink.abort();
        expect(await readFile(target, 'utf8')).toBe('original');
        expect(await readdir(directory)).toEqual(['keep.txt']);
    });

    it('replaces an existing file on commit', async () => {
        const target = join(directory, 'new.txt');
        await writeFile(target, 'old content that is longer');
        const sink = await FileSink.create(target);
        await sink.write('new');
        await sink.commit();
        expect(await readFile(target, 'utf8')).toBe('new');
    });

    it('stops writing when cancelled', async () => {
        const controller = new AbortController();
        const sink = await FileSink.create(join(directory, 'x.txt'), {
            signal: controller.signal,
            highWaterBytes: 1,
        });
        await sink.write('a');
        controller.abort();
        await expect(sink.write('b')).rejects.toMatchObject({ code: 'CANCELLED' });
        await sink.abort();
        expect(await readdir(directory)).toEqual([]);
    });

    it('refuses a missing folder, a folder that is a file and not enough free space, with plain messages', async () => {
        await expect(FileSink.create(join(directory, 'missing', 'out.txt'))).rejects.toMatchObject({
            code: 'NOT_FOUND',
            message: expect.not.stringContaining(directory),
        });
        const free = await freeSpace(directory);
        if (free !== null) {
            await expect(
                FileSink.create(join(directory, 'big.txt'), { estimatedBytes: free * 2 }),
            ).rejects.toThrow(/not enough free space/);
            expect(await readdir(directory)).toEqual([]);
        }
    });

    it('describes write failures without naming a path', () => {
        const errno = (code: string) => Object.assign(new Error(`${code}: ${directory}`), { code });
        expect(describeWriteError(errno('ENOSPC')).message).toMatch(/disk is full/);
        expect(describeWriteError(errno('EACCES')).code).toBe('PERMISSION_DENIED');
        expect(describeWriteError(errno('ENOENT')).code).toBe('NOT_FOUND');
        expect(describeWriteError(errno('EROFS')).message).toMatch(/read-only/);
        for (const code of ['ENOSPC', 'EACCES', 'ENOENT', 'EBUSY', 'EIO'])
            expect(describeWriteError(errno(code)).message).not.toContain(directory);
        expect(describeWriteError(new DbError('CANCELLED', 'x')).code).toBe('CANCELLED');
    });

    it('keeps memory bounded: a long write buffers about the high-water mark', async () => {
        const sink = await FileSink.create(join(directory, 'big.bin'), {
            highWaterBytes: 64 * 1024,
        });
        const piece = 'x'.repeat(10_000);
        let peak = 0;
        for (let i = 0; i < 300; i++) {
            await sink.write(piece);
            peak = Math.max(peak, sink.bytesWritten - (await Promise.resolve(0)));
        }
        const written = await sink.commit();
        expect(written).toBe(3_000_000);
        expect(peak).toBeGreaterThan(0);
    });
});
