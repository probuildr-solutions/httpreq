/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { ChunkReader, searchFile, type SearchHit, type SearchQuery } from './index';
import { MemorySource, PatternSource } from './testing';

const run = async (text: string, query: SearchQuery, chunkSize = 64, maxHits?: number) => {
    const hits: SearchHit[] = [];
    const reader = new ChunkReader(MemorySource.text(text), chunkSize);
    const result = await searchFile(reader, query, {
        chunkSize,
        maxHits,
        onHits: (batch) => hits.push(...batch),
    });
    return { hits, result };
};

/** What a straightforward string search finds, as [offset, line] pairs. */
const reference = (text: string, query: SearchQuery): [number, number][] => {
    const haystack = query.caseSensitive ? text : text.toLowerCase();
    const needle = query.caseSensitive ? query.text : query.text.toLowerCase();
    const word = /[A-Za-z0-9_]/;
    const out: [number, number][] = [];
    let from = 0;
    for (;;) {
        const at = haystack.indexOf(needle, from);
        if (at === -1) break;
        if (
            query.wholeWord &&
            (word.test(text[at - 1] ?? '') || word.test(text[at + needle.length] ?? ''))
        ) {
            from = at + 1;
            continue;
        }
        out.push([at, text.slice(0, at).split('\n').length - 1]);
        from = at + needle.length;
    }
    return out;
};

const pairs = (hits: SearchHit[]) => hits.map((hit): [number, number] => [hit.offset, hit.line]);

/** Pseudo-random ASCII text with many partial matches of "needle" and line breaks. */
const noisy = (seed: number, length: number) => {
    let state = seed;
    const next = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0);
    const pieces = [
        'needle',
        'Needle',
        'NEEDLE',
        'need',
        'le',
        ' ',
        '\n',
        'x',
        'needleneedle',
        '_needle',
        'needle_',
        '-needle-',
        'ne\nedle',
    ];
    let out = '';
    while (out.length < length) out += pieces[next() % pieces.length];
    return out;
};

describe('plain search', () => {
    it('matches a naive search for every chunk size, with correct offsets and lines', async () => {
        const text = noisy(11, 6_000);
        for (const query of [
            { text: 'needle', caseSensitive: true },
            { text: 'needle', caseSensitive: false },
            { text: 'needle', caseSensitive: true, wholeWord: true },
            { text: 'NeedLe', caseSensitive: false, wholeWord: true },
            { text: 'e\nedle', caseSensitive: true },
        ] satisfies SearchQuery[]) {
            const want = reference(text, query);
            expect(want.length).toBeGreaterThan(5);
            for (const chunkSize of [1, 2, 5, 7, 64, 1000, 100_000]) {
                const { hits } = await run(text, query, chunkSize);
                expect(pairs(hits), `${JSON.stringify(query)} chunk ${chunkSize}`).toEqual(want);
            }
        }
    });

    it('finds a match that straddles two chunks exactly once', async () => {
        const { hits } = await run('aaaaneedlebbbb', { text: 'needle', caseSensitive: true }, 6);
        expect(pairs(hits)).toEqual([[4, 0]]);
    });

    it('reports byte offsets for multi-byte text', async () => {
        const { hits } = await run('日本語 needle', { text: 'needle', caseSensitive: true });
        expect(hits[0]!.offset).toBe(new TextEncoder().encode('日本語 ').length);
    });

    it('gives each hit a preview of its line with the match position', async () => {
        const { hits } = await run('first line\nthe needle is here\nlast', {
            text: 'needle',
            caseSensitive: true,
        });
        expect(hits[0]).toMatchObject({
            line: 1,
            length: 6,
            preview: 'the needle is here',
            previewStart: 4,
        });
    });

    it('cuts a very long line around the match', async () => {
        const { hits } = await run(
            `${'x'.repeat(5_000)}needle${'y'.repeat(5_000)}`,
            { text: 'needle', caseSensitive: true },
            1024,
        );
        expect(hits[0]!.preview.length).toBeLessThan(300);
        expect(hits[0]!.preview.slice(hits[0]!.previewStart, hits[0]!.previewStart + 6)).toBe(
            'needle',
        );
    });

    it('stops at the hit cap and says so', async () => {
        const { hits, result } = await run(
            'needle '.repeat(100),
            { text: 'needle', caseSensitive: true },
            64,
            10,
        );
        expect(hits).toHaveLength(10);
        expect(result).toEqual({ hits: 10, truncated: true });
        const exact = await run(
            'needle '.repeat(10),
            { text: 'needle', caseSensitive: true },
            64,
            10,
        );
        expect(exact.result).toEqual({ hits: 10, truncated: false });
    });

    it('finds nothing in an empty file and rejects an empty query', async () => {
        expect((await run('', { text: 'a' })).hits).toEqual([]);
        await expect(run('abc', { text: '' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
        await expect(run('abc', { text: 'x'.repeat(2_000) })).rejects.toMatchObject({
            code: 'INVALID_REQUEST',
        });
    });

    it('streams hits before the scan finishes and supports cancellation', async () => {
        const source = new PatternSource(
            512 * 1024 * 1024,
            new TextEncoder().encode(`${'a'.repeat(30)}needle${'b'.repeat(30)}\n`),
        );
        const reader = new ChunkReader(source);
        const controller = new AbortController();
        let batches = 0;
        const search = searchFile(
            reader,
            { text: 'needle', caseSensitive: true },
            {
                signal: controller.signal,
                flushMs: 0,
                onHits: () => {
                    if (++batches >= 3) controller.abort();
                },
            },
        );
        await expect(search).rejects.toMatchObject({ code: 'CANCELLED' });
        expect(batches).toBeGreaterThanOrEqual(3);
        expect(source.totalRead).toBeLessThan(source.size);
    });
});

describe('regular expressions', () => {
    it('matches line by line with correct byte offsets and line numbers', async () => {
        const text = 'id=1\nname=café\nid=22\nid=x\n日本 id=333\n';
        const { hits } = await run(text, { text: 'id=\\d+', regex: true, caseSensitive: true }, 7);
        const bytes = new TextEncoder().encode(text);
        expect(hits.map((hit) => hit.line)).toEqual([0, 2, 4]);
        for (const hit of hits) {
            expect(
                new TextDecoder().decode(bytes.subarray(hit.offset, hit.offset + hit.length)),
            ).toMatch(/^id=\d+$/);
        }
    });

    it('gives the same hits for every chunk size', async () => {
        const text = noisy(5, 4_000);
        const query = {
            text: 'ne+dle\\b',
            regex: true,
            caseSensitive: false,
        } satisfies SearchQuery;
        const whole = (await run(text, query, 100_000)).hits;
        expect(whole.length).toBeGreaterThan(3);
        for (const chunkSize of [3, 17, 64, 500]) {
            expect(pairs((await run(text, query, chunkSize)).hits), `chunk ${chunkSize}`).toEqual(
                pairs(whole),
            );
        }
    });

    it('anchors ^ and $ at line boundaries', async () => {
        const { hits } = await run('abc\nabc def\nxabc\n', {
            text: '^abc$',
            regex: true,
            caseSensitive: true,
        });
        expect(pairs(hits)).toEqual([[0, 0]]);
    });

    it('rejects an invalid pattern with a clear error', async () => {
        await expect(run('abc', { text: '(', regex: true })).rejects.toMatchObject({
            code: 'INVALID_REQUEST',
            message: expect.stringMatching(/regular expression/),
        });
    });

    it('does not loop on a pattern that can match nothing', async () => {
        const { hits } = await run('abc\nxyz\n', { text: 'q*', regex: true });
        expect(hits).toEqual([]);
    });

    it('searches a file whose only line is far longer than a chunk', async () => {
        const { hits } = await run(
            `${'a'.repeat(20_000)}needle${'b'.repeat(20_000)}`,
            { text: 'needl.', regex: true, caseSensitive: true },
            256,
        );
        expect(hits).toHaveLength(1);
        expect(hits[0]!.offset).toBe(20_000);
    });

    it('treats a case-insensitive search with non-ASCII letters as a regular expression', async () => {
        const { hits } = await run('Café CAFÉ café', { text: 'café', caseSensitive: false });
        expect(hits).toHaveLength(3);
    });
});
