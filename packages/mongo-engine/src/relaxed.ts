/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { randomBytes } from 'node:crypto';
import { DbError, type DbValue } from '@httpreq/db-core';
import { stringToDecimal128 } from '@httpreq/db-protocol-mongo';

/**
 * Reads the values people write in a MongoDB shell: JSON, but also unquoted keys, single quotes,
 * comments, trailing commas, regular-expression literals and the usual constructors
 * (`ObjectId("…")`, `ISODate("…")`, `NumberLong(…)`, `NumberDecimal("…")`, `UUID("…")`…), and
 * canonical Extended JSON (`{"$oid": "…"}`, `{"$date": "…"}`).
 *
 * It parses; it never evaluates. There is no `eval` and no way to call anything but the
 * constructors listed here, so text pasted from somewhere else cannot run code.
 */

const MAX_DEPTH = 100;
const IDENTIFIER = /[A-Za-z_$][\w$]*/y;

export interface Parsed<T = DbValue> {
    value: T;
    /** The index just past what was read. */
    end: number;
}

const lineColumn = (text: string, index: number) => {
    let line = 1;
    let last = -1;
    for (let i = 0; i < index && i < text.length; i++) {
        if (text[i] === '\n') {
            line++;
            last = i;
        }
    }
    return `line ${line}, column ${index - last}`;
};

class Reader {
    constructor(
        readonly text: string,
        public index = 0,
    ) {}

    fail(message: string, at = this.index): never {
        throw new DbError('INVALID_REQUEST', `${message} (${lineColumn(this.text, at)}).`);
    }

    skip(): void {
        const { text } = this;
        for (;;) {
            const c = text[this.index];
            if (c === ' ' || c === '\t' || c === '\r' || c === '\n') this.index++;
            else if (c === '/' && text[this.index + 1] === '/') {
                while (this.index < text.length && text[this.index] !== '\n') this.index++;
            } else if (c === '/' && text[this.index + 1] === '*') {
                const end = text.indexOf('*/', this.index + 2);
                if (end < 0) this.fail('A comment is not closed');
                this.index = end + 2;
            } else return;
        }
    }

    peek(): string | undefined {
        this.skip();
        return this.text[this.index];
    }

    expect(char: string): void {
        this.skip();
        if (this.text[this.index] !== char) {
            this.fail(
                `Expected “${char}”${this.index < this.text.length ? ` but found “${this.text[this.index]}”` : ' but the text ended'}`,
            );
        }
        this.index++;
    }

    identifier(): string | null {
        IDENTIFIER.lastIndex = this.index;
        const match = IDENTIFIER.exec(this.text);
        if (!match) return null;
        this.index += match[0].length;
        return match[0];
    }
}

const tagged = (type: string, value: string): DbValue => ({ $type: type, $value: value });

const objectIdHex = (): string => {
    const stamp = Buffer.alloc(4);
    stamp.writeUInt32BE(Math.floor(Date.now() / 1000));
    return Buffer.concat([stamp, randomBytes(8)]).toString('hex');
};

/** A new ObjectId, as the value the driver writes. */
export const newObjectId = (): DbValue => tagged('objectId', objectIdHex());

const asString = (reader: Reader, args: DbValue[], name: string, at: number): string => {
    if (typeof args[0] !== 'string') reader.fail(`${name}() takes a string`, at);
    return args[0];
};

const parseDate = (reader: Reader, input: DbValue | undefined, at: number): Date => {
    if (input === undefined) return new Date();
    const date =
        input instanceof Date
            ? input
            : typeof input === 'number' || typeof input === 'bigint'
              ? new Date(Number(input))
              : typeof input === 'string'
                ? new Date(input)
                : new Date(NaN);
    if (Number.isNaN(date.getTime())) reader.fail('That is not a valid date', at);
    return date;
};

const construct = (reader: Reader, name: string, args: DbValue[], at: number): DbValue => {
    switch (name) {
        case 'ObjectId': {
            if (args.length === 0) return newObjectId();
            const hex = asString(reader, args, name, at);
            if (!/^[0-9a-fA-F]{24}$/.test(hex))
                reader.fail('An ObjectId is 24 hexadecimal characters', at);
            return tagged('objectId', hex.toLowerCase());
        }
        case 'ISODate':
        case 'Date':
            return parseDate(reader, args[0], at);
        case 'NumberLong':
        case 'Long': {
            const text = String(args[0] ?? '0');
            if (!/^-?\d+$/.test(text)) reader.fail('NumberLong takes an integer', at);
            return tagged('int64', text);
        }
        case 'NumberInt': {
            const n = Number(args[0] ?? 0);
            if (!Number.isInteger(n) || n < -2147483648 || n > 2147483647)
                reader.fail('NumberInt takes a 32-bit integer', at);
            return tagged('int32', String(n));
        }
        case 'NumberDouble':
        case 'Double':
            return tagged('double', String(Number(args[0] ?? 0)));
        case 'NumberDecimal':
        case 'Decimal128': {
            const text = String(args[0] ?? '0');
            try {
                stringToDecimal128(text);
            } catch (error) {
                reader.fail((error as Error).message, at);
            }
            return tagged('decimal128', text);
        }
        case 'UUID': {
            const text = asString(reader, args, name, at);
            if (
                !/^[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}$/.test(
                    text,
                )
            ) {
                reader.fail('That is not a UUID', at);
            }
            const h = text.replace(/-/g, '').toLowerCase();
            return tagged(
                'uuid',
                `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`,
            );
        }
        case 'Timestamp':
            return tagged('timestamp', `${Number(args[0] ?? 0)}:${Number(args[1] ?? 0)}`);
        case 'MinKey':
            return tagged('minKey', '');
        case 'MaxKey':
            return tagged('maxKey', '');
        case 'BinData': {
            const subtype = Number(args[0]);
            if (
                !Number.isInteger(subtype) ||
                subtype < 0 ||
                subtype > 255 ||
                typeof args[1] !== 'string'
            ) {
                reader.fail('BinData takes a subtype and base64 text', at);
            }
            return subtype === 0
                ? new Uint8Array(Buffer.from(args[1] as string, 'base64'))
                : tagged(`binary:${subtype}`, args[1] as string);
        }
        case 'RegExp': {
            const pattern = asString(reader, args, name, at);
            return tagged('regex', `/${pattern}/${typeof args[1] === 'string' ? args[1] : ''}`);
        }
        default:
            return reader.fail(`“${name}” is not something this editor understands`, at);
    }
};

/** Canonical Extended JSON wrappers: `{ "$oid": "…" }` and friends. */
const extended = (value: { [key: string]: DbValue }): DbValue | undefined => {
    const keys = Object.keys(value);
    const only = keys.length === 1 ? keys[0]! : null;
    const get = (key: string) => value[key];
    if (only === '$oid' && typeof get('$oid') === 'string')
        return tagged('objectId', get('$oid') as string);
    if (only === '$numberLong') return tagged('int64', String(get('$numberLong')));
    if (only === '$numberInt') return tagged('int32', String(get('$numberInt')));
    if (only === '$numberDouble') return tagged('double', String(get('$numberDouble')));
    if (only === '$numberDecimal') return tagged('decimal128', String(get('$numberDecimal')));
    if (only === '$uuid') return tagged('uuid', String(get('$uuid')));
    if (only === '$minKey') return tagged('minKey', '');
    if (only === '$maxKey') return tagged('maxKey', '');
    if (only === '$date') {
        const inner = get('$date');
        if (typeof inner === 'string') return new Date(inner);
        if (typeof inner === 'number') return new Date(inner);
        if (inner && typeof inner === 'object' && '$type' in inner && inner.$type === 'int64') {
            return new Date(Number((inner as { $value: string }).$value));
        }
    }
    if (only === '$regularExpression') {
        const inner = get('$regularExpression');
        if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
            const body = inner as { pattern?: DbValue; options?: DbValue };
            return tagged('regex', `/${String(body.pattern ?? '')}/${String(body.options ?? '')}`);
        }
    }
    if (only === '$timestamp') {
        const inner = get('$timestamp');
        if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
            const body = inner as { t?: DbValue; i?: DbValue };
            return tagged('timestamp', `${Number(body.t ?? 0)}:${Number(body.i ?? 0)}`);
        }
    }
    if (keys.length === 1 && only === '$binary') {
        const inner = get('$binary');
        if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
            const body = inner as { base64?: DbValue; subType?: DbValue };
            const subtype = parseInt(String(body.subType ?? '0'), 16);
            return subtype === 0
                ? new Uint8Array(Buffer.from(String(body.base64 ?? ''), 'base64'))
                : tagged(`binary:${subtype}`, String(body.base64 ?? ''));
        }
    }
    return undefined;
};

const readString = (reader: Reader): string => {
    const quote = reader.text[reader.index]!;
    const start = reader.index;
    reader.index++;
    let out = '';
    for (;;) {
        const c = reader.text[reader.index];
        if (c === undefined) reader.fail('A string is not closed', start);
        reader.index++;
        if (c === quote) return out;
        if (c === '\\') {
            const next = reader.text[reader.index++];
            switch (next) {
                case 'n':
                    out += '\n';
                    break;
                case 'r':
                    out += '\r';
                    break;
                case 't':
                    out += '\t';
                    break;
                case 'b':
                    out += '\b';
                    break;
                case 'f':
                    out += '\f';
                    break;
                case '0':
                    out += '\0';
                    break;
                case 'u': {
                    const hex = reader.text.slice(reader.index, reader.index + 4);
                    if (!/^[0-9a-fA-F]{4}$/.test(hex))
                        reader.fail('A \\u escape needs four hexadecimal digits');
                    out += String.fromCharCode(parseInt(hex, 16));
                    reader.index += 4;
                    break;
                }
                case undefined:
                    return reader.fail('A string is not closed', start);
                default:
                    out += next;
            }
        } else out += c;
    }
};

const readValue = (reader: Reader, depth: number): DbValue => {
    if (depth > MAX_DEPTH) reader.fail('The value is nested too deeply');
    const c = reader.peek();
    const start = reader.index;
    if (c === undefined) return reader.fail('A value is missing');
    if (c === '{') return readObject(reader, depth);
    if (c === '[') {
        reader.index++;
        const items: DbValue[] = [];
        while (reader.peek() !== ']') {
            if (reader.peek() === undefined) reader.fail('An array is not closed', start);
            items.push(readValue(reader, depth + 1));
            if (reader.peek() === ',') reader.index++;
            else break;
        }
        reader.expect(']');
        return items;
    }
    if (c === '"' || c === "'") return readString(reader);
    if (c === '/') {
        // A regular-expression literal.
        let i = reader.index + 1;
        let inClass = false;
        for (; i < reader.text.length; i++) {
            const ch = reader.text[i]!;
            if (ch === '\\') i++;
            else if (ch === '[') inClass = true;
            else if (ch === ']') inClass = false;
            else if (ch === '/' && !inClass) break;
            else if (ch === '\n') reader.fail('A regular expression is not closed', start);
        }
        if (i >= reader.text.length) reader.fail('A regular expression is not closed', start);
        const pattern = reader.text.slice(reader.index + 1, i);
        i++;
        const flags = /^[a-z]*/.exec(reader.text.slice(i))![0];
        reader.index = i + flags.length;
        return tagged('regex', `/${pattern}/${[...flags].sort().join('')}`);
    }
    if (c === '-' || c === '+' || (c >= '0' && c <= '9') || c === '.') {
        const match =
            /^[-+]?(?:0[xX][0-9a-fA-F]+|Infinity|(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/.exec(
                reader.text.slice(reader.index),
            );
        if (!match) return reader.fail('That is not a number');
        reader.index += match[0].length;
        const n = Number(match[0]);
        // An integer beyond 2^53 keeps its digits, as a 64-bit integer.
        if (/^[-+]?\d+$/.test(match[0]) && !Number.isSafeInteger(n)) {
            const big = BigInt(match[0]);
            if (big >= -(2n ** 63n) && big < 2n ** 63n) return big;
        }
        return n;
    }
    const name = reader.identifier();
    if (name === null) return reader.fail(`Unexpected “${c}”`);
    switch (name) {
        case 'true':
            return true;
        case 'false':
            return false;
        case 'null':
        case 'undefined':
            return null;
        case 'NaN':
            return NaN;
        case 'Infinity':
            return Infinity;
        case 'new': {
            reader.skip();
            const constructor = reader.identifier();
            if (!constructor) return reader.fail('A name is missing after “new”');
            return readCall(reader, constructor, start, depth);
        }
        default:
            return readCall(reader, name, start, depth);
    }
};

const readCall = (reader: Reader, name: string, start: number, depth: number): DbValue => {
    if (reader.peek() !== '(')
        return reader.fail(`“${name}” is not a value; strings need quotes`, start);
    reader.index++;
    const args: DbValue[] = [];
    while (reader.peek() !== ')') {
        if (reader.peek() === undefined) reader.fail('A call is not closed', start);
        args.push(readValue(reader, depth + 1));
        if (reader.peek() === ',') reader.index++;
        else break;
    }
    reader.expect(')');
    return construct(reader, name, args, start);
};

const readObject = (reader: Reader, depth: number): DbValue => {
    const start = reader.index;
    reader.index++;
    const object: { [key: string]: DbValue } = {};
    while (reader.peek() !== '}') {
        const c = reader.peek();
        if (c === undefined) reader.fail('An object is not closed', start);
        let key: string;
        if (c === '"' || c === "'") key = readString(reader);
        else {
            // Unquoted keys: names, and numbers such as {1: 'a'}.
            const match = /^[A-Za-z_$][\w$]*|^\d+/.exec(reader.text.slice(reader.index));
            if (!match) return reader.fail('A field name is expected');
            key = match[0];
            reader.index += key.length;
        }
        reader.expect(':');
        const value = readValue(reader, depth + 1);
        if (key === '__proto__')
            Object.defineProperty(object, key, {
                value,
                enumerable: true,
                writable: true,
                configurable: true,
            });
        else object[key] = value;
        if (reader.peek() === ',') reader.index++;
        else break;
    }
    reader.expect('}');
    return extended(object) ?? object;
};

/** Reads one value starting at `from`; returns it and where it ended. */
export const parseValue = (text: string, from = 0): Parsed => {
    const reader = new Reader(text, from);
    const value = readValue(reader, 0);
    return { value, end: reader.index };
};

/** Reads a whole text as one value. */
export const parseRelaxed = (text: string): DbValue => {
    const reader = new Reader(text);
    const value = readValue(reader, 0);
    reader.skip();
    if (reader.index < text.length)
        reader.fail(
            `Unexpected text after the value (“${text.slice(reader.index, reader.index + 12)}”)`,
        );
    return value;
};

/** Reads `(a, b, c)` starting at the opening parenthesis; returns the values and where it ended. */
export const parseArguments = (text: string, from: number): Parsed<DbValue[]> => {
    const reader = new Reader(text, from);
    reader.expect('(');
    const args: DbValue[] = [];
    while (reader.peek() !== ')') {
        if (reader.peek() === undefined) reader.fail('The arguments are not closed', from);
        args.push(readValue(reader, 0));
        if (reader.peek() === ',') reader.index++;
        else break;
    }
    reader.expect(')');
    return { value: args, end: reader.index };
};
