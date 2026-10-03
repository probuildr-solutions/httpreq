/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
    ChunkReader,
    openFileSource,
    scanItems,
    searchFile,
    type ItemFormat,
} from '@httpreq/file-engine';
import {
    FIXTURE_KINDS,
    ensureFixture,
    fixtureDirectory,
    parseSize,
    type FixtureKind,
} from './fixtures';

/**
 * Phase 2 benchmarks: splitting a file into statements or documents, and searching it, through the
 * same `scanItems` and `searchFile` the File Host runs. See file.bench.ts for the shared settings.
 */

const SIZES = (process.env.BENCH_SIZES ?? '100MB,500MB').split(',').map(parseSize);
const KINDS = (process.env.BENCH_KINDS ?? FIXTURE_KINDS.join(',')).split(',') as FixtureKind[];
const ASSERT = process.env.BENCH_ASSERT !== '0';
const MB = 1024 * 1024;

const FORMAT: Record<FixtureKind, ItemFormat | null> = {
    sql: 'sql-mysql',
    jsonl: 'jsonl',
    json: 'json-array',
    'json-minified': 'json-array',
    csv: null,
};

const TARGETS = {
    scanMbPerSecond: 100,
    searchMbPerSecond: 300,
    firstHitMs: 1000,
    regexMbPerSecond: 20,
    rssGrowthMb: 400,
};

interface Row {
    kind: string;
    sizeMb: number;
    items: number;
    scanMbPerSecond: number;
    indexMbResident: number;
    /** A needle that is not in the file: the scanner's own speed. */
    sparseMbPerSecond: number;
    /** A needle on about one word in ten: dominated by building hits. */
    plainMbPerSecond: number;
    firstHitMs: number;
    caseInsensitiveMbPerSecond: number;
    wholeWordMbPerSecond: number;
    regexMbPerSecond: number;
    hits: number;
    peakRssGrowthMb: number;
}

const rows: Row[] = [];

afterAll(async () => {
    if (rows.length === 0) return;
    console.table(rows);
    const directory = join(fixtureDirectory(), 'results');
    await mkdir(directory, { recursive: true });
    const file = join(directory, `scan-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    await writeFile(
        file,
        JSON.stringify({ node: process.version, platform: process.platform, rows }, null, 2),
    );
    console.log(`Results written to ${file}`);
});

describe.each(SIZES.flatMap((size) => KINDS.map((kind) => ({ kind, size }))))(
    '$kind · $size bytes',
    ({ kind, size }) => {
        it('splits into items and searches within budget', async () => {
            const fixture = await ensureFixture(kind, size);
            const { source } = await openFileSource(fixture.path);
            const reader = new ChunkReader(source);
            const rssBefore = process.memoryUsage().rss;
            let peak = rssBefore;
            const sampler = setInterval(
                () => (peak = Math.max(peak, process.memoryUsage().rss)),
                50,
            );
            try {
                // 1. Statements or documents.
                let items = 0;
                let indexMb = 0;
                let scanMbPerSecond = 0;
                const format = FORMAT[kind];
                if (format) {
                    const start = performance.now();
                    const index = await scanItems(reader, format);
                    scanMbPerSecond = fixture.bytes / MB / ((performance.now() - start) / 1000);
                    items = index.count;
                    indexMb = index.bytes / MB;
                    // Spot-check the index: the middle item starts where a record starts.
                    if (items > 2) {
                        const middle = index.get(Math.floor(items / 2))!;
                        const head = new TextDecoder().decode(
                            await reader.readRange(middle.start, 16),
                        );
                        expect(head.length).toBeGreaterThan(0);
                    }
                }

                // 2. Search: first hit, then whole-file scans in each mode.
                const searchRate = async (query: Parameters<typeof searchFile>[1]) => {
                    const start = performance.now();
                    const result = await searchFile(reader, query, {
                        maxHits: 1_000_000,
                        // Hits are counted, not kept: the host streams them on, and holding a million of
                        // them here would be measuring this script.
                        onHits: () => undefined,
                    });
                    return {
                        mbPerSecond: fixture.bytes / MB / ((performance.now() - start) / 1000),
                        hits: result.hits,
                    };
                };

                const firstStart = performance.now();
                let firstHitMs = -1;
                const controller = new AbortController();
                await searchFile(
                    reader,
                    { text: 'bravo', caseSensitive: true },
                    {
                        signal: controller.signal,
                        flushMs: 0,
                        onHits: () => {
                            if (firstHitMs < 0) {
                                firstHitMs = performance.now() - firstStart;
                                controller.abort();
                            }
                        },
                    },
                ).catch(() => undefined);

                const sparse = await searchRate({ text: 'qzxqzx', caseSensitive: true });
                const plain = await searchRate({ text: 'bravo', caseSensitive: true });
                const folded = await searchRate({ text: 'bravo', caseSensitive: false });
                const word = await searchRate({
                    text: 'bravo',
                    caseSensitive: true,
                    wholeWord: true,
                });
                const pattern = await searchRate({
                    text: 'br[a-z]vo \\w+',
                    regex: true,
                    caseSensitive: true,
                });

                clearInterval(sampler);
                const row: Row = {
                    kind,
                    sizeMb: Math.round(fixture.bytes / MB),
                    items,
                    scanMbPerSecond: Math.round(scanMbPerSecond),
                    indexMbResident: Number(indexMb.toFixed(1)),
                    sparseMbPerSecond: Math.round(sparse.mbPerSecond),
                    plainMbPerSecond: Math.round(plain.mbPerSecond),
                    firstHitMs: Math.round(firstHitMs),
                    caseInsensitiveMbPerSecond: Math.round(folded.mbPerSecond),
                    wholeWordMbPerSecond: Math.round(word.mbPerSecond),
                    regexMbPerSecond: Math.round(pattern.mbPerSecond),
                    hits: plain.hits,
                    peakRssGrowthMb: Math.round((peak - rssBefore) / MB),
                };
                rows.push(row);
                expect(sparse.hits).toBe(0);
                expect(plain.hits).toBeGreaterThan(0);
                expect(folded.hits).toBeGreaterThanOrEqual(plain.hits);
                expect(word.hits).toBeLessThanOrEqual(plain.hits);

                if (ASSERT) {
                    if (format)
                        expect(row.scanMbPerSecond, 'item scan').toBeGreaterThan(
                            TARGETS.scanMbPerSecond,
                        );
                    expect(row.sparseMbPerSecond, 'plain search').toBeGreaterThan(
                        TARGETS.searchMbPerSecond,
                    );
                    expect(row.firstHitMs, 'first hit').toBeLessThan(TARGETS.firstHitMs);
                    expect(row.regexMbPerSecond, 'regex search').toBeGreaterThan(
                        TARGETS.regexMbPerSecond,
                    );
                    expect(row.peakRssGrowthMb, 'memory growth').toBeLessThan(
                        TARGETS.rssGrowthMb + row.indexMbResident,
                    );
                }
            } finally {
                clearInterval(sampler);
                await reader.close();
            }
        });
    },
);
