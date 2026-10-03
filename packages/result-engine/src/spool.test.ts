/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

// @vitest-environment node
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DbValue } from '@httpreq/db-core';
import { ResultSpool, clipPage, MAX_CELL_CHARS } from './index';

let directory: string;
beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'hr-spool-'));
});
afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
});

const row = (i: number): DbValue[] => [i, `row ${i}`, i % 3 === 0 ? null : i * 1.5];

describe('ResultSpool', () => {
    it('stores rows in pages and reads any page back, in any order', async () => {
        const spool = await ResultSpool.create({ directory, pageRows: 100 });
        for (let at = 0; at < 1_050; at += 70) {
            await spool.append(
                Array.from({ length: Math.min(70, 1_050 - at) }, (_, k) => row(at + k)),
            );
        }
        await spool.finish();
        expect(spool.rowCount).toBe(1_050);
        expect(spool.pageCount).toBe(11);
        for (const index of [10, 0, 5, 10, 3]) {
            const page = (await spool.page(index))!;
            expect(page.firstRow).toBe(index * 100);
            expect(page.rows[0]).toEqual(row(index * 100));
            expect(page.rows.length).toBe(index === 10 ? 50 : 100);
        }
        expect(await spool.page(11)).toBeNull();
        expect(await spool.page(-1)).toBeNull();
        await spool.dispose();
    });

    it('serves the open page before it is flushed', async () => {
        const spool = await ResultSpool.create({ directory, pageRows: 100 });
        await spool.append([row(0), row(1)]);
        expect((await spool.page(0))!.rows).toEqual([row(0), row(1)]);
        await spool.append(Array.from({ length: 98 }, (_, i) => row(i + 2)));
        expect(spool.pageCount).toBe(1);
        expect((await spool.page(0))!.rows).toHaveLength(100);
        await spool.dispose();
    });

    it('round-trips every kind of value', async () => {
        const values: DbValue[] = [
            null,
            true,
            false,
            0,
            -1.5,
            2 ** 40,
            12345678901234567890n,
            'text 日本',
            '',
            new Uint8Array([0, 255, 7]),
            new Date('2026-10-03T00:00:00Z'),
            { $type: 'objectId', $value: 'abc' },
            [1, [2, 3]],
            { a: { b: null } },
        ];
        const spool = await ResultSpool.create({ directory, pageRows: 1 });
        await spool.append([values]);
        await spool.finish();
        expect((await spool.page(0))!.rows[0]).toEqual(values);
        await spool.dispose();
    });

    it('closes a page early when its rows are wide, so memory stays bounded', async () => {
        const spool = await ResultSpool.create({ directory, pageRows: 1_000, pageBytes: 50_000 });
        await spool.append(Array.from({ length: 40 }, (_, i) => [i, 'x'.repeat(10_000)]));
        await spool.finish();
        expect(spool.pageCount).toBeGreaterThan(5);
        expect(spool.rowCount).toBe(40);
        // A row can still be found whichever page it landed on.
        expect(await spool.cell(33, 0)).toBe(33);
        expect(((await spool.cell(39, 1)) as string).length).toBe(10_000);
        await spool.dispose();
    });

    it('locates rows and reads single cells', async () => {
        const spool = await ResultSpool.create({ directory, pageRows: 10 });
        await spool.append(Array.from({ length: 25 }, (_, i) => row(i)));
        await spool.finish();
        expect(spool.locate(0)).toEqual({ page: 0, offset: 0 });
        expect(spool.locate(24)).toEqual({ page: 2, offset: 4 });
        expect(spool.locate(25)).toBeNull();
        expect(await spool.cell(12, 1)).toBe('row 12');
        await expect(spool.cell(99, 0)).rejects.toMatchObject({ code: 'NOT_FOUND' });
        await expect(spool.cell(1, 9)).rejects.toMatchObject({ code: 'NOT_FOUND' });
        await spool.dispose();
    });

    it('stops storing rows at its size limit and says so', async () => {
        const spool = await ResultSpool.create({ directory, pageRows: 100, maxBytes: 20_000 });
        let accepted = true;
        for (let batch = 0; batch < 100 && accepted; batch++) {
            accepted = await spool.append(
                Array.from({ length: 100 }, (_, i) => [batch * 100 + i, 'y'.repeat(100)]),
            );
        }
        await spool.finish();
        expect(accepted).toBe(false);
        expect(spool.capped).toBe(true);
        expect(spool.diskBytes).toBeLessThanOrEqual(20_000);
        // What was stored is intact and consistent.
        const stored = spool.rowCount;
        expect(stored).toBeGreaterThan(0);
        expect(stored % 100).toBe(0);
        expect(await spool.cell(stored - 1, 0)).toBe(stored - 1);
        await spool.dispose();
    });

    it('removes its file when disposed', async () => {
        const spool = await ResultSpool.create({ directory, pageRows: 10 });
        await spool.append(Array.from({ length: 50 }, (_, i) => row(i)));
        expect((await readdir(directory)).length).toBe(1);
        await spool.dispose();
        expect(await readdir(directory)).toEqual([]);
        await spool.dispose(); // idempotent
    });

    it('keeps millions of rows in bounded memory', async () => {
        const spool = await ResultSpool.create({ directory, pageRows: 1_000, cachePages: 4 });
        const before = process.memoryUsage().heapUsed;
        for (let at = 0; at < 1_000_000; at += 5_000) {
            await spool.append(
                Array.from({ length: 5_000 }, (_, k) => [
                    at + k,
                    `value ${at + k}`,
                    (at + k) * 0.5,
                ]),
            );
        }
        await spool.finish();
        expect(spool.rowCount).toBe(1_000_000);
        const growth = process.memoryUsage().heapUsed - before;
        expect(growth).toBeLessThan(80 * 1024 * 1024);
        expect((await spool.page(500))!.rows[0]![0]).toBe(500_000);
        expect(spool.diskBytes).toBeGreaterThan(10 * 1024 * 1024);
        await spool.dispose();
    }, 120_000);
});

describe('clipPage', () => {
    it('cuts wide text and binary cells and lists them', () => {
        const wide = 'a'.repeat(MAX_CELL_CHARS + 500);
        const { rows, clipped } = clipPage([
            [1, 'short', wide],
            [2, new Uint8Array(1_000), null],
        ]);
        expect((rows[0]![2] as string).length).toBe(MAX_CELL_CHARS);
        expect(rows[1]![0] as number).toBe(2);
        expect((rows[1]![1] as Uint8Array).length).toBe(256);
        expect(clipped).toEqual([
            { row: 0, column: 2, length: MAX_CELL_CHARS + 500 },
            { row: 1, column: 1, length: 1_000 },
        ]);
        expect(clipPage([[1, 'x']]).clipped).toEqual([]);
    });
});
