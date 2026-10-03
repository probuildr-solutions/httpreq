/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { DbError } from '@httpreq/db-core';
import type { SocketPump } from '@httpreq/streaming-engine';

/** A map reply (RESP3). Keys can be any value, so it is a list of pairs rather than an object. */
export class RespMap {
    constructor(readonly entries: [RespValue, RespValue][]) {}
}

/** An error reply, as a value so that a pipeline can carry successes and failures together. */
export class RespError {
    constructor(
        readonly code: string,
        readonly message: string,
    ) {}
}

export type RespValue =
    null | string | Uint8Array | number | bigint | boolean | RespError | RespMap | RespValue[];

/** The largest bulk string accepted; Redis itself caps a value at 512 MB. */
export const MAX_BULK_BYTES = 512 * 1024 * 1024;

const utf8 = new TextDecoder('utf-8', { fatal: true });
const CRLF = Buffer.from('\r\n');

/** A bulk string is text when it is valid UTF-8 and bytes otherwise (Redis strings are binary). */
const decodeBulk = (bytes: Buffer): string | Uint8Array => {
    try {
        return utf8.decode(bytes);
    } catch {
        return new Uint8Array(bytes);
    }
};

const protocolError = (message: string) =>
    new DbError('CONNECTION_FAILED', `The server sent something unexpected (${message}).`);

/** What the next reply starts with: the shape of an aggregate before its elements are read. */
export type RespHeader =
    | { kind: 'value'; value: RespValue }
    | { kind: 'array'; length: number }
    | { kind: 'map'; length: number }
    | { kind: 'set'; length: number }
    | { kind: 'push'; length: number };

/**
 * Reads RESP2 and RESP3 replies from a socket. Aggregates can be read element by element (see
 * `readHeader`), which is how a reply of millions of elements is streamed instead of held.
 */
export class RespReader {
    constructor(private readonly pump: SocketPump) {}

    private async line(): Promise<string> {
        for (let from = 0; ;) {
            const buffered = this.pump.buffered;
            const at = buffered.indexOf(CRLF, from);
            if (at >= 0) return this.pump.consume(at + 2).toString('latin1', 0, at);
            if (buffered.length > 64 * 1024 * 1024) throw protocolError('a very long line');
            from = Math.max(0, buffered.length - 1);
            await this.pump.fill(buffered.length + 1);
        }
    }

    private async bulk(length: number): Promise<Buffer> {
        if (length > MAX_BULK_BYTES) throw protocolError('a value that is too large');
        const bytes = await this.pump.read(length + 2);
        return bytes.subarray(0, length);
    }

    /** Reads the start of the next reply: a whole scalar, or the length of an aggregate. */
    async readHeader(): Promise<RespHeader> {
        const line = await this.line();
        const type = line[0];
        const rest = line.slice(1);
        switch (type) {
            case '+':
                return { kind: 'value', value: rest };
            case '-':
                return { kind: 'value', value: toError(rest) };
            case ':':
                return { kind: 'value', value: toInteger(rest) };
            case '$': {
                const length = Number(rest);
                if (length < 0) return { kind: 'value', value: null };
                return { kind: 'value', value: decodeBulk(await this.bulk(length)) };
            }
            case '*': {
                const length = Number(rest);
                return length < 0 ? { kind: 'value', value: null } : { kind: 'array', length };
            }
            case '_':
                return { kind: 'value', value: null };
            case '#':
                return { kind: 'value', value: rest === 't' };
            case ',':
                return { kind: 'value', value: toDouble(rest) };
            case '(':
                return { kind: 'value', value: BigInt(rest) };
            case '!': {
                const text = (await this.bulk(Number(rest))).toString('utf8');
                return { kind: 'value', value: toError(text) };
            }
            case '=': {
                // Verbatim string: a three-letter format, a colon, then the text.
                const text = (await this.bulk(Number(rest))).toString('utf8');
                return { kind: 'value', value: text.slice(4) };
            }
            case '%':
                return { kind: 'map', length: Number(rest) };
            case '~':
                return { kind: 'set', length: Number(rest) };
            case '>':
                return { kind: 'push', length: Number(rest) };
            case '|': {
                // Attributes describe the next reply; they are not part of it.
                const pairs = Number(rest);
                for (let i = 0; i < pairs * 2; i++) await this.readValue();
                return this.readHeader();
            }
            default:
                throw protocolError(`type ${JSON.stringify(type)}`);
        }
    }

    /** Reads one complete reply. */
    async readValue(depth = 0): Promise<RespValue> {
        if (depth > 64) throw protocolError('nesting that is too deep');
        const header = await this.readHeader();
        switch (header.kind) {
            case 'value':
                return header.value;
            case 'map': {
                const entries: [RespValue, RespValue][] = [];
                for (let i = 0; i < header.length; i++) {
                    entries.push([
                        await this.readValue(depth + 1),
                        await this.readValue(depth + 1),
                    ]);
                }
                return new RespMap(entries);
            }
            default: {
                const items: RespValue[] = [];
                for (let i = 0; i < header.length; i++) items.push(await this.readValue(depth + 1));
                return items;
            }
        }
    }
}

const toError = (text: string): RespError => {
    // The message keeps the code (`WRONGTYPE Operation against…`), as redis-cli shows it.
    const space = text.indexOf(' ');
    return new RespError(space < 0 ? text : text.slice(0, space), text);
};

const toInteger = (text: string): number | bigint => {
    const value = Number(text);
    return Number.isSafeInteger(value) ? value : BigInt(text);
};

const toDouble = (text: string): number => {
    if (text === 'inf') return Infinity;
    if (text === '-inf') return -Infinity;
    return Number(text);
};

/** Encodes a command as an array of bulk strings. */
export const encodeCommand = (args: (string | Uint8Array | number)[]): Buffer => {
    const parts: Buffer[] = [Buffer.from(`*${args.length}\r\n`)];
    for (const arg of args) {
        const bytes =
            typeof arg === 'string'
                ? Buffer.from(arg, 'utf8')
                : typeof arg === 'number'
                  ? Buffer.from(String(arg))
                  : Buffer.from(arg);
        parts.push(Buffer.from(`$${bytes.length}\r\n`), bytes, CRLF);
    }
    return Buffer.concat(parts);
};
