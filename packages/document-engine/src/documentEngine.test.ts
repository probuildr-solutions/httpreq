/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
    DOC_ERROR,
    DOC_TRUNCATED,
    JsonDocumentScanner,
    detectJsonFormat,
    parseDocument,
    previewText,
    tokenizeJsonLine,
    type JsonFormat,
} from './index';

const encode = (text: string) => new TextEncoder().encode(text);

interface Found {
    text: string;
    error: boolean;
    truncated: boolean;
}

const scan = (text: string, format: JsonFormat, chunkSize = Infinity): Found[] => {
    const bytes = encode(text);
    const scanner = new JsonDocumentScanner(format);
    const step = Math.min(chunkSize, Math.max(1, bytes.length));
    for (let offset = 0; offset < bytes.length; offset += step) {
        scanner.feed(bytes.subarray(offset, offset + step), offset);
    }
    const index = scanner.finish(bytes.length);
    const out: Found[] = [];
    for (let i = 0; i < index.count; i++) {
        const range = index.get(i)!;
        out.push({
            text: new TextDecoder().decode(bytes.subarray(range.start, range.end)),
            error: (range.flags & DOC_ERROR) !== 0,
            truncated: (range.flags & DOC_TRUNCATED) !== 0,
        });
    }
    return out;
};

const texts = (found: Found[]) => found.map((f) => f.text);

describe('JSON Lines', () => {
    it('indexes one document per line, trimming whitespace and skipping blank lines', () => {
        const found = scan('{"a":1}\n\n  {"b":2}  \r\n{"c":3}', 'jsonl');
        expect(texts(found)).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
        expect(found.every((f) => !f.error)).toBe(true);
    });

    it('gives the same index for any chunking, including one byte at a time', () => {
        const text = '{"a":"x y"}\r\n \n\t{"b":[1,2,{"c":"d"}]}\n{"e":null}  ';
        const whole = scan(text, 'jsonl');
        expect(whole).toHaveLength(3);
        for (const chunkSize of [1, 2, 3, 5, 8, 100]) {
            expect(scan(text, 'jsonl', chunkSize), `chunk ${chunkSize}`).toEqual(whole);
        }
    });

    it('does not depend on the content being valid JSON', () => {
        expect(texts(scan('{"a":1}\nnot json at all\n{"b":2}', 'jsonl'))).toEqual([
            '{"a":1}',
            'not json at all',
            '{"b":2}',
        ]);
    });

    it('is empty for an empty or blank file', () => {
        expect(scan('', 'jsonl')).toEqual([]);
        expect(scan(' \n\n \r\n', 'jsonl')).toEqual([]);
    });
});

describe('JSON array', () => {
    const array =
        '[\n  {"a": 1, "s": "x]},\\"{"},\n  {"b": [1, 2, {"c": 3}]},\n  "text",\n  42,\n  true\n]\n';

    it('finds each element without parsing it', () => {
        expect(texts(scan(array, 'array'))).toEqual([
            '{"a": 1, "s": "x]},\\"{"}',
            '{"b": [1, 2, {"c": 3}]}',
            '"text"',
            '42',
            'true',
        ]);
    });

    it('is not fooled by brackets, commas and escaped quotes inside strings', () => {
        const found = scan('[{"k":"a,b]}{[\\\\\\"\\\\"},{"k":"\\u00e9日本"}]', 'array');
        expect(found).toHaveLength(2);
        expect(found.every((f) => !f.error)).toBe(true);
        expect(JSON.parse(found[1]!.text)).toEqual({ k: 'é日本' });
    });

    it('gives the same index for any chunking', () => {
        const whole = scan(array, 'array');
        for (const chunkSize of [1, 2, 3, 7, 16, 1000]) {
            expect(scan(array, 'array', chunkSize), `chunk ${chunkSize}`).toEqual(whole);
        }
    });

    it('handles an empty array, a byte order mark and nested arrays', () => {
        expect(scan('[]', 'array')).toEqual([]);
        expect(scan('[ ]\n', 'array')).toEqual([]);
        expect(texts(scan('﻿[[1,2],[3]]', 'array'))).toEqual(['[1,2]', '[3]']);
    });

    it('flags an element cut off by the end of the file', () => {
        const found = scan('[{"a":1},{"b":', 'array');
        expect(texts(found)).toEqual(['{"a":1}', '{"b":']);
        expect(found[1]).toMatchObject({ error: true, truncated: true });
    });

    it('skips a damaged element and carries on with the next line', () => {
        const text = '[\n{"a":1},\n{"b":2]},\n{"c":3},\n{"d":4}\n]';
        const found = scan(text, 'array');
        expect(found.map((f) => f.error)).toEqual([false, true, false, false]);
        expect(found.filter((f) => !f.error).map((f) => JSON.parse(f.text))).toEqual([
            { a: 1 },
            { c: 3 },
            { d: 4 },
        ]);
        // The same recovery whatever the chunking.
        for (const chunkSize of [1, 4, 9]) expect(scan(text, 'array', chunkSize)).toEqual(found);
    });

    it('reports a file that is not an array at all', () => {
        const [first] = scan('{"a":1}', 'array');
        expect(first?.error).toBe(true);
    });

    it('rejects nesting deeper than the limit instead of growing without bound', () => {
        const deep = `[${'['.repeat(5000)}]`;
        const found = scan(deep, 'array');
        expect(found[0]?.error).toBe(true);
    });
});

describe('sequence of values', () => {
    it('reads a single pretty-printed document', () => {
        const text = '{\n  "a": 1,\n  "b": {\n    "c": [1, 2]\n  }\n}\n';
        expect(texts(scan(text, 'sequence'))).toEqual([text.trim()]);
    });

    it('reads several documents laid out any way, with or without commas', () => {
        expect(texts(scan('{"a":1}{"b":2}\n{\n"c":3\n},{"d":4}', 'sequence'))).toEqual([
            '{"a":1}',
            '{"b":2}',
            '{\n"c":3\n}',
            '{"d":4}',
        ]);
    });
});

describe('detectJsonFormat', () => {
    const head = (text: string) => encode(text);

    it('uses the extension when it is decisive', () => {
        expect(detectJsonFormat(head('[1]'), '.ndjson')).toBe('jsonl');
        expect(detectJsonFormat(head('[1]'), 'JSONL')).toBe('jsonl');
    });

    it('recognizes arrays, JSON Lines and a single multi-line document', () => {
        expect(detectJsonFormat(head('﻿  [\n{"a":1}]'))).toBe('array');
        expect(detectJsonFormat(head('{"a":1}\n{"b":2}\n'))).toBe('jsonl');
        expect(detectJsonFormat(head('{"a":1}'))).toBe('jsonl');
        expect(detectJsonFormat(head('{\n  "a": 1\n}\n'))).toBe('sequence');
        expect(detectJsonFormat(head('"just a string"'))).toBe('sequence');
    });
});

describe('lazy document access', () => {
    it('parses one document, rejects bad ones and caps their size', () => {
        expect(parseDocument(encode('{"a":[1,2]}'))).toEqual({ a: [1, 2] });
        expect(() => parseDocument(encode('{"a":'))).toThrow(/not valid JSON/);
        expect(() => parseDocument(encode('{"a":1}'), 3)).toThrow(/too large/);
    });

    it('previews a document on one line', () => {
        expect(previewText('{\n  "a":   1\n}')).toBe('{ "a": 1 }');
        expect(previewText('x'.repeat(500), 10)).toBe('xxxxxxxxxx…');
    });
});

describe('tokenizeJsonLine', () => {
    const kinds = (line: string) =>
        tokenizeJsonLine(line)
            .filter((token) => token.type !== 'whitespace')
            .map((token) => [token.type, line.slice(token.start, token.end)]);

    it('tells keys from values and finds every kind of token', () => {
        expect(kinds('  "name": "Ada", "n": -1.5e3, "ok": true, "x": null, "a": [1, {}]')).toEqual([
            ['key', '"name"'],
            ['punctuation', ':'],
            ['string', '"Ada"'],
            ['punctuation', ','],
            ['key', '"n"'],
            ['punctuation', ':'],
            ['number', '-1.5e3'],
            ['punctuation', ','],
            ['key', '"ok"'],
            ['punctuation', ':'],
            ['keyword', 'true'],
            ['punctuation', ','],
            ['key', '"x"'],
            ['punctuation', ':'],
            ['keyword', 'null'],
            ['punctuation', ','],
            ['key', '"a"'],
            ['punctuation', ':'],
            ['punctuation', '['],
            ['number', '1'],
            ['punctuation', ','],
            ['punctuation', '{'],
            ['punctuation', '}'],
            ['punctuation', ']'],
        ]);
    });

    it('handles escapes and unterminated strings, and flags what is not JSON', () => {
        expect(kinds('"a\\"b: c"')).toEqual([['string', '"a\\"b: c"']]);
        expect(kinds('"open')).toEqual([['string', '"open']]);
        expect(kinds('nope @')).toEqual([
            ['invalid', 'nope'],
            ['invalid', '@'],
        ]);
    });

    it('covers the whole line with no gaps', () => {
        const line = '{"a": [1, 2.5, "x"], "b": false}';
        let at = 0;
        for (const token of tokenizeJsonLine(line)) {
            expect(token.start).toBe(at);
            at = token.end;
        }
        expect(at).toBe(line.length);
    });
});
