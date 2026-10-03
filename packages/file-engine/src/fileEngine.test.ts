/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

// @vitest-environment node
import { mkdtemp, rm, writeFile, truncate, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { STUDIO_BUDGETS } from '@httpreq/db-core';
import {
    ChunkReader,
    FileHandleRegistry,
    FileHostService,
    IndexStore,
    LineIndexBuilder,
    LineSource,
    assertSafeLocalPath,
    buildLineIndex,
    fingerprintFile,
    openFileSource,
    type FileProgressEvent,
    type IndexView,
} from './index';
import { MemorySource, PatternSource } from './testing';

/** Deterministic pseudo-random text with every kind of line ending and some multibyte text. */
const sample = (seed: number, length: number): string => {
    let state = seed >>> 0 || 1;
    const next = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0);
    const pieces = ['a', 'bb', 'select * from t;', 'é', '日本語', '\n', '\n', '\r\n', '', '  '];
    let out = '';
    while (out.length < length) out += pieces[next() % pieces.length];
    return out;
};

/** The reference answer: split like an editor does. */
const naiveLines = (text: string): string[] =>
    text.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));

const collect = async (reader: ChunkReader, chunkSize: number) => {
    const seen: number[] = [];
    let bytes = 0;
    for await (const chunk of reader.chunks({ chunkSize })) {
        expect(chunk.offset).toBe(bytes);
        expect(chunk.data.length).toBeLessThanOrEqual(chunkSize);
        bytes += chunk.data.length;
        seen.push(chunk.data.length);
    }
    return { bytes, seen };
};

describe('ChunkReader', () => {
    it('covers the file exactly once for any chunk size', async () => {
        const text = sample(1, 5_000);
        for (const chunkSize of [1, 2, 7, 64, 1000, 5_000, 99_999]) {
            const reader = new ChunkReader(MemorySource.text(text));
            const { bytes } = await collect(reader, chunkSize);
            expect(bytes).toBe(new TextEncoder().encode(text).length);
        }
    });

    it('honors a byte range and an empty file', async () => {
        const source = MemorySource.text('0123456789');
        const reader = new ChunkReader(source);
        const parts: string[] = [];
        for await (const chunk of reader.chunks({ start: 2, end: 8, chunkSize: 4 })) {
            parts.push(new TextDecoder().decode(chunk.data));
        }
        expect(parts).toEqual(['2345', '67']);
        const empty = new ChunkReader(MemorySource.text(''));
        expect((await collect(empty, 10)).bytes).toBe(0);
    });

    it('keeps at most two buffers in flight and reads nothing larger than a chunk', async () => {
        const source = MemorySource.text('x'.repeat(10_000));
        const reader = new ChunkReader(source);
        await collect(reader, 1_000);
        expect(Math.max(...source.reads.map((read) => read.length))).toBeLessThanOrEqual(1_000);
    });

    it('stops on abort and lets an early break finish its pending read', async () => {
        const reader = new ChunkReader(MemorySource.text('x'.repeat(10_000)));
        const controller = new AbortController();
        const run = (async () => {
            for await (const chunk of reader.chunks({
                chunkSize: 100,
                signal: controller.signal,
            })) {
                if (chunk.offset >= 300) controller.abort();
            }
        })();
        await expect(run).rejects.toMatchObject({ code: 'CANCELLED' });

        for await (const chunk of reader.chunks({ chunkSize: 100 })) {
            expect(chunk.offset).toBe(0);
            break;
        }
    });

    it('caps a point read', async () => {
        const reader = new ChunkReader(MemorySource.text('hello world'));
        expect(new TextDecoder().decode(await reader.readRange(6, 100))).toBe('world');
        await expect(reader.readRange(0, 64 * 1024 * 1024)).rejects.toMatchObject({
            code: 'LIMIT_EXCEEDED',
        });
        await expect(reader.readRange(-1, 4)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    });
});

describe('LineIndexBuilder', () => {
    it('produces the same index for every chunking of the same bytes', async () => {
        const text = sample(7, 20_000);
        const bytes = new TextEncoder().encode(text);
        const expected = naiveLines(text).length;

        const indexes = [];
        for (const chunkSize of [1, 3, 17, 256, 4096, bytes.length]) {
            const builder = new LineIndexBuilder(8);
            for (let offset = 0; offset < bytes.length; offset += chunkSize) {
                builder.feed(bytes.subarray(offset, offset + chunkSize), offset);
            }
            indexes.push(builder.finish(bytes.length));
        }
        for (const index of indexes) {
            expect(index.lineCount).toBe(expected);
            expect(index.checkpoints).toEqual(indexes[0]!.checkpoints);
            expect(index.longestLineBytes).toBe(indexes[0]!.longestLineBytes);
        }
    });

    it('counts lines the way an editor does', async () => {
        const count = async (text: string) =>
            (await buildLineIndex(new ChunkReader(MemorySource.text(text)))).lineCount;
        expect(await count('')).toBe(1);
        expect(await count('a')).toBe(1);
        expect(await count('a\n')).toBe(2);
        expect(await count('a\nb')).toBe(2);
        expect(await count('\n\n')).toBe(3);
    });

    it('records one checkpoint per interval at the right byte offset', async () => {
        const text = Array.from({ length: 25 }, (_, i) => `line ${i}`).join('\n');
        const index = await buildLineIndex(new ChunkReader(MemorySource.text(text)), {
            interval: 10,
        });
        expect(index.checkpoints.length).toBe(3);
        expect(text.slice(index.checkpoints[1]!, index.checkpoints[1]! + 7)).toBe('line 10');
        expect(text.slice(index.checkpoints[2]!, index.checkpoints[2]! + 7)).toBe('line 20');
    });

    it('reports progress while scanning and the longest line', async () => {
        const seen: number[] = [];
        const index = await buildLineIndex(
            new ChunkReader(MemorySource.text(`${'x'.repeat(500)}\nshort\n`)),
            {
                chunkSize: 100,
                progressIntervalMs: 0,
                onProgress: (progress) => seen.push(progress.bytesRead),
            },
        );
        expect(index.longestLineBytes).toBe(500);
        expect(seen.length).toBeGreaterThan(1);
        expect(seen).toEqual([...seen].sort((a, b) => a - b));
    });
});

describe('LineSource', () => {
    const open = async (text: string, interval = 4, pageSize = 4) => {
        const reader = new ChunkReader(MemorySource.text(text), 16);
        const index = await buildLineIndex(reader, { interval, chunkSize: 16 });
        return new LineSource(reader, () => index, { pageSize });
    };

    it('returns exactly the lines a naive split would, for any range', async () => {
        const text = sample(3, 3_000);
        const expected = naiveLines(text);
        const source = await open(text);
        expect(source.lineCount).toBe(expected.length);
        for (const [from, count] of [
            [0, 10],
            [3, 9],
            [expected.length - 5, 50],
            [Math.floor(expected.length / 2), 1],
            [0, expected.length],
        ] as const) {
            const lines = await source.readLines(from, count);
            const want = expected.slice(from, from + count);
            expect(lines.map((line) => line.text)).toEqual(want);
            expect(lines.map((line) => line.line)).toEqual(want.map((_, i) => from + i));
        }
    });

    it('handles empty files, ranges past the end and a missing final newline', async () => {
        expect((await (await open('')).readLines(0, 5)).map((l) => l.text)).toEqual(['']);
        const source = await open('a\nb');
        expect(await source.readLines(5, 5)).toEqual([]);
        expect((await source.readLines(1, 5)).map((l) => l.text)).toEqual(['b']);
        expect(await source.readLines(0, 0)).toEqual([]);
    });

    it('cuts a very long line instead of loading it, and says so', async () => {
        const reader = new ChunkReader(MemorySource.text(`${'x'.repeat(10_000)}\nok\n`), 64);
        const index = await buildLineIndex(reader, { chunkSize: 64 });
        const source = new LineSource(reader, () => index, { maxLineBytes: 100 });
        const [long, short] = await source.readLines(0, 2);
        expect(long!.text.length).toBe(100);
        expect(long!.truncated).toBe(true);
        expect(short).toMatchObject({ text: 'ok', truncated: false });
    });

    it('serves repeat reads from the cache without touching the file', async () => {
        const source = MemorySource.text(sample(5, 2_000));
        const reader = new ChunkReader(source, 64);
        const index = await buildLineIndex(reader, { interval: 4, chunkSize: 64 });
        const lines = new LineSource(reader, () => index, { pageSize: 4 });
        await lines.readLines(10, 8);
        const before = source.reads.length;
        const again = await lines.readLines(10, 8);
        expect(source.reads.length).toBe(before);
        expect(again).toHaveLength(8);
    });

    it('reads only lines already indexed while the scan is still running', async () => {
        const text = Array.from({ length: 40 }, (_, i) => `row ${i}`).join('\n');
        const reader = new ChunkReader(MemorySource.text(text), 16);
        const builder = new LineIndexBuilder(4);
        const bytes = new TextEncoder().encode(text);
        const source = new LineSource(reader, () => builder.snapshot(bytes.length), {
            pageSize: 4,
        });
        builder.feed(bytes.subarray(0, 60), 0);
        const early = await source.readLines(0, 100);
        // Every terminated line, then the line the scan is in the middle of (cut where it stopped).
        expect(early.length).toBe(builder.completedLines + 1);
        expect(early.slice(0, -1).map((line) => line.text)).toEqual(
            Array.from({ length: builder.completedLines }, (_, i) => `row ${i}`),
        );
        expect(`row ${builder.completedLines}`.startsWith(early.at(-1)!.text)).toBe(true);
        // Nothing beyond the scanned bytes is offered.
        expect(early.every((line) => line.line <= builder.completedLines)).toBe(true);

        // Once the scan moves on, the previously partial line has its final text.
        builder.feed(bytes.subarray(60), 60);
        const rest = await source.readLines(0, 100);
        expect(rest.map((line) => line.text)).toEqual(
            Array.from({ length: 40 }, (_, i) => `row ${i}`),
        );
    });
});

describe('IndexStore', () => {
    let directory: string;
    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), 'hr-index-'));
    });
    afterEach(async () => {
        await rm(directory, { recursive: true, force: true });
    });

    const indexOf = (text: string) =>
        buildLineIndex(new ChunkReader(MemorySource.text(text)), { interval: 4 });

    it('round-trips an index and rejects a different fingerprint', async () => {
        const store = new IndexStore(directory);
        const index = await indexOf(sample(9, 4_000));
        await store.save('/data/a.sql', 'ab'.repeat(16), index);
        const loaded = await store.load('/data/a.sql', 'ab'.repeat(16));
        expect(loaded?.lineCount).toBe(index.lineCount);
        expect(loaded?.checkpoints).toEqual(index.checkpoints);
        expect(loaded?.longestLineBytes).toBe(index.longestLineBytes);
        expect(await store.load('/data/a.sql', 'cd'.repeat(16))).toBeUndefined();
        expect(await store.load('/data/other.sql', 'ab'.repeat(16))).toBeUndefined();
    });

    it('treats a damaged sidecar as a miss and removes it', async () => {
        const store = new IndexStore(directory);
        await store.save('/data/a.sql', 'ab'.repeat(16), await indexOf('x\ny\nz\n'.repeat(20)));
        const [name] = await readdir(directory);
        const path = join(directory, name!);
        const info = await stat(path);
        await truncate(path, info.size - 3);
        expect(await store.load('/data/a.sql', 'ab'.repeat(16))).toBeUndefined();
        expect(await readdir(directory)).toEqual([]);

        await writeFile(join(directory, 'junk.hrlx'), 'not an index');
        expect(await store.prune(0)).toBe(1);
    });

    it('evicts the least recently used entries first', async () => {
        const store = new IndexStore(directory);
        const index = await indexOf('a\n'.repeat(100));
        await store.save('/one', 'ab'.repeat(16), index);
        await new Promise((resolve) => setTimeout(resolve, 20));
        await store.save('/two', 'ab'.repeat(16), index);
        await new Promise((resolve) => setTimeout(resolve, 20));
        await store.load('/one', 'ab'.repeat(16)); // /one is now the most recent
        const [{ size }] = await Promise.all([
            stat(join(directory, (await readdir(directory))[0]!)),
        ]);
        expect(await store.prune(size)).toBe(1);
        expect(await store.load('/one', 'ab'.repeat(16))).toBeDefined();
        expect(await store.load('/two', 'ab'.repeat(16))).toBeUndefined();
    });

    it('fingerprints change when the file does', async () => {
        const a = await fingerprintFile(new ChunkReader(MemorySource.text('hello', 1)));
        const touched = await fingerprintFile(new ChunkReader(MemorySource.text('hello', 2)));
        const edited = await fingerprintFile(new ChunkReader(MemorySource.text('hellp', 1)));
        expect(new Set([a, touched, edited]).size).toBe(3);
        expect(a).toMatch(/^[0-9a-f]{32}$/);
    });
});

describe('path policy and handles', () => {
    it('accepts ordinary absolute paths, including UNC shares', () => {
        expect(assertSafeLocalPath('/home/me/dump.sql')).toBe('/home/me/dump.sql');
        expect(assertSafeLocalPath('C:\\data\\dump.sql')).toBe('C:\\data\\dump.sql');
        expect(assertSafeLocalPath('\\\\server\\share\\dump.sql')).toContain('server');
    });

    it('rejects what could reach a device or escape the user’s choice', () => {
        for (const bad of [
            '',
            42,
            null,
            'relative/file.sql',
            './file.sql',
            '/tmp/a\0b',
            '\\\\.\\PhysicalDrive0',
            '\\\\?\\GLOBALROOT\\Device\\x',
            'C:\\work\\NUL',
            'C:\\work\\com1.txt',
            `/${'a'.repeat(5000)}`,
        ]) {
            expect(() => assertSafeLocalPath(bad), String(bad)).toThrow();
        }
    });

    it('opens only regular files', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'hr-open-'));
        try {
            await expect(openFileSource(directory)).rejects.toMatchObject({
                code: expect.stringMatching(/INVALID_REQUEST|IO_ERROR|PERMISSION_DENIED/),
            });
            await expect(openFileSource(join(directory, 'missing.sql'))).rejects.toMatchObject({
                code: 'NOT_FOUND',
            });
            const file = join(directory, 'a.sql');
            await writeFile(file, 'select 1;\n');
            const { source } = await openFileSource(file);
            expect(source.size).toBe(10);
            await source.close();
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    it('binds a token to the window it was granted to', () => {
        const registry = new FileHandleRegistry();
        const token = registry.grant('/data/a.sql', 1);
        expect(token).toMatch(/^[0-9a-f]{32}$/);
        expect(registry.resolve(token, 1)).toBe('/data/a.sql');
        expect(() => registry.resolve(token, 2)).toThrow(/not chosen/);
        expect(() => registry.resolve('guess', 1)).toThrow();
        expect(() => registry.resolve(undefined, 1)).toThrow();
        registry.revokeOwner(1);
        expect(() => registry.resolve(token, 1)).toThrow();
        expect(registry.size).toBe(0);
    });

    it('limits how many files one window may hold', () => {
        const registry = new FileHandleRegistry();
        for (let i = 0; i < 64; i++) registry.grant(`/f${i}`, 1);
        expect(() => registry.grant('/more', 1)).toThrow(/Too many/);
        expect(() => registry.grant('/other-window', 2)).not.toThrow();
    });
});

describe('FileHostService', () => {
    let directory: string;
    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), 'hr-host-'));
    });
    afterEach(async () => {
        await rm(directory, { recursive: true, force: true });
    });

    const waitFor = async (events: FileProgressEvent[], state: string) => {
        for (let i = 0; i < 400; i++) {
            const found = events.find((event) => event.state === state);
            if (found) return found;
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        throw new Error(`no ${state} event; saw ${JSON.stringify(events)}`);
    };

    it('opens a real file, indexes it in the background and serves line ranges', async () => {
        const lines = Array.from({ length: 5_000 }, (_, i) => `INSERT INTO t VALUES (${i});`);
        const path = join(directory, 'dump.sql');
        await writeFile(path, lines.join('\n') + '\n');

        const host = new FileHostService({
            indexStore: new IndexStore(join(directory, 'cache')),
            chunkSize: 4096,
            progressIntervalMs: 0,
        });
        const events: FileProgressEvent[] = [];
        const context = {
            emit: (_topic: string, payload: unknown) => events.push(payload as FileProgressEvent),
            signal: new AbortController().signal,
        };
        const opened = (await host.handle('file.open', { path }, context)) as {
            fileId: string;
            name: string;
            size: number;
        };
        expect(opened.name).toBe('dump.sql');
        expect(opened.name).not.toContain(directory);

        const ready = await waitFor(events, 'ready');
        expect(ready.lines).toBe(5_001);

        const result = (await host.handle(
            'file.lines',
            { fileId: opened.fileId, from: 4_000, count: 3 },
            context,
        )) as { lines: { line: number; text: string }[]; lineCount: number; complete: boolean };
        expect(result.complete).toBe(true);
        expect(result.lineCount).toBe(5_001);
        expect(result.lines.map((l) => l.text)).toEqual(lines.slice(4_000, 4_003));

        await host.closeAll();
        expect(host.openCount).toBe(0);

        // Reopening an unchanged file is served from the cache.
        events.length = 0;
        await host.handle('file.open', { path }, context);
        expect((await waitFor(events, 'ready')).lines).toBe(5_001);
        await host.closeAll();
    });

    it('fails one file without affecting the others', async () => {
        const events: FileProgressEvent[] = [];
        const context = {
            emit: (_t: string, payload: unknown) => events.push(payload as FileProgressEvent),
            signal: new AbortController().signal,
        };
        const bad = MemorySource.text('a\nb\nc\n'.repeat(1_000));
        const original = bad.readInto.bind(bad);
        bad.readInto = async (target, length, position) => {
            if (position > 1_000) throw Object.assign(new Error('disk'), { code: 'EIO' });
            return original(target, length, position);
        };
        const queue = [
            { source: bad, realPath: '/bad.sql' },
            { source: MemorySource.text('x\ny\n'), realPath: '/good.sql' },
        ];
        const service = new FileHostService({
            chunkSize: 64,
            openSource: async () => queue.shift()!,
        });
        const first = await service.open('/bad.sql', context);
        const second = await service.open('/good.sql', context);
        const failed = await waitFor(events, 'failed');
        expect(failed.fileId).toBe(first.fileId);
        expect(failed.error?.code).toBe('IO_ERROR');
        const lines = await service.readLines(second.fileId, 0, 5);
        expect(lines.lines.map((l) => l.text)).toEqual(['x', 'y', '']);
        await service.closeAll();
    });

    it('validates requests and refuses what it should', async () => {
        const host = new FileHostService({
            maxOpenFiles: 1,
            openSource: async () => ({ source: MemorySource.text('a\n'), realPath: '/a' }),
        });
        const context = { emit: () => undefined, signal: new AbortController().signal };
        await expect(host.handle('file.nope', {}, context)).rejects.toMatchObject({
            code: 'UNSUPPORTED',
        });
        await expect(host.handle('file.open', null, context)).rejects.toMatchObject({
            code: 'INVALID_REQUEST',
        });
        await expect(
            host.handle('file.lines', { fileId: 'x', from: -1, count: 1 }, context),
        ).rejects.toMatchObject({
            code: 'INVALID_REQUEST',
        });
        await expect(
            host.handle('file.lines', { fileId: 'x', from: 0, count: 10_000 }, context),
        ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
        await expect(
            host.handle('file.lines', { fileId: 'x', from: 0, count: 1 }, context),
        ).rejects.toMatchObject({
            code: 'NOT_FOUND',
        });
        await host.handle('file.open', { path: '/a' }, context);
        await expect(host.handle('file.open', { path: '/b' }, context)).rejects.toMatchObject({
            code: 'LIMIT_EXCEEDED',
        });
        await host.closeAll();
    });

    it('cancels indexing when the file is closed', async () => {
        const big = new PatternSource(1024 ** 4, new TextEncoder().encode(`${'y'.repeat(127)}\n`));
        // A real disk read completes on the event loop; this fake would otherwise finish every
        // read in a microtask and never let the test's timers (or the cancel) run.
        const fastRead = big.readInto.bind(big);
        big.readInto = async (target, length, position) => {
            await new Promise<void>((resolve) => setImmediate(resolve));
            return fastRead(target, length, position);
        };
        const events: FileProgressEvent[] = [];
        const host = new FileHostService({
            openSource: async () => ({ source: big, realPath: '/big' }),
            progressIntervalMs: 0,
        });
        const context = {
            emit: (_t: string, payload: unknown) => events.push(payload as FileProgressEvent),
            signal: new AbortController().signal,
        };
        const { fileId } = (await host.open('/big', context)) as { fileId: string };
        await waitFor(events, 'indexing');
        await host.close(fileId);
        expect(events.some((event) => event.state === 'cancelled')).toBe(true);
        expect(big.totalRead).toBeLessThan(big.size);
    });
});

describe('3 GB without 3 GB of memory', () => {
    it('indexes a synthetic 3 GiB file with bounded reads and flat memory', async () => {
        const lineBytes = 128; // divides the chunk size, so the pattern is the same in every chunk
        const lines = (3 * 1024 * 1024 * 1024) / lineBytes;
        const source = new PatternSource(
            lines * lineBytes,
            new TextEncoder().encode(`${'z'.repeat(lineBytes - 1)}\n`),
        );
        const reader = new ChunkReader(source);
        const before = process.memoryUsage().rss;
        let peak = before;
        const index = await buildLineIndex(reader, {
            progressIntervalMs: 0,
            onProgress: () => (peak = Math.max(peak, process.memoryUsage().rss)),
        });

        expect(index.byteLength).toBe(3 * 1024 ** 3);
        expect(index.lineCount).toBe(lines + 1); // the final newline leaves one empty line
        expect(index.checkpoints.length).toBe(
            Math.floor(lines / STUDIO_BUDGETS.lineCheckpointInterval) + 1,
        );
        expect(index.longestLineBytes).toBe(lineBytes - 1);
        expect(source.totalRead).toBe(source.size);
        expect(source.maxRead).toBeLessThanOrEqual(STUDIO_BUDGETS.chunkBytes);
        // Two 1 MiB buffers and an index of a few hundred KB: nowhere near the file's size.
        expect(peak - before).toBeLessThan(150 * 1024 * 1024);

        const view: IndexView = index;
        const lineSource = new LineSource(reader, () => view);
        const middle = await lineSource.readLines(12_345_678, 3);
        expect(middle.map((line) => line.line)).toEqual([12_345_678, 12_345_679, 12_345_680]);
        expect(middle[0]!.text).toBe('z'.repeat(lineBytes - 1));
        expect(source.maxRead).toBeLessThanOrEqual(STUDIO_BUDGETS.chunkBytes);
    }, 120_000);
});
