/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { DbError, type DbValue } from '@httpreq/db-core';

/** Type OIDs of the built-in types that get a typed value; everything else arrives as text. */
export const OID = {
    bool: 16,
    bytea: 17,
    char: 18,
    name: 19,
    int8: 20,
    int2: 21,
    int4: 23,
    text: 25,
    oid: 26,
    xid: 28,
    json: 114,
    xml: 142,
    float4: 700,
    float8: 701,
    bpchar: 1042,
    varchar: 1043,
    date: 1082,
    time: 1083,
    timestamp: 1114,
    timestamptz: 1184,
    interval: 1186,
    timetz: 1266,
    bit: 1560,
    varbit: 1562,
    numeric: 1700,
    uuid: 2950,
    jsonb: 3802,
} as const;

/** Array types and the element type each holds. */
const ARRAY_OF: Record<number, number> = {
    1000: OID.bool,
    1001: OID.bytea,
    1005: OID.int2,
    1007: OID.int4,
    1009: OID.text,
    1014: OID.bpchar,
    1015: OID.varchar,
    1016: OID.int8,
    1021: OID.float4,
    1022: OID.float8,
    1028: OID.oid,
    1115: OID.timestamp,
    1182: OID.date,
    1185: OID.timestamptz,
    1231: OID.numeric,
    2951: OID.uuid,
    199: OID.json,
    3807: OID.jsonb,
};

const NAMES: Record<number, string> = {
    [OID.bool]: 'boolean',
    [OID.bytea]: 'bytea',
    [OID.char]: '"char"',
    [OID.name]: 'name',
    [OID.int8]: 'bigint',
    [OID.int2]: 'smallint',
    [OID.int4]: 'integer',
    [OID.text]: 'text',
    [OID.oid]: 'oid',
    [OID.xid]: 'xid',
    [OID.json]: 'json',
    [OID.xml]: 'xml',
    [OID.float4]: 'real',
    [OID.float8]: 'double precision',
    [OID.bpchar]: 'char',
    [OID.varchar]: 'varchar',
    [OID.date]: 'date',
    [OID.time]: 'time',
    [OID.timestamp]: 'timestamp',
    [OID.timestamptz]: 'timestamptz',
    [OID.interval]: 'interval',
    [OID.timetz]: 'timetz',
    [OID.bit]: 'bit',
    [OID.varbit]: 'varbit',
    [OID.numeric]: 'numeric',
    [OID.uuid]: 'uuid',
    [OID.jsonb]: 'jsonb',
};

/** A display name for a type OID, or `undefined` for a type this file does not know. */
export const typeName = (oid: number): string | undefined => {
    const element = ARRAY_OF[oid];
    if (element !== undefined) return `${NAMES[element] ?? '?'}[]`;
    return NAMES[oid];
};

const malformed = (what: string) =>
    new DbError('CONNECTION_FAILED', `The server sent ${what} that could not be read.`);

const parseHexBytea = (text: string): Uint8Array => {
    if (text.startsWith('\\x')) return new Uint8Array(Buffer.from(text.slice(2), 'hex'));
    // The older escape format: printable bytes as themselves, `\\` and `\nnn` for the rest.
    const bytes: number[] = [];
    for (let i = 0; i < text.length; i++) {
        if (text[i] !== '\\') bytes.push(text.charCodeAt(i) & 0xff);
        else if (text[i + 1] === '\\') {
            bytes.push(0x5c);
            i++;
        } else {
            bytes.push(parseInt(text.slice(i + 1, i + 4), 8));
            i += 3;
        }
    }
    return new Uint8Array(bytes);
};

/** Reads one value sent in text format. */
export const decodeText = (oid: number, text: string): DbValue => {
    switch (oid) {
        case OID.bool:
            return text === 't';
        case OID.int2:
        case OID.int4:
        case OID.oid:
        case OID.xid:
            return Number(text);
        case OID.int8: {
            const n = Number(text);
            return Number.isSafeInteger(n) ? n : BigInt(text);
        }
        case OID.float4:
        case OID.float8:
            return text === 'NaN'
                ? NaN
                : text === 'Infinity'
                  ? Infinity
                  : text === '-Infinity'
                    ? -Infinity
                    : Number(text);
        case OID.bytea:
            return parseHexBytea(text);
        case OID.json:
        case OID.jsonb:
            try {
                return JSON.parse(text) as DbValue;
            } catch {
                return text;
            }
        default: {
            const element = ARRAY_OF[oid];
            return element !== undefined ? parseArray(text, element) : text;
        }
    }
};

/** Reads an array literal (`{1,2,{3,4}}`, `{"a b",NULL}`) into nested arrays of typed values. */
export const parseArray = (text: string, elementOid: number): DbValue => {
    let i = 0;
    // `[1:3]={…}` bounds come first when the lower bound is not 1.
    if (text[0] === '[') {
        const eq = text.indexOf('=');
        if (eq < 0) throw malformed('an array');
        i = eq + 1;
    }
    const read = (depth: number): DbValue[] => {
        if (depth > 32) throw malformed('an array nested too deeply');
        if (text[i] !== '{') throw malformed('an array');
        i++;
        const items: DbValue[] = [];
        while (text[i] !== '}') {
            if (i >= text.length) throw malformed('an array that is not closed');
            if (text[i] === '{') items.push(read(depth + 1));
            else if (text[i] === '"') {
                i++;
                let out = '';
                while (text[i] !== '"') {
                    if (i >= text.length) throw malformed('an array element that is not closed');
                    if (text[i] === '\\') i++;
                    out += text[i++];
                }
                i++;
                items.push(decodeText(elementOid, out));
            } else {
                const start = i;
                while (text[i] !== ',' && text[i] !== '}') {
                    if (i >= text.length) throw malformed('an array that is not closed');
                    i++;
                }
                const raw = text.slice(start, i);
                items.push(raw === 'NULL' ? null : decodeText(elementOid, raw));
            }
            if (text[i] === ',') i++;
        }
        i++;
        return items;
    };
    return read(0);
};
