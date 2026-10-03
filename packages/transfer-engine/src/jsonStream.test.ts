/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { JsonFormat } from '@httpreq/document-engine';
import { JsonDocumentStream, type JsonDocumentInfo } from './jsonStream';

const run = (text: string, format: JsonFormat, piece = Number.MAX_SAFE_INTEGER) => {
    const bytes = Buffer.from(text, 'utf8');
    const docs: { text: string; info: JsonDocumentInfo }[] = [];
    const stream = new JsonDocumentStream({
        format,
        onDocument: (t, info) => docs.push({ text: t, info }),
    });
    for (let i = 0; i < bytes.length; i += piece)
        stream.feed(new Uint8Array(bytes.subarray(i, i + piece)));
    stream.finish();
    return docs;
};
const texts = (text: string, format: JsonFormat, piece?: number) =>
    run(text, format, piece).map((d) => d.text);

describe('JSON document stream', () => {
    it('cuts the elements out of an array', () => {
        expect(
            texts(
                '[\n  {"a": 1},\n  {"b": [1, 2, {"c": "}"}]},\n  "str",\n  42,\n  null\n]\n',
                'array',
            ),
        ).toEqual(['{"a": 1}', '{"b": [1, 2, {"c": "}"}]}', '"str"', '42', 'null']);
    });

    it('is not fooled by brackets and quotes inside strings', () => {
        expect(texts('[{"s": "a ] } [ { \\" , "}, {"t": "\\\\"}]', 'array')).toEqual([
            '{"s": "a ] } [ { \\" , "}',
            '{"t": "\\\\"}',
        ]);
    });

    it('reads JSON Lines, skipping blank lines and a final line without a newline', () => {
        expect(texts('{"a":1}\r\n\r\n{"a":2}\n{"a":3}', 'jsonl')).toEqual([
            '{"a":1}',
            '{"a":2}',
            '{"a":3}',
        ]);
    });

    it('reads a sequence of top-level values', () => {
        expect(texts('{"a":1}{"a":2}\n[1,2] 7 "x"', 'sequence')).toEqual([
            '{"a":1}',
            '{"a":2}',
            '[1,2]',
            '7',
            '"x"',
        ]);
    });

    it('gives the same elements whatever the chunks are cut at', () => {
        const text = '[{"é": "☃😀", "n": [1,{"x":"\\"}"}]},\n{"b": 2},{"c": "end"}]';
        const whole = texts(text, 'array');
        for (const size of [1, 2, 3, 4, 7, 13]) expect(texts(text, 'array', size)).toEqual(whole);
        const lines = '{"é":"☃"}\n{"b":2}\n{"c":3}';
        for (const size of [1, 2, 5])
            expect(texts(lines, 'jsonl', size)).toEqual(texts(lines, 'jsonl'));
        expect(whole[0]).toContain('☃😀');
    });

    it('numbers the elements and gives their lines and end offsets', () => {
        const docs = run('[\n{"a":1},\n{"b":\n2}]', 'array');
        expect(docs.map((d) => [d.info.index, d.info.line])).toEqual([
            [1, 2],
            [2, 3],
        ]);
        const lines = run('{"a":1}\n{"b":2}\n', 'jsonl');
        expect(lines.map((d) => [d.info.index, d.info.line, d.info.byteEnd])).toEqual([
            [1, 1, 8],
            [2, 2, 16],
        ]);
    });

    it('resumes JSON Lines in the middle of a file', () => {
        const docs: JsonDocumentInfo[] = [];
        const stream = new JsonDocumentStream({
            format: 'jsonl',
            onDocument: (_t, info) => docs.push(info),
            startByte: 8,
            startLine: 2,
            startIndex: 2,
        });
        stream.feed(new Uint8Array(Buffer.from('{"b":2}\n')));
        stream.finish();
        expect(docs[0]).toEqual({ index: 2, line: 2, byteEnd: 16 });
    });

    it('reports a file that ends mid-element, text before the array and text after it', () => {
        expect(() => run('[{"a": 1}, {"b": ', 'array')).toThrow(/ends in the middle of element 2/);
        expect(() => run('{"a":1}', 'array')).toThrow(/does not start with \[/);
        expect(() => run('[1] junk', 'array')).toThrow(/after the end/);
    });

    it('hands over malformed elements for the consumer to reject, and carries on', () => {
        const items = texts('[{"a": 1}, {"b": oops}, {"c": 3}]', 'array');
        expect(items).toEqual(['{"a": 1}', '{"b": oops}', '{"c": 3}']);
        expect(() => JSON.parse(items[1]!)).toThrow();
    });

    it('refuses an element larger than the limit', () => {
        const stream = new JsonDocumentStream({
            format: 'array',
            onDocument: () => undefined,
            maxDocumentBytes: 100,
        });
        expect(() => stream.feed(new Uint8Array(Buffer.from(`[{"a":"${'x'.repeat(500)}`)))).toThrow(
            /larger than/,
        );
    });

    it('streams a large array without holding it', () => {
        let count = 0;
        const stream = new JsonDocumentStream({ format: 'array', onDocument: () => void count++ });
        stream.feed(new Uint8Array(Buffer.from('[')));
        const piece = Buffer.from('{"id":1,"name":"abcdefghij","tags":["a","b"]},'.repeat(1000));
        for (let i = 0; i < 100; i++) stream.feed(new Uint8Array(piece));
        stream.feed(new Uint8Array(Buffer.from('{}]')));
        stream.finish();
        expect(count).toBe(100_001);
    });
});
