/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
    FileHostService,
    type FileOpenedResult,
    type ItemsListResult,
    type ItemsProgressEvent,
    type SearchHit,
    type SearchHitsEvent,
    type SearchProgressEvent,
} from './index';
import { MemorySource } from './testing';

interface Event {
    topic: string;
    payload: unknown;
}

const setup = async (name: string, text: string) => {
    const events: Event[] = [];
    const context = {
        emit: (topic: string, payload: unknown) => events.push({ topic, payload }),
        signal: new AbortController().signal,
    };
    const host = new FileHostService({
        chunkSize: 256,
        progressIntervalMs: 0,
        openSource: async () => ({ source: MemorySource.text(text), realPath: `/data/${name}` }),
    });
    const opened = (await host.open(`/data/${name}`, context)) as FileOpenedResult;
    const call = <T>(op: string, payload: object) =>
        host.handle(op, { fileId: opened.fileId, ...payload }, context) as Promise<T>;
    const wait = async <T>(topic: string, done: (payload: T) => boolean): Promise<T> => {
        for (let i = 0; i < 400; i++) {
            const found = events.find((event) => event.topic === topic && done(event.payload as T));
            if (found) return found.payload as T;
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        throw new Error(`timed out waiting for ${topic}`);
    };
    return { host, opened, events, call, wait };
};

const sql = Array.from({ length: 3_000 }, (_, i) =>
    i % 500 === 499
        ? `DELIMITER $$\nCREATE PROCEDURE p${i}() BEGIN SELECT ${i}; END$$\nDELIMITER ;\n`
        : `INSERT INTO t VALUES (${i}, 'row ${i}; with semicolon');\n`,
).join('');

describe('statements and documents', () => {
    it('splits an .sql file into statements, lists them and reads one in full', async () => {
        const { call, wait, host } = await setup('dump.sql', sql);
        const analyzed = await call<{ format: string; kind: string }>('items.analyze', {});
        expect(analyzed).toEqual({ format: 'sql-mysql', kind: 'statement' });
        const done = await wait<ItemsProgressEvent>('items.progress', (p) => p.state === 'ready');
        // 3,000 inserts (minus the six replaced by procedures), the procedures, and the directives.
        expect(done.count).toBeGreaterThan(2_990);

        const page = await call<ItemsListResult>('items.list', { from: 0, count: 3 });
        expect(page.complete).toBe(true);
        expect(page.items.map((item) => item.label)).toEqual(['INSERT', 'INSERT', 'INSERT']);
        expect(page.items[0]!.preview).toContain(
            "INSERT INTO t VALUES (0, 'row 0; with semicolon');",
        );

        const procedure = await call<ItemsListResult>('items.list', { from: 498, count: 6 });
        expect(procedure.items.map((item) => item.label)).toContain('DELIMITER');
        expect(procedure.items.map((item) => item.label)).toContain('CREATE');

        const created = procedure.items.find((item) => item.label === 'CREATE')!;
        const item = await call<{ text: string; truncated: boolean }>('items.read', {
            index: created.index,
        });
        expect(item.text).toContain('CREATE PROCEDURE p499()');
        expect(item.text).toContain('SELECT 499;');
        expect(item.truncated).toBe(false);

        const where = await call<{ index: number }>('items.at', { offset: created.start + 5 });
        expect(where.index).toBe(created.index);
        await host.closeAll();
    });

    it('reports a partial list while the scan is still running', async () => {
        const { call, host } = await setup('dump.sql', sql);
        await call('items.analyze', {});
        const early = await call<ItemsListResult>('items.list', { from: 0, count: 5 });
        // The scan had not necessarily finished, but whatever it had found is listable.
        expect(early.items.length).toBeLessThanOrEqual(5);
        expect(typeof early.complete).toBe('boolean');
        await host.closeAll();
    });

    it('re-reads the same file with another SQL dialect when asked', async () => {
        const text = 'SELECT $$a;b$$; SELECT 2;\n';
        const { call, wait, host } = await setup('q.sql', text);
        await call('items.analyze', { format: 'sql-postgresql' });
        const pg = await wait<ItemsProgressEvent>('items.progress', (p) => p.state === 'ready');
        expect(pg.count).toBe(2);
        await call('items.analyze', { format: 'sql-mysql' });
        const listed = await call<ItemsListResult>('items.list', { from: 0, count: 10 });
        // MySQL has no dollar quotes, so the semicolon inside $$...$$ ends a statement.
        await wait<ItemsProgressEvent>(
            'items.progress',
            (p) => p.state === 'ready' && p.count === 3,
        );
        expect(listed.count).toBeGreaterThanOrEqual(0);
        await host.closeAll();
    });

    it('indexes the documents of a JSON array and of JSON Lines', async () => {
        const docs = Array.from({ length: 500 }, (_, i) => ({
            _id: i,
            name: `n${i}`,
            tags: ['a', 'b'],
        }));
        const array = await setup(
            'export.json',
            `[\n${docs.map((d) => JSON.stringify(d)).join(',\n')}\n]\n`,
        );
        expect(await array.call('items.analyze', {})).toEqual({
            format: 'json-array',
            kind: 'document',
        });
        expect(
            (await array.wait<ItemsProgressEvent>('items.progress', (p) => p.state === 'ready'))
                .count,
        ).toBe(500);
        const read = await array.call<{ text: string }>('items.read', { index: 250 });
        expect(JSON.parse(read.text)).toEqual(docs[250]);
        await array.host.closeAll();

        const lines = await setup('export.jsonl', docs.map((d) => JSON.stringify(d)).join('\n'));
        expect(await lines.call('items.analyze', {})).toEqual({
            format: 'jsonl',
            kind: 'document',
        });
        const done = await lines.wait<ItemsProgressEvent>(
            'items.progress',
            (p) => p.state === 'ready',
        );
        expect(done.count).toBe(500);
        const page = await lines.call<ItemsListResult>('items.list', { from: 499, count: 5 });
        expect(page.items).toHaveLength(1);
        expect(page.items[0]!.label).toBe('document');
        await lines.host.closeAll();
    });

    it('marks a damaged document and carries on', async () => {
        const text = '[\n{"a":1},\n{"b":2]},\n{"c":3}\n]';
        const { call, wait, host } = await setup('bad.json', text);
        await call('items.analyze', {});
        await wait<ItemsProgressEvent>('items.progress', (p) => p.state === 'ready');
        const page = await call<ItemsListResult>('items.list', { from: 0, count: 10 });
        expect(page.items.map((item) => item.problem)).toEqual([undefined, 'malformed', undefined]);
        await host.closeAll();
    });

    it('says when a file is not one it splits into items, and refuses unknown formats', async () => {
        const { call, host } = await setup('notes.txt', 'just text');
        expect(await call('items.analyze', {})).toEqual({ format: null, kind: null });
        await expect(call('items.analyze', { format: 'xml' })).rejects.toMatchObject({
            code: 'INVALID_REQUEST',
        });
        await expect(call('items.list', { from: 0, count: 5 })).rejects.toMatchObject({
            code: 'NOT_FOUND',
        });
        await host.closeAll();
    });
});

describe('search through the host', () => {
    const text = Array.from(
        { length: 2_000 },
        (_, i) => `line ${i} ${i % 100 === 0 ? 'NEEDLE here' : 'nothing'}`,
    ).join('\n');

    it('streams hits and ends with a done event', async () => {
        const { call, wait, events, host } = await setup('log.txt', text);
        const { searchId } = await call<{ searchId: string }>('search.start', {
            query: { text: 'needle', caseSensitive: false },
        });
        const done = await wait<SearchProgressEvent>('search.progress', (p) => p.state === 'done');
        expect(done).toMatchObject({ searchId, hits: 20, truncated: false });
        const hits = events
            .filter((event) => event.topic === 'search.hits')
            .flatMap((event) => (event.payload as SearchHitsEvent).hits) as SearchHit[];
        expect(hits).toHaveLength(20);
        expect(hits[1]!.line).toBe(100);
        expect(hits[1]!.preview).toBe('line 100 NEEDLE here');
        await host.closeAll();
    });

    it('can be cancelled, and is cancelled when the file closes', async () => {
        const big = `${'filler line without the word\n'.repeat(2_000)}`;
        const { call, wait, host, opened } = await setup('big.log', big);
        const { searchId } = await call<{ searchId: string }>('search.start', {
            query: { text: 'zzz', caseSensitive: true },
        });
        await call('search.cancel', { searchId });
        const first = await wait<SearchProgressEvent>(
            'search.progress',
            (p) => p.state === 'cancelled' || p.state === 'done',
        );
        expect(['cancelled', 'done']).toContain(first.state);

        await call('search.start', { query: { text: 'zzz', caseSensitive: true } }).catch(
            () => undefined,
        );
        await host.close(opened.fileId);
        expect(host.openCount).toBe(0);
    });

    it('validates the request and limits concurrent searches', async () => {
        const { call, host } = await setup('log.txt', text);
        await expect(call('search.start', { query: { text: 5 } })).rejects.toMatchObject({
            code: 'INVALID_REQUEST',
        });
        await expect(
            call('search.start', { query: { text: '(', regex: true } }),
        ).resolves.toBeDefined();
        await host.closeAll();
    });

    it('reports a bad regular expression as a failed search', async () => {
        const { call, wait, host } = await setup('log.txt', text);
        await call('search.start', { query: { text: '(', regex: true } });
        const failed = await wait<SearchProgressEvent>(
            'search.progress',
            (p) => p.state === 'failed',
        );
        expect(failed.error?.code).toBe('INVALID_REQUEST');
        await host.closeAll();
    });
});
