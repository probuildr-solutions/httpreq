/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

// @vitest-environment node
import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    ChunkReader,
    FileHostService,
    buildLineIndex,
    detectLineEnding,
    lineByteOffset,
    openFileSource,
    replaceInFile,
    writePieces,
    type FileOpenedResult,
    type FileProgressEvent,
    type FileSavedResult,
    type SavePiece,
} from './index';

let directory: string;
beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'hr-edit-'));
});
afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
});

const open = async (name: string, content: string | Buffer, chunkSize = 64) => {
    const path = join(directory, name);
    await writeFile(path, content);
    const { source } = await openFileSource(path);
    const reader = new ChunkReader(source, chunkSize);
    const index = await buildLineIndex(reader, { interval: 4, chunkSize });
    return { path, reader, index };
};

const text = async (path: string) => readFile(path, 'utf8');

describe('lineByteOffset', () => {
    it('agrees with a naive scan for every line, across checkpoints and chunk sizes', async () => {
        const lines = Array.from({ length: 50 }, (_, i) => `line ${i} ${'x'.repeat(i % 7)}`);
        const content = lines.join('\n');
        for (const chunkSize of [1, 7, 64]) {
            const { reader, index } = await open('a.txt', content, chunkSize);
            let expected = 0;
            for (let line = 0; line <= lines.length; line++) {
                expect(
                    await lineByteOffset(reader, index, line),
                    `line ${line}, chunk ${chunkSize}`,
                ).toBe(Math.min(expected, content.length));
                expected += (lines[line]?.length ?? 0) + 1;
            }
            await reader.close();
        }
    });
});

describe('detectLineEnding', () => {
    it('reads the first line break', async () => {
        expect(await detectLineEnding((await open('lf.txt', 'a\nb\r\n')).reader)).toBe('\n');
        expect(await detectLineEnding((await open('crlf.txt', 'a\r\nb\n')).reader)).toBe('\r\n');
        expect(await detectLineEnding((await open('none.txt', 'abc')).reader)).toBe('\n');
    });
});

describe('writePieces', () => {
    /** Builds a random edit as pieces, and what the document should read as. */
    const randomEdit = (lines: string[], seed: number) => {
        let state = seed;
        const next = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0);
        const pieces: SavePiece[] = [];
        const expected: string[] = [];
        let at = 0;
        while (at < lines.length) {
            if (next() % 3 === 0) {
                const added = Array.from(
                    { length: 1 + (next() % 3) },
                    (_, i) => `added ${seed}.${at}.${i}`,
                );
                pieces.push({ kind: 'added', lines: added });
                expected.push(...added);
            }
            const count = 1 + (next() % 5);
            const take = Math.min(count, lines.length - at);
            if (next() % 4 !== 0) {
                pieces.push({ kind: 'original', from: at, count: take });
                expected.push(...lines.slice(at, at + take));
            } // else: those lines are deleted
            at += take;
        }
        if (next() % 2 === 0) {
            pieces.push({ kind: 'added', lines: ['tail'] });
            expected.push('tail');
        }
        if (expected.length === 0) {
            pieces.push({ kind: 'added', lines: [''] });
            expected.push('');
        }
        return { pieces, expected };
    };

    for (const eol of ['\n', '\r\n'] as const) {
        for (const trailing of [false, true]) {
            it(`matches the document for random edits (${JSON.stringify(eol)}, trailing newline ${trailing})`, async () => {
                const lines = Array.from({ length: 40 }, (_, i) => `row ${i} é日本`).concat(
                    trailing ? [''] : [],
                );
                const content = lines.join(eol);
                for (let seed = 1; seed <= 25; seed++) {
                    const { path, reader, index } = await open(
                        'doc.txt',
                        content,
                        16 + (seed % 5) * 11,
                    );
                    const { pieces, expected } = randomEdit(lines, seed);
                    await writePieces(reader, index, pieces, path, eol, {
                        beforeReplace: () => reader.close(),
                    });
                    expect(await text(path), `seed ${seed}`).toBe(expected.join(eol));
                    await reader.close();
                    // No temporary file is left behind.
                    expect(
                        (await readdir(directory)).filter((name) => name.endsWith('.hrsave')),
                    ).toEqual([]);
                }
            }, 60_000);
        }
    }

    it('copies untouched bytes exactly: byte order mark, odd bytes and mixed line endings', async () => {
        const bytes = Buffer.concat([
            Buffer.from([0xef, 0xbb, 0xbf]),
            Buffer.from('a\r\nb\nc\r\n'),
            Buffer.from([0xff, 0xfe, 0x0a]),
            Buffer.from('end'),
        ]);
        const { path, reader, index } = await open('raw.bin', bytes, 8);
        // Keep lines 0-1, replace line 2, keep the rest.
        await writePieces(
            reader,
            index,
            [
                { kind: 'original', from: 0, count: 2 },
                { kind: 'added', lines: ['X'] },
                { kind: 'original', from: 3, count: 2 },
            ],
            path,
            '\n',
            { beforeReplace: () => reader.close() },
        );
        const result = await readFile(path);
        expect(result.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
        expect(result.subarray(3, 8)).toEqual(Buffer.from('a\r\nb\n'));
        expect(result.subarray(8, 10)).toEqual(Buffer.from('X\n'));
        expect(result.subarray(10)).toEqual(Buffer.from([0xff, 0xfe, 0x0a, ...Buffer.from('end')]));
    });

    it('leaves the old file untouched when writing fails or is cancelled', async () => {
        const { path, reader, index } = await open('keep.txt', 'one\ntwo\nthree\n');
        const controller = new AbortController();
        controller.abort();
        await expect(
            writePieces(reader, index, [{ kind: 'original', from: 0, count: 4 }], path, '\n', {
                signal: controller.signal,
            }),
        ).rejects.toMatchObject({ code: 'CANCELLED' });
        expect(await text(path)).toBe('one\ntwo\nthree\n');
        expect((await readdir(directory)).filter((name) => name.endsWith('.hrsave'))).toEqual([]);
    });

    it('refuses while the index is incomplete', async () => {
        const { path, reader } = await open('x.txt', 'a\nb');
        await expect(
            writePieces(
                reader,
                {
                    interval: 4,
                    checkpoints: new Float64Array([0]),
                    lineCount: 1,
                    terminatedLines: 0,
                    scannedBytes: 1,
                    complete: false,
                    byteLength: 3,
                },
                [],
                path,
                '\n',
            ),
        ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    });
});

describe('replaceInFile', () => {
    const run = async (
        content: string | Buffer,
        query: Parameters<typeof replaceInFile>[1],
        replacement: string,
        chunkSize = 16,
    ) => {
        const { path, reader } = await open('r.txt', content, chunkSize);
        const result = await replaceInFile(reader, query, replacement, path, {
            chunkSize,
            beforeReplace: () => reader.close(),
        });
        await reader.close();
        return { ...result, content: await readFile(path) };
    };

    it('replaces plain text, case-insensitively, whole words and with regular expressions', async () => {
        const sample = 'Foo foo FOO food\nfoo_bar foo\n';
        expect(
            (await run(sample, { text: 'foo', caseSensitive: true }, 'X')).content.toString(),
        ).toBe('Foo X FOO Xd\nX_bar X\n');
        expect(
            (await run(sample, { text: 'foo', caseSensitive: false }, 'X')).content.toString(),
        ).toBe('X X X Xd\nX_bar X\n');
        expect(
            (
                await run(sample, { text: 'foo', caseSensitive: false, wholeWord: true }, 'X')
            ).content.toString(),
        ).toBe('X X X food\nfoo_bar X\n');
        const regex = await run(
            'id=1 id=22\nid=x id=333\n',
            { text: 'id=(\\d+)', regex: true, caseSensitive: true },
            'ID[$1]',
        );
        expect(regex.content.toString()).toBe('ID[1] ID[22]\nid=x ID[333]\n');
        expect(regex.replacements).toBe(3);
    });

    it('treats $ literally in plain mode', async () => {
        const { content } = await run(
            'price\n',
            { text: 'price', caseSensitive: true },
            '$1 and $& and $$',
        );
        expect(content.toString()).toBe('$1 and $& and $$\n');
    });

    it('gives the same result for every chunk size, including a line that spans chunks', async () => {
        const source = Array.from(
            { length: 60 },
            (_, i) => `line ${i} needle ${'y'.repeat(i % 9)} needle`,
        ).join('\n');
        const reference = source.replaceAll('needle', 'N');
        for (const chunkSize of [1, 5, 16, 1000]) {
            expect(
                (
                    await run(source, { text: 'needle', caseSensitive: true }, 'N', chunkSize)
                ).content.toString(),
                `chunk ${chunkSize}`,
            ).toBe(reference);
        }
    });

    it('writes nothing when there is no match', async () => {
        const { path, reader } = await open('same.txt', 'nothing here\n');
        const before = (await readFile(path)).toString();
        const result = await replaceInFile(reader, { text: 'zzz' }, 'q', path);
        expect(result.replacements).toBe(0);
        expect(await text(path)).toBe(before);
        expect((await readdir(directory)).filter((name) => name.endsWith('.hrsave'))).toEqual([]);
    });

    it('leaves blocks without a match byte-for-byte, and refuses to rewrite invalid UTF-8', async () => {
        const invalid = Buffer.from([0xff, 0xfe, 0x0a]);
        const ok = await run(
            Buffer.concat([invalid, Buffer.from('keep\nfoo\n')]),
            { text: 'foo', caseSensitive: true },
            'bar',
            4,
        );
        expect(ok.content.subarray(0, 3)).toEqual(invalid);
        expect(ok.content.subarray(3).toString()).toBe('keep\nbar\n');

        const { path, reader } = await open(
            'bad.txt',
            Buffer.concat([Buffer.from('foo '), Buffer.from([0xff]), Buffer.from('\n')]),
            64,
        );
        await expect(
            replaceInFile(reader, { text: 'foo', caseSensitive: true }, 'x', path),
        ).rejects.toMatchObject({ code: 'UNSUPPORTED' });
        expect((await readFile(path)).length).toBe(6);
    });

    it('rejects an invalid pattern', async () => {
        const { path, reader } = await open('p.txt', 'abc');
        await expect(
            replaceInFile(reader, { text: '(', regex: true }, 'x', path),
        ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    });
});

describe('editing through the host', () => {
    const events: { topic: string; payload: unknown }[] = [];
    const setup = async (name: string, content: string) => {
        events.length = 0;
        const path = join(directory, name);
        await writeFile(path, content);
        const host = new FileHostService({ chunkSize: 64, progressIntervalMs: 0 });
        const context = {
            emit: (topic: string, payload: unknown) => events.push({ topic, payload }),
            signal: new AbortController().signal,
        };
        const opened = (await host.open(path, context)) as FileOpenedResult;
        const call = <T>(op: string, payload: object) =>
            host.handle(op, { fileId: opened.fileId, ...payload }, context) as Promise<T>;
        const ready = async () => {
            for (let i = 0; i < 400; i++) {
                const last = [...events].reverse().find((event) => event.topic === 'file.progress');
                if ((last?.payload as FileProgressEvent | undefined)?.state === 'ready') return;
                await new Promise((resolve) => setTimeout(resolve, 5));
            }
            throw new Error('index did not finish');
        };
        await ready();
        return { host, opened, call, path, ready };
    };

    it('reports the file line ending and a stable key when opened', async () => {
        const { opened, host } = await setup('a.txt', 'a\r\nb\r\n');
        expect(opened.eol).toBe('\r\n');
        expect(opened.fileKey).toMatch(/^[0-9a-f]{16}$/);
        await host.closeAll();
    });

    it('saves an edited document in place and re-opens the file on the new content', async () => {
        const { call, host, path, ready, opened } = await setup(
            'doc.sql',
            'one\ntwo\nthree\nfour\n',
        );
        events.length = 0;
        const saved = await call<FileSavedResult>('edit.save', {
            pieces: [
                { kind: 'original', from: 0, count: 1 },
                { kind: 'added', lines: ['TWO', 'extra'] },
                { kind: 'original', from: 2, count: 3 },
            ],
        });
        expect(await text(path)).toBe('one\nTWO\nextra\nthree\nfour\n');
        expect(saved.size).toBe(Buffer.byteLength('one\nTWO\nextra\nthree\nfour\n'));
        await ready();
        const lines = await call<{ lines: { text: string }[]; lineCount: number }>('file.lines', {
            from: 0,
            count: 10,
        });
        expect(lines.lines.map((line) => line.text)).toEqual([
            'one',
            'TWO',
            'extra',
            'three',
            'four',
            '',
        ]);
        expect(opened.fileId).toBe(saved.fileKey ? opened.fileId : '');
        await host.closeAll();
    });

    it('refuses to overwrite a file that changed on disk, but can save a copy elsewhere', async () => {
        const { call, host, path } = await setup('doc.txt', 'a\nb\n');
        await writeFile(path, 'changed by someone else\n');
        await utimes(path, new Date(), new Date(Date.now() + 5_000));
        const pieces = [{ kind: 'added', lines: ['mine'] }];
        await expect(call('edit.save', { pieces })).rejects.toMatchObject({ code: 'CONFLICT' });
        expect(await text(path)).toBe('changed by someone else\n');

        const copy = join(directory, 'copy.txt');
        const saved = await call<FileSavedResult>('edit.save', { pieces, path: copy });
        expect(await text(copy)).toBe('mine');
        expect(saved.name).toBe('copy.txt');
        await host.closeAll();
    });

    it('validates what it is asked to save', async () => {
        const { call, host } = await setup('v.txt', 'a\nb\n');
        await expect(call('edit.save', { pieces: 'nope' })).rejects.toMatchObject({
            code: 'INVALID_REQUEST',
        });
        await expect(
            call('edit.save', { pieces: [{ kind: 'original', from: 0, count: 99 }] }),
        ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
        await expect(
            call('edit.save', { pieces: [{ kind: 'added', lines: [1] }] }),
        ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
        await expect(
            call('edit.save', {
                pieces: [{ kind: 'original', from: 0, count: 3 }],
                path: 'relative.txt',
            }),
        ).rejects.toMatchObject({
            code: 'INVALID_REQUEST',
        });
        await host.closeAll();
    });

    it('reads a small file whole for the full editor, and refuses a large one', async () => {
        const { call, host } = await setup('small.sql', 'select 1;\r\nselect 2;\r\n');
        expect(await call('file.readText', {})).toEqual({
            text: 'select 1;\r\nselect 2;\r\n',
            eol: '\r\n',
            lossy: false,
        });
        await host.closeAll();

        const bad = await setup('bad.sql', 'ok\n');
        await writeFile(bad.path, Buffer.from([0x61, 0xff, 0x0a]));
        const reopened = await bad.host.open(bad.path, { emit: () => undefined });
        const text = await bad.host.handle(
            'file.readText',
            { fileId: reopened.fileId },
            { emit: () => undefined, signal: new AbortController().signal },
        );
        expect((text as { lossy: boolean }).lossy).toBe(true);
        await bad.host.closeAll();

        const big = new FileHostService({
            openSource: async () => ({
                source: {
                    size: 9 * 1024 * 1024,
                    mtimeMs: 1,
                    readInto: async () => 0,
                    close: async () => undefined,
                },
                realPath: '/big.sql',
            }),
        });
        const opened = await big.open('/big.sql', { emit: () => undefined });
        await expect(big.readText(opened.fileId)).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
        await big.closeAll();
    });

    it('replaces across the whole file in place and re-opens it', async () => {
        const { call, host, path, ready } = await setup('log.txt', 'a foo\nb foo foo\nc\n');
        events.length = 0;
        const result = await call<{ replacements: number }>('edit.replaceAll', {
            query: { text: 'foo', caseSensitive: true },
            replacement: 'bar',
        });
        expect(result.replacements).toBe(3);
        expect(await text(path)).toBe('a bar\nb bar bar\nc\n');
        await ready();
        const none = await call<{ replacements: number }>('edit.replaceAll', {
            query: { text: 'zzz', caseSensitive: true },
            replacement: 'q',
        });
        expect(none.replacements).toBe(0);
        await expect(
            call('edit.replaceAll', { query: { text: 'a' }, replacement: 5 }),
        ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
        await host.closeAll();
    });
});
