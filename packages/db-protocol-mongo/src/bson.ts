/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { DbError, type DbValue } from '@httpreq/db-core';

/**
 * BSON, written for this driver and nothing else: documents are plain objects, and the types that
 * JavaScript has no value for (ObjectId, Decimal128, regular expressions, timestamps…) are
 * `{ $type, $value }` pairs, the same shape the rest of Database Studio shows. Whatever `decode`
 * produces, `encode` accepts and turns back into the same BSON type.
 *
 * Numbers: a JavaScript integer in the 32-bit range is written as an `int32`, a larger safe
 * integer or a bigint as an `int64`, anything else as a `double`. Reading is the reverse; an
 * `int64` outside the safe range arrives as a bigint. Use `{ $type: 'double', $value: '5' }` to
 * force a double.
 */

export type BsonDocument = { [key: string]: DbValue };

/** The deepest nesting accepted, in either direction. */
export const MAX_DEPTH = 100;
/** The largest document accepted when reading; a server's limit is 16 MB (48 MB for a message). */
export const MAX_DOCUMENT_BYTES = 48 * 1024 * 1024;

const T = {
    double: 0x01,
    string: 0x02,
    document: 0x03,
    array: 0x04,
    binary: 0x05,
    undefined: 0x06,
    objectId: 0x07,
    bool: 0x08,
    date: 0x09,
    null: 0x0a,
    regex: 0x0b,
    dbPointer: 0x0c,
    javascript: 0x0d,
    symbol: 0x0e,
    javascriptScope: 0x0f,
    int32: 0x10,
    timestamp: 0x11,
    int64: 0x12,
    decimal128: 0x13,
    minKey: 0xff,
    maxKey: 0x7f,
} as const;

const bad = (message: string) => new DbError('CONNECTION_FAILED', `Malformed BSON (${message}).`);

/* ---------- Decimal128 ---------- */

const DECIMAL_BIAS = 6176;
const MAX_COEFFICIENT = 10n ** 34n - 1n;

/** Reads the 16 little-endian bytes of a Decimal128 as text. */
export const decimal128ToString = (bytes: Uint8Array): string => {
    let value = 0n;
    for (let i = 15; i >= 0; i--) value = (value << 8n) | BigInt(bytes[i]!);
    const negative = value >> 127n === 1n;
    const sign = negative ? '-' : '';
    const combination = Number((value >> 122n) & 0x1fn);
    if (combination === 0x1f) return 'NaN';
    if (combination === 0x1e) return `${sign}Infinity`;
    let exponent: number;
    let coefficient: bigint;
    if (combination >> 3 === 0x3) {
        // The coefficient's high bits are implied (always 100…): coefficients that large are non-canonical.
        exponent = Number((value >> 111n) & 0x3fffn);
        coefficient = 0n;
    } else {
        exponent = Number((value >> 113n) & 0x3fffn);
        coefficient = value & ((1n << 113n) - 1n);
    }
    if (coefficient > MAX_COEFFICIENT) coefficient = 0n;
    exponent -= DECIMAL_BIAS;
    const digits = coefficient.toString();
    if (exponent === 0) return `${sign}${digits}`;
    const adjusted = exponent + digits.length - 1;
    if (exponent > 0 || adjusted < -6) {
        const mantissa = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
        return `${sign}${mantissa}E${adjusted >= 0 ? '+' : ''}${adjusted}`;
    }
    if (digits.length > -exponent) {
        const point = digits.length + exponent;
        return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
    }
    return `${sign}0.${'0'.repeat(-exponent - digits.length)}${digits}`;
};

/** Writes a Decimal128 from its text form (`12.50`, `-1E+3`, `NaN`, `Infinity`). */
export const stringToDecimal128 = (text: string): Uint8Array => {
    const out = new Uint8Array(16);
    const write = (value: bigint) => {
        for (let i = 0; i < 16; i++) out[i] = Number((value >> BigInt(8 * i)) & 0xffn);
    };
    const trimmed = text.trim();
    const negative = trimmed.startsWith('-');
    const body = trimmed.replace(/^[+-]/, '');
    const signBit = negative ? 1n << 127n : 0n;
    if (/^nan$/i.test(body)) {
        write(0x7cn << 120n);
        return out;
    }
    if (/^inf(inity)?$/i.test(body)) {
        write(signBit | (0x78n << 120n));
        return out;
    }
    const match = /^(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(body);
    if (!match || (match[1] === '' && (match[2] ?? '') === '')) {
        throw new DbError('INVALID_REQUEST', `“${text}” is not a decimal number.`);
    }
    let digits = `${match[1]}${match[2] ?? ''}`.replace(/^0+(?=\d)/, '');
    let exponent = Number(match[3] ?? 0) - (match[2]?.length ?? 0);
    // Trailing zeros beyond 34 digits can be folded into the exponent.
    while (digits.length > 34 && digits.endsWith('0')) {
        digits = digits.slice(0, -1);
        exponent++;
    }
    if (digits.length > 34) {
        throw new DbError('INVALID_REQUEST', 'A decimal has at most 34 significant digits.');
    }
    const biased = exponent + DECIMAL_BIAS;
    if (biased < 0 || biased > 12287) {
        throw new DbError('INVALID_REQUEST', 'The decimal’s exponent is out of range.');
    }
    write(signBit | (BigInt(biased) << 113n) | BigInt(digits));
    return out;
};

/* ---------- Decoding ---------- */

class Cursor {
    constructor(
        readonly buffer: Buffer,
        public offset: number,
        readonly end: number,
    ) {}

    need(bytes: number): void {
        if (this.offset + bytes > this.end) throw bad('a value runs past its document');
    }
}

const cstring = (c: Cursor): string => {
    const stop = c.buffer.indexOf(0, c.offset);
    if (stop < 0 || stop >= c.end) throw bad('a name is not terminated');
    const text = c.buffer.toString('utf8', c.offset, stop);
    c.offset = stop + 1;
    return text;
};

const readString = (c: Cursor): string => {
    c.need(4);
    const length = c.buffer.readInt32LE(c.offset);
    c.offset += 4;
    if (length < 1) throw bad('a string has no terminator');
    c.need(length);
    if (c.buffer[c.offset + length - 1] !== 0) throw bad('a string is not terminated');
    const text = c.buffer.toString('utf8', c.offset, c.offset + length - 1);
    c.offset += length;
    return text;
};

const readDocumentAt = (c: Cursor, isArray: boolean, depth: number): DbValue => {
    if (depth > MAX_DEPTH) throw bad('nesting that is too deep');
    c.need(5);
    const start = c.offset;
    const size = c.buffer.readInt32LE(start);
    if (size < 5 || size > MAX_DOCUMENT_BYTES || start + size > c.end) {
        throw bad('a document has an impossible length');
    }
    const end = start + size;
    if (c.buffer[end - 1] !== 0) throw bad('a document is not terminated');
    const inner = new Cursor(c.buffer, start + 4, end - 1);
    const object: { [key: string]: DbValue } = {};
    const array: DbValue[] = [];
    while (inner.offset < inner.end) {
        const type = c.buffer[inner.offset++]!;
        const name = cstring(inner);
        const value = readValue(inner, type, depth);
        if (isArray) array.push(value);
        else if (name === '__proto__')
            Object.defineProperty(object, name, {
                value,
                enumerable: true,
                writable: true,
                configurable: true,
            });
        else object[name] = value;
    }
    c.offset = end;
    return isArray ? array : object;
};

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

const readValue = (c: Cursor, type: number, depth: number): DbValue => {
    switch (type) {
        case T.double:
            c.need(8);
            c.offset += 8;
            return c.buffer.readDoubleLE(c.offset - 8);
        case T.string:
            return readString(c);
        case T.document:
            return readDocumentAt(c, false, depth + 1);
        case T.array:
            return readDocumentAt(c, true, depth + 1);
        case T.binary: {
            c.need(5);
            const length = c.buffer.readInt32LE(c.offset);
            const subtype = c.buffer[c.offset + 4]!;
            c.offset += 5;
            if (length < 0) throw bad('a binary value has a negative length');
            c.need(length);
            const bytes = new Uint8Array(c.buffer.subarray(c.offset, c.offset + length));
            c.offset += length;
            if (subtype === 0) return bytes;
            if (subtype === 4 && length === 16) {
                const h = hex(bytes);
                return {
                    $type: 'uuid',
                    $value: `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`,
                };
            }
            return { $type: `binary:${subtype}`, $value: Buffer.from(bytes).toString('base64') };
        }
        case T.undefined:
            return null;
        case T.objectId:
            c.need(12);
            c.offset += 12;
            return { $type: 'objectId', $value: c.buffer.toString('hex', c.offset - 12, c.offset) };
        case T.bool:
            c.need(1);
            return c.buffer[c.offset++] === 1;
        case T.date: {
            c.need(8);
            const millis = c.buffer.readBigInt64LE(c.offset);
            c.offset += 8;
            const date = new Date(Number(millis));
            // A date outside JavaScript's range cannot be a Date: keep its number as text.
            return Number.isNaN(date.getTime()) ? { $type: 'date', $value: String(millis) } : date;
        }
        case T.null:
            return null;
        case T.regex: {
            const pattern = cstring(c);
            const flags = cstring(c);
            return { $type: 'regex', $value: `/${pattern}/${flags}` };
        }
        case T.dbPointer: {
            const namespace = readString(c);
            c.need(12);
            c.offset += 12;
            return {
                $type: 'dbPointer',
                $value: `${namespace}:${c.buffer.toString('hex', c.offset - 12, c.offset)}`,
            };
        }
        case T.javascript:
            return { $type: 'javascript', $value: readString(c) };
        case T.symbol:
            return { $type: 'symbol', $value: readString(c) };
        case T.javascriptScope: {
            c.need(4);
            c.offset += 4;
            const code = readString(c);
            readDocumentAt(c, false, depth + 1);
            return { $type: 'javascript', $value: code };
        }
        case T.int32:
            c.need(4);
            c.offset += 4;
            return c.buffer.readInt32LE(c.offset - 4);
        case T.timestamp: {
            c.need(8);
            const increment = c.buffer.readUInt32LE(c.offset);
            const seconds = c.buffer.readUInt32LE(c.offset + 4);
            c.offset += 8;
            return { $type: 'timestamp', $value: `${seconds}:${increment}` };
        }
        case T.int64: {
            c.need(8);
            const value = c.buffer.readBigInt64LE(c.offset);
            c.offset += 8;
            return value >= BigInt(Number.MIN_SAFE_INTEGER) &&
                value <= BigInt(Number.MAX_SAFE_INTEGER)
                ? Number(value)
                : value;
        }
        case T.decimal128:
            c.need(16);
            c.offset += 16;
            return {
                $type: 'decimal128',
                $value: decimal128ToString(c.buffer.subarray(c.offset - 16, c.offset)),
            };
        case T.minKey:
            return { $type: 'minKey', $value: '' };
        case T.maxKey:
            return { $type: 'maxKey', $value: '' };
        default:
            throw bad(`unknown type 0x${type.toString(16)}`);
    }
};

/** Reads one document at `offset`; returns it and the offset just past it. */
export const decodeDocument = (
    buffer: Buffer,
    offset = 0,
    end = buffer.length,
): { value: BsonDocument; next: number } => {
    const cursor = new Cursor(buffer, offset, end);
    const value = readDocumentAt(cursor, false, 0) as BsonDocument;
    return { value, next: cursor.offset };
};

/* ---------- Encoding ---------- */

class Writer {
    private chunks: Buffer[] = [];
    private size = 0;

    push(buffer: Buffer): void {
        this.chunks.push(buffer);
        this.size += buffer.length;
    }

    get length(): number {
        return this.size;
    }

    toBuffer(): Buffer {
        return Buffer.concat(this.chunks, this.size);
    }
}

const isTagged = (value: object): value is { $type: string; $value: string } => {
    const keys = Object.keys(value);
    return (
        keys.length === 2 &&
        typeof (value as { $type?: unknown }).$type === 'string' &&
        typeof (value as { $value?: unknown }).$value === 'string'
    );
};

const cname = (name: string): Buffer => {
    if (name.includes('\0'))
        throw new DbError('INVALID_REQUEST', 'A field name cannot contain a null character.');
    return Buffer.concat([Buffer.from(name, 'utf8'), Buffer.from([0])]);
};

const bsonString = (text: string): Buffer => {
    const bytes = Buffer.from(text, 'utf8');
    const out = Buffer.alloc(4 + bytes.length + 1);
    out.writeInt32LE(bytes.length + 1, 0);
    bytes.copy(out, 4);
    return out;
};

const element = (type: number, name: string, body: Buffer): Buffer =>
    Buffer.concat([Buffer.from([type]), cname(name), body]);

const int32Body = (n: number): Buffer => {
    const b = Buffer.alloc(4);
    b.writeInt32LE(n);
    return b;
};

const int64Body = (n: bigint): Buffer => {
    const b = Buffer.alloc(8);
    b.writeBigInt64LE(n);
    return b;
};

const taggedElement = (name: string, tag: { $type: string; $value: string }): Buffer => {
    const { $type: type, $value: value } = tag;
    switch (type) {
        case 'objectId':
            if (!/^[0-9a-fA-F]{24}$/.test(value))
                throw new DbError(
                    'INVALID_REQUEST',
                    `“${value}” is not an ObjectId (24 hex digits).`,
                );
            return element(T.objectId, name, Buffer.from(value, 'hex'));
        case 'decimal128':
            return element(T.decimal128, name, Buffer.from(stringToDecimal128(value)));
        case 'double': {
            const b = Buffer.alloc(8);
            b.writeDoubleLE(Number(value));
            return element(T.double, name, b);
        }
        case 'int32':
            return element(T.int32, name, int32Body(Number(value)));
        case 'int64':
            return element(T.int64, name, int64Body(BigInt(value)));
        case 'date':
            return element(T.date, name, int64Body(BigInt(value)));
        case 'timestamp': {
            const [seconds, increment] = value.split(':').map(Number);
            const b = Buffer.alloc(8);
            b.writeUInt32LE(increment ?? 0, 0);
            b.writeUInt32LE(seconds ?? 0, 4);
            return element(T.timestamp, name, b);
        }
        case 'regex': {
            const match = /^\/([\s\S]*)\/([a-z]*)$/.exec(value);
            if (!match)
                throw new DbError(
                    'INVALID_REQUEST',
                    `“${value}” is not a regular expression (/pattern/flags).`,
                );
            return element(
                T.regex,
                name,
                Buffer.concat([cname(match[1]!), cname([...match[2]!].sort().join(''))]),
            );
        }
        case 'uuid': {
            const h = value.replace(/-/g, '');
            if (!/^[0-9a-fA-F]{32}$/.test(h))
                throw new DbError('INVALID_REQUEST', `“${value}” is not a UUID.`);
            return element(
                T.binary,
                name,
                Buffer.concat([int32Body(16), Buffer.from([4]), Buffer.from(h, 'hex')]),
            );
        }
        case 'javascript':
            return element(T.javascript, name, bsonString(value));
        case 'symbol':
            return element(T.symbol, name, bsonString(value));
        case 'minKey':
            return element(T.minKey, name, Buffer.alloc(0));
        case 'maxKey':
            return element(T.maxKey, name, Buffer.alloc(0));
        default: {
            const binary = /^binary:(\d+)$/.exec(type);
            if (binary) {
                const bytes = Buffer.from(value, 'base64');
                return element(
                    T.binary,
                    name,
                    Buffer.concat([
                        int32Body(bytes.length),
                        Buffer.from([Number(binary[1])]),
                        bytes,
                    ]),
                );
            }
            throw new DbError('INVALID_REQUEST', `“${type}” is not a type this editor can write.`);
        }
    }
};

const encodeValue = (name: string, value: DbValue, depth: number): Buffer => {
    if (depth > MAX_DEPTH)
        throw new DbError('INVALID_REQUEST', 'The document is nested too deeply.');
    if (value === null) return element(T.null, name, Buffer.alloc(0));
    switch (typeof value) {
        case 'boolean':
            return element(T.bool, name, Buffer.from([value ? 1 : 0]));
        case 'string':
            return element(T.string, name, bsonString(value));
        case 'number': {
            if (
                Number.isInteger(value) &&
                value >= -2147483648 &&
                value <= 2147483647 &&
                !Object.is(value, -0)
            ) {
                return element(T.int32, name, int32Body(value));
            }
            if (Number.isSafeInteger(value) && !Object.is(value, -0))
                return element(T.int64, name, int64Body(BigInt(value)));
            const b = Buffer.alloc(8);
            b.writeDoubleLE(value);
            return element(T.double, name, b);
        }
        case 'bigint':
            if (value < -(2n ** 63n) || value >= 2n ** 63n) {
                throw new DbError('INVALID_REQUEST', 'An integer does not fit in 64 bits.');
            }
            return element(T.int64, name, int64Body(value));
        default:
            break;
    }
    if (value instanceof Date) {
        if (Number.isNaN(value.getTime()))
            throw new DbError('INVALID_REQUEST', 'A date is invalid.');
        return element(T.date, name, int64Body(BigInt(value.getTime())));
    }
    if (value instanceof Uint8Array) {
        return element(
            T.binary,
            name,
            Buffer.concat([int32Body(value.length), Buffer.from([0]), Buffer.from(value)]),
        );
    }
    if (Array.isArray(value)) {
        const body = new Writer();
        value.forEach((item, index) => body.push(encodeValue(String(index), item, depth + 1)));
        return element(T.array, name, wrap(body));
    }
    if (isTagged(value)) return taggedElement(name, value);
    return element(T.document, name, encodeBody(value as BsonDocument, depth + 1));
};

const wrap = (body: Writer): Buffer => {
    const out = Buffer.alloc(4 + body.length + 1);
    out.writeInt32LE(out.length, 0);
    body.toBuffer().copy(out, 4);
    return out;
};

const encodeBody = (document: BsonDocument, depth: number): Buffer => {
    const body = new Writer();
    for (const key of Object.keys(document)) {
        const value = document[key];
        // `undefined` fields are left out, as JSON does.
        if (value === undefined) continue;
        body.push(encodeValue(key, value, depth));
    }
    return wrap(body);
};

/** Encodes a document. Fields keep their insertion order. */
export const encodeDocument = (document: BsonDocument): Buffer => {
    const bytes = encodeBody(document, 0);
    if (bytes.length > MAX_DOCUMENT_BYTES) {
        throw new DbError('LIMIT_EXCEEDED', 'The document is too large.');
    }
    return bytes;
};
