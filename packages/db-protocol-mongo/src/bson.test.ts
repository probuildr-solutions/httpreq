// @vitest-environment node
/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { describe, expect, it } from 'vitest';
import { DbError, type DbValue } from '@httpreq/db-core';
import {
    decimal128ToString,
    decodeDocument,
    encodeDocument,
    stringToDecimal128,
    type BsonDocument,
} from './bson';

const hex = (buffer: Buffer | Uint8Array) => Buffer.from(buffer).toString('hex');
const roundTrip = (document: BsonDocument) => decodeDocument(encodeDocument(document)).value;

describe('encoding', () => {
    it('matches the published example for {"hello":"world"}', () => {
        expect(hex(encodeDocument({ hello: 'world' }))).toBe(
            '160000000268656c6c6f0006000000776f726c640000',
        );
    });

    it('writes the empty document', () => {
        expect(hex(encodeDocument({}))).toBe('0500000000');
    });

    it('writes integers by size and doubles as doubles', () => {
        const encoded = (value: number) => encodeDocument({ n: value })[4]!;
        expect(encoded(7)).toBe(0x10); // int32
        expect(encoded(2 ** 40)).toBe(0x12); // int64
        expect(encoded(1.5)).toBe(0x01); // double
        expect(encoded(-0)).toBe(0x01); // negative zero stays a double
        expect(encoded(2 ** 60)).toBe(0x01); // beyond the safe range
        expect(encodeDocument({ n: 5n })[4]).toBe(0x12);
    });

    it('lets a tagged value force a type', () => {
        expect(encodeDocument({ n: { $type: 'double', $value: '5' } })[4]).toBe(0x01);
        expect(encodeDocument({ n: { $type: 'int64', $value: '5' } })[4]).toBe(0x12);
    });

    it('leaves out undefined fields', () => {
        expect(hex(encodeDocument({ a: undefined as unknown as DbValue }))).toBe('0500000000');
    });

    it('refuses what BSON cannot hold', () => {
        expect(() => encodeDocument({ 'a\0b': 1 })).toThrow(DbError);
        expect(() => encodeDocument({ n: 2n ** 63n })).toThrow(/64 bits/);
        expect(() => encodeDocument({ d: new Date(NaN) })).toThrow(/invalid/);
        expect(() => encodeDocument({ o: { $type: 'objectId', $value: 'xyz' } })).toThrow(
            /ObjectId/,
        );
        expect(() => encodeDocument({ o: { $type: 'wat', $value: 'x' } })).toThrow(/not a type/);
        let deep: DbValue = 1;
        for (let i = 0; i < 150; i++) deep = { a: deep };
        expect(() => encodeDocument({ deep })).toThrow(/too deeply/);
    });
});

describe('round trips', () => {
    it('keeps every type', () => {
        const document: BsonDocument = {
            string: 'héllo 日本 🎉',
            int: 42,
            negative: -7,
            long: 2 ** 45,
            big: 2n ** 62n,
            double: 3.14159,
            infinity: Infinity,
            yes: true,
            no: false,
            nothing: null,
            date: new Date('2024-05-01T10:20:30.123Z'),
            bytes: new Uint8Array([0, 1, 2, 255]),
            list: [1, 'two', { three: 3 }, [4]],
            nested: { a: { b: { c: 'deep' } } },
            id: { $type: 'objectId', $value: '507f1f77bcf86cd799439011' },
            uuid: { $type: 'uuid', $value: '123e4567-e89b-12d3-a456-426614174000' },
            decimal: { $type: 'decimal128', $value: '12345.67890' },
            regex: { $type: 'regex', $value: '/^a.*z$/i' },
            timestamp: { $type: 'timestamp', $value: '1700000000:3' },
            code: { $type: 'javascript', $value: 'function () { return 1; }' },
            min: { $type: 'minKey', $value: '' },
            max: { $type: 'maxKey', $value: '' },
            other: { $type: 'binary:128', $value: Buffer.from('xyz').toString('base64') },
        };
        expect(roundTrip(document)).toEqual(document);
    });

    it('keeps the order of fields', () => {
        expect(Object.keys(roundTrip({ z: 1, a: 2, m: 3 }))).toEqual(['z', 'a', 'm']);
    });

    it('does not let a field called __proto__ change the prototype', () => {
        const bytes = encodeDocument(
            JSON.parse('{"__proto__": {"polluted": true}, "x": 1}') as BsonDocument,
        );
        const decoded = decodeDocument(bytes).value;
        expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype);
        expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
        expect(Object.keys(decoded)).toEqual(['__proto__', 'x']);
    });

    it('reads the previous BSON types it no longer writes', () => {
        // {a: undefined} (type 0x06) and {b: DBPointer} both become something showable.
        const undefinedDocument = Buffer.from('08000000' + '06' + '6100' + '00', 'hex');
        undefinedDocument.writeInt32LE(undefinedDocument.length, 0);
        expect(decodeDocument(undefinedDocument).value).toEqual({ a: null });
    });

    it('reads a document that sits inside a larger buffer', () => {
        const first = encodeDocument({ a: 1 });
        const second = encodeDocument({ b: 2 });
        const both = Buffer.concat([first, second]);
        const one = decodeDocument(both, 0);
        expect(one.value).toEqual({ a: 1 });
        expect(decodeDocument(both, one.next).value).toEqual({ b: 2 });
    });
});

describe('Decimal128', () => {
    it('matches published encodings', () => {
        expect(hex(stringToDecimal128('1'))).toBe('01000000000000000000000000004030');
        expect(hex(stringToDecimal128('0'))).toBe('00000000000000000000000000004030');
        expect(hex(stringToDecimal128('-1'))).toBe('010000000000000000000000000040b0');
        expect(hex(stringToDecimal128('Infinity'))).toBe('00000000000000000000000000000078');
        expect(hex(stringToDecimal128('NaN'))).toBe('0000000000000000000000000000007c');
    });

    it('prints and parses ordinary numbers back to themselves', () => {
        for (const text of [
            '0',
            '1',
            '-1',
            '12.50',
            '0.001',
            '-0.5',
            '123456789012345678901234567890',
            '0.000001',
            '1.000E+3',
            '9.999999999999999999999999999999999E+6144',
            '1E-6176',
        ]) {
            const value = decimal128ToString(stringToDecimal128(text));
            // Printing is canonical, so compare by parsing both sides again.
            expect(hex(stringToDecimal128(value))).toBe(hex(stringToDecimal128(text)));
        }
        expect(decimal128ToString(stringToDecimal128('12.50'))).toBe('12.50');
        expect(decimal128ToString(stringToDecimal128('-0.001'))).toBe('-0.001');
        expect(decimal128ToString(stringToDecimal128('Infinity'))).toBe('Infinity');
        expect(decimal128ToString(stringToDecimal128('-Infinity'))).toBe('-Infinity');
        expect(decimal128ToString(stringToDecimal128('NaN'))).toBe('NaN');
    });

    it('refuses text that is not a decimal', () => {
        expect(() => stringToDecimal128('abc')).toThrow(/not a decimal/);
        expect(() => stringToDecimal128('')).toThrow(/not a decimal/);
        expect(() => stringToDecimal128('1'.repeat(40))).toThrow(/34 significant/);
        expect(() => stringToDecimal128('1E+99999')).toThrow(/out of range/);
    });
});

describe('malformed input', () => {
    const valid = encodeDocument({
        a: 'text',
        b: [1, 2, { c: null }],
        d: new Date(0),
        e: { $type: 'objectId', $value: '507f1f77bcf86cd799439011' },
    });

    it('rejects every truncation without a stray exception', () => {
        for (let length = 0; length < valid.length; length++) {
            let outcome: unknown;
            try {
                decodeDocument(valid.subarray(0, length));
            } catch (error) {
                outcome = error;
            }
            expect(outcome, `length ${length}`).toBeInstanceOf(DbError);
        }
    });

    it('survives random corruption: it either decodes or fails with a DbError', () => {
        let seed = 12345;
        const random = () => {
            seed = (seed * 1103515245 + 12345) & 0x7fffffff;
            return seed / 0x7fffffff;
        };
        for (let round = 0; round < 3000; round++) {
            const copy = Buffer.from(valid);
            const flips = 1 + Math.floor(random() * 4);
            for (let i = 0; i < flips; i++)
                copy[Math.floor(random() * copy.length)] = Math.floor(random() * 256);
            try {
                decodeDocument(copy);
            } catch (error) {
                expect(error, `round ${round}`).toBeInstanceOf(DbError);
            }
        }
    });

    it('rejects lengths that point outside the buffer or are absurd', () => {
        const huge = Buffer.from(valid);
        huge.writeInt32LE(0x7fffffff, 0);
        expect(() => decodeDocument(huge)).toThrow(DbError);
        const negative = Buffer.from(valid);
        negative.writeInt32LE(-5, 0);
        expect(() => decodeDocument(negative)).toThrow(DbError);
    });

    it('rejects documents nested beyond the limit', () => {
        let bytes = encodeDocument({ leaf: 1 });
        for (let i = 0; i < 120; i++) {
            const name = Buffer.from('a\0');
            const body = Buffer.concat([Buffer.from([0x03]), name, bytes]);
            const out = Buffer.alloc(4 + body.length + 1);
            out.writeInt32LE(out.length, 0);
            body.copy(out, 4);
            bytes = out;
        }
        expect(() => decodeDocument(bytes)).toThrow(/too deep/);
    });

    it('rejects an unknown type byte', () => {
        const odd = Buffer.from('0c00000042610000000000' + '00', 'hex');
        odd.writeInt32LE(odd.length, 0);
        expect(() => decodeDocument(odd)).toThrow(/unknown type/);
    });
});
