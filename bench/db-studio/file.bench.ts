/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
    FileHostService,
    IndexStore,
    type FileOpenedResult,
    type FileProgressEvent,
} from '@httpreq/file-engine';
import {
    FIXTURE_KINDS,
    ensureFixture,
    fixtureDirectory,
    parseSize,
    type FixtureKind,
} from './fixtures';

/**
 * Phase 1 benchmarks: open, index, cached reopen and go-to-line on files from 100 MB to 3 GB,
 * measured through the same `FileHostService` the desktop app runs in its File Host process.
 *
 * Targets are the ones in docs/database-studio.md, section 7. They are asserted unless
 * BENCH_ASSERT=0, so a slower machine can still collect numbers.
 */

const SIZES = (process.env.BENCH_SIZES ?? '100MB,500MB').split(',').map(parseSize);
const KINDS = (process.env.BENCH_KINDS ?? FIXTURE_KINDS.join(',')).split(',') as FixtureKind[];
const ASSERT = process.env.BENCH_ASSERT !== '0';

const TARGETS = {
    firstScreenMs: 500,
    indexMbPerSecond: 100,
    gotoP95Ms: 50,
    reopenMs: 500,
    rssGrowthMb: 400,
};

const MB = 1024 * 1024;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const percentile = (sorted: number[], p: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;

interface Row {
    kind: string;
    sizeMb: number;
    lines: number;
    firstScreenMs: number;
    indexSeconds: number;
    indexMbPerSecond: number;
    peakRssGrowthMb: number;
    reopenMs: number;
    gotoP50Ms: number;
    gotoP95Ms: number;
    gotoLastMs: number;
}

const rows: Row[] = [];

afterAll(async () => {
    if (rows.length === 0) return;
    console.table(rows);
    const directory = join(fixtureDirectory(), 'results');
    await mkdir(directory, { recursive: true });
    const file = join(directory, `file-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    await writeFile(
        file,
        JSON.stringify({ node: process.version, platform: process.platform, rows }, null, 2),
    );
    console.log(`Results written to ${file}`);
});

describe.each(SIZES.flatMap((size) => KINDS.map((kind) => ({ kind, size }))))(
    '$kind · $size bytes',
    ({ kind, size }) => {
        it('opens, indexes, reopens and seeks within budget', async () => {
            const fixture = await ensureFixture(kind, size);
            const cache = await mkdtemp(join(tmpdir(), 'hr-bench-index-'));
            try {
                const events: FileProgressEvent[] = [];
                const context = {
                    emit: (_topic: string, payload: unknown) =>
                        events.push(payload as FileProgressEvent),
                    signal: new AbortController().signal,
                };
                const waitReady = async (timeoutMs = 30 * 60_000): Promise<FileProgressEvent> => {
                    const deadline = Date.now() + timeoutMs;
                    while (Date.now() < deadline) {
                        const done = events.find(
                            (event) => event.state === 'ready' || event.state === 'failed',
                        );
                        if (done) return done;
                        await sleep(10);
                    }
                    throw new Error('indexing did not finish');
                };

                const host = new FileHostService({ indexStore: new IndexStore(cache) });

                // 1. Open to first screen, while the index is still being built.
                global.gc?.();
                const rssBefore = process.memoryUsage().rss;
                let peakRss = rssBefore;
                const sampler = setInterval(
                    () => (peakRss = Math.max(peakRss, process.memoryUsage().rss)),
                    50,
                );

                const startedAt = performance.now();
                const opened = (await host.open(fixture.path, context)) as FileOpenedResult;
                let first = await host.readLines(opened.fileId, 0, 40);
                while (first.lines.length === 0 && !first.complete) {
                    await sleep(5);
                    first = await host.readLines(opened.fileId, 0, 40);
                }
                const firstScreenMs = performance.now() - startedAt;

                // 2. The full index.
                const ready = await waitReady();
                const indexSeconds = (performance.now() - startedAt) / 1000;
                clearInterval(sampler);
                expect(ready.state).toBe('ready');
                expect(ready.lines).toBe(fixture.lines);
                const peakRssGrowthMb = (peakRss - rssBefore) / MB;

                // 3. Go-to-line: random positions and the very last line.
                const samples: number[] = [];
                let seed = 12345;
                for (let i = 0; i < 50; i++) {
                    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
                    const target = seed % fixture.lines;
                    const t = performance.now();
                    const result = await host.readLines(opened.fileId, target, 40);
                    samples.push(performance.now() - t);
                    expect(result.lines[0]?.line).toBe(target);
                }
                samples.sort((a, b) => a - b);
                const lastStart = performance.now();
                const last = await host.readLines(opened.fileId, fixture.lines - 1, 1);
                const gotoLastMs = performance.now() - lastStart;
                expect(last.lines[0]?.line).toBe(fixture.lines - 1);
                await host.close(opened.fileId);

                // 4. Reopen from the cached index.
                events.length = 0;
                const reopenStart = performance.now();
                const again = (await host.open(fixture.path, context)) as FileOpenedResult;
                await waitReady(60_000);
                const reopenMs = performance.now() - reopenStart;
                await host.close(again.fileId);

                const row: Row = {
                    kind,
                    sizeMb: Math.round(fixture.bytes / MB),
                    lines: fixture.lines,
                    firstScreenMs: Math.round(firstScreenMs),
                    indexSeconds: Number(indexSeconds.toFixed(2)),
                    indexMbPerSecond: Math.round(fixture.bytes / MB / indexSeconds),
                    peakRssGrowthMb: Math.round(peakRssGrowthMb),
                    reopenMs: Math.round(reopenMs),
                    gotoP50Ms: Number(percentile(samples, 0.5).toFixed(1)),
                    gotoP95Ms: Number(percentile(samples, 0.95).toFixed(1)),
                    gotoLastMs: Number(gotoLastMs.toFixed(1)),
                };
                rows.push(row);

                if (ASSERT) {
                    expect(row.firstScreenMs, 'first screen').toBeLessThan(TARGETS.firstScreenMs);
                    expect(row.indexMbPerSecond, 'index throughput').toBeGreaterThan(
                        TARGETS.indexMbPerSecond,
                    );
                    expect(row.gotoP95Ms, 'go-to-line p95').toBeLessThan(TARGETS.gotoP95Ms);
                    expect(row.reopenMs, 'cached reopen').toBeLessThan(TARGETS.reopenMs);
                    expect(row.peakRssGrowthMb, 'memory growth').toBeLessThan(TARGETS.rssGrowthMb);
                }
            } finally {
                await rm(cache, { recursive: true, force: true });
            }
        });

        if (kind === 'json-minified') {
            it('shows a one-line file without loading the line', async () => {
                const fixture = await ensureFixture(kind, size);
                const host = new FileHostService();
                const context = { emit: () => undefined, signal: new AbortController().signal };
                const opened = (await host.open(fixture.path, context)) as FileOpenedResult;
                const start = performance.now();
                let result = await host.readLines(opened.fileId, 0, 1);
                while (result.lines.length === 0 && !result.complete) {
                    await sleep(5);
                    result = await host.readLines(opened.fileId, 0, 1);
                }
                const elapsed = performance.now() - start;
                await host.close(opened.fileId);
                // The line is hundreds of megabytes; what comes back is cut at the display limit.
                expect(result.lines[0]?.truncated).toBe(true);
                expect(result.lines[0]!.text.length).toBeLessThanOrEqual(64 * 1024);
                if (ASSERT) expect(elapsed).toBeLessThan(TARGETS.firstScreenMs);
            });
        }
    },
);
