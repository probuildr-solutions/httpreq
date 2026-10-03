/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { CsvParser, csvLine, detectDelimiter, type CsvRecordInfo } from './csv';

const parse = (
    text: string,
    pieceSize = text.length || 1,
    options: { delimiter?: string } = {},
) => {
    const records: { fields: string[]; info: CsvRecordInfo }[] = [];
    const parser = new CsvParser({
        ...options,
        onRecord: (fields, info) => records.push({ fields, info }),
    });
    for (let i = 0; i < text.length; i += pieceSize) parser.feed(text.slice(i, i + pieceSize));
    parser.finish();
    return records;
};
const fieldsOf = (text: string, pieceSize?: number) => parse(text, pieceSize).map((r) => r.fields);

describe('CSV parser', () => {
    it('reads plain, quoted and empty fields', () => {
        expect(fieldsOf('a,b,c\n1,"two, 2",\n')).toEqual([
            ['a', 'b', 'c'],
            ['1', 'two, 2', ''],
        ]);
    });

    it('reads doubled quotes, embedded line breaks and quotes in the middle of a field', () => {
        expect(fieldsOf('"say ""hi""","line1\nline2",x"y\n')).toEqual([
            ['say "hi"', 'line1\nline2', 'x"y'],
        ]);
    });

    it('handles CRLF, a lone CR, a missing final newline and blank lines', () => {
        expect(fieldsOf('a,b\r\n\r\nc,d\re,f')).toEqual([
            ['a', 'b'],
            ['c', 'd'],
            ['e', 'f'],
        ]);
    });

    it('gives the same records whatever the pieces are cut at', () => {
        const text = 'id,note\r\n1,"a ""quoted"",\r\nmulti-line"\r\n2,é☃😀\r\n3,end';
        const whole = fieldsOf(text);
        for (const size of [1, 2, 3, 5, 7]) expect(fieldsOf(text, size)).toEqual(whole);
        expect(whole[2]).toEqual(['2', 'é☃😀']);
    });

    it('reports the record, the line it starts on and the byte offset after it', () => {
        const records = parse('a,b\n"x\ny",z\nlast,1\n');
        expect(records.map((r) => [r.info.record, r.info.line])).toEqual([
            [1, 1],
            [2, 2],
            [3, 4],
        ]);
        const text = 'é,b\n"x\ny",z\nlast,1\n';
        const byteEnds = parse(text, 3).map((r) => r.info.byteEnd);
        expect(byteEnds).toEqual([
            Buffer.byteLength('é,b\n'),
            Buffer.byteLength('é,b\n"x\ny",z\n'),
            Buffer.byteLength(text),
        ]);
    });

    it('resumes in the middle of a file with the right numbers', () => {
        const head = 'a,b\n1,2\n';
        const records: CsvRecordInfo[] = [];
        const parser = new CsvParser({
            onRecord: (_fields, info) => records.push(info),
            startByte: Buffer.byteLength(head),
            startLine: 3,
            startRecord: 3,
        });
        parser.feed('3,4\n');
        parser.finish();
        expect(records[0]).toMatchObject({
            record: 3,
            line: 3,
            byteEnd: Buffer.byteLength(`${head}3,4\n`),
        });
    });

    it('supports other delimiters', () => {
        expect(parse('a;b;"c;d"\n', 4, { delimiter: ';' })[0]!.fields).toEqual(['a', 'b', 'c;d']);
    });

    it('stops at a record that never ends, and reports a quote left open', () => {
        const parser = new CsvParser({ onRecord: () => undefined, maxRecordChars: 100 });
        expect(() => parser.feed(`"${'x'.repeat(200)}`)).toThrow(/larger than/);
        const open = new CsvParser({ onRecord: () => undefined });
        open.feed('a,"never closed');
        expect(() => open.finish()).toThrow(/ends inside a quoted field that starts on line 1/);
    });

    it('streams a large input with constant memory per record', () => {
        let count = 0;
        const parser = new CsvParser({ onRecord: () => void count++ });
        const row = 'abc,"def, ghi",123,2026-01-01\r\n';
        for (let i = 0; i < 20_000; i++) parser.feed(row.repeat(10));
        parser.finish();
        expect(count).toBe(200_000);
    });
});

describe('CSV writing and delimiter detection', () => {
    it('quotes only what needs it', () => {
        expect(csvLine(['a', 'b,c', 'd"e', ' f', 'g\nh', ''])).toBe(
            'a,"b,c","d""e"," f","g\nh",\r\n',
        );
        expect(csvLine(['a;b', 'c'], ';', '\n')).toBe('"a;b";c\n');
    });

    it('round trips through the parser', () => {
        const fields = ['plain', 'with, comma', 'with "quote"', 'multi\nline', '', ' padded '];
        expect(fieldsOf(csvLine(fields))).toEqual([fields]);
    });

    it('detects the delimiter', () => {
        expect(detectDelimiter('a,b,c\n1,2,3\n')).toBe(',');
        expect(detectDelimiter('a;b;c\n1;2;3\n')).toBe(';');
        expect(detectDelimiter('a\tb\tc\n1\t2\t3\n')).toBe('\t');
        expect(detectDelimiter('a|b\n1|2\n')).toBe('|');
        expect(detectDelimiter('"a,b";c\n"1,2";d\n')).toBe(';');
        expect(detectDelimiter('single\n')).toBe(',');
    });
});
