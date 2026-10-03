/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import type { DbValue } from '@httpreq/db-core';

/** Column type codes of the MySQL protocol. */
export const ColumnType = {
    Decimal: 0,
    Tiny: 1,
    Short: 2,
    Long: 3,
    Float: 4,
    Double: 5,
    Null: 6,
    Timestamp: 7,
    LongLong: 8,
    Int24: 9,
    Date: 10,
    Time: 11,
    DateTime: 12,
    Year: 13,
    NewDate: 14,
    VarChar: 15,
    Bit: 16,
    Timestamp2: 17,
    DateTime2: 18,
    Time2: 19,
    Vector: 242,
    Json: 245,
    NewDecimal: 246,
    Enum: 247,
    Set: 248,
    TinyBlob: 249,
    MediumBlob: 250,
    LongBlob: 251,
    Blob: 252,
    VarString: 253,
    String: 254,
    Geometry: 255,
} as const;

/** Column flag bits. */
export const ColumnFlag = {
    NotNull: 1,
    PrimaryKey: 2,
    Unsigned: 32,
    Binary: 128,
    AutoIncrement: 512,
} as const;

/** The collation id the protocol uses for binary data. */
export const BINARY_CHARSET = 63;

export interface ColumnDefinition {
    schema: string;
    table: string;
    name: string;
    charset: number;
    length: number;
    type: number;
    flags: number;
    decimals: number;
}

const INTEGER = new Set<number>([
    ColumnType.Tiny,
    ColumnType.Short,
    ColumnType.Long,
    ColumnType.Int24,
    ColumnType.Year,
]);

/** Whether a column holds bytes rather than text. */
const isBinary = (column: ColumnDefinition) =>
    column.charset === BINARY_CHARSET &&
    [
        ColumnType.TinyBlob,
        ColumnType.MediumBlob,
        ColumnType.LongBlob,
        ColumnType.Blob,
        ColumnType.VarString,
        ColumnType.String,
        ColumnType.VarChar,
        ColumnType.Geometry,
        ColumnType.Vector,
    ].includes(column.type as never);

/**
 * Turns a value from the text protocol into a JavaScript value. Integers become numbers, or a
 * bigint where a number could not hold them exactly; decimals stay text so no precision is lost;
 * dates and times stay as the server wrote them (no time zone is guessed); binary columns become
 * bytes; everything else is text.
 */
export const decodeText = (column: ColumnDefinition, raw: Buffer): DbValue => {
    const { type } = column;
    if (INTEGER.has(type)) return Number(raw.toString('ascii'));
    if (type === ColumnType.LongLong) {
        const text = raw.toString('ascii');
        const value = BigInt(text);
        return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
            ? Number(value)
            : value;
    }
    if (type === ColumnType.Float || type === ColumnType.Double) {
        const text = raw.toString('ascii');
        const value = Number(text);
        return Number.isNaN(value) ? text : value;
    }
    if (type === ColumnType.Bit) {
        // Up to 48 bits fit a number exactly; wider fields are shown as hexadecimal.
        if (raw.length <= 6) return raw.readUIntBE(0, raw.length || 1);
        return `0x${raw.toString('hex')}`;
    }
    if (isBinary(column)) return new Uint8Array(raw);
    return raw.toString('utf8');
};

/** A display name such as `int unsigned`, `varchar(64)` or `decimal(10,2)`. */
export const typeName = (column: ColumnDefinition): string => {
    const unsigned = column.flags & ColumnFlag.Unsigned ? ' unsigned' : '';
    // Character columns report their length in bytes; utf8mb4 uses up to four per character.
    const chars = (bytes: number) =>
        column.charset === BINARY_CHARSET ? bytes : Math.round(bytes / 4);
    switch (column.type) {
        case ColumnType.Decimal:
        case ColumnType.NewDecimal:
            return `decimal(${Math.max(1, column.length - (column.decimals > 0 ? 2 : 1))},${column.decimals})`;
        case ColumnType.Tiny:
            return `tinyint${unsigned}`;
        case ColumnType.Short:
            return `smallint${unsigned}`;
        case ColumnType.Int24:
            return `mediumint${unsigned}`;
        case ColumnType.Long:
            return `int${unsigned}`;
        case ColumnType.LongLong:
            return `bigint${unsigned}`;
        case ColumnType.Float:
            return 'float';
        case ColumnType.Double:
            return 'double';
        case ColumnType.Null:
            return 'null';
        case ColumnType.Timestamp:
        case ColumnType.Timestamp2:
            return 'timestamp';
        case ColumnType.Date:
        case ColumnType.NewDate:
            return 'date';
        case ColumnType.Time:
        case ColumnType.Time2:
            return 'time';
        case ColumnType.DateTime:
        case ColumnType.DateTime2:
            return 'datetime';
        case ColumnType.Year:
            return 'year';
        case ColumnType.VarChar:
        case ColumnType.VarString:
            return column.charset === BINARY_CHARSET
                ? `varbinary(${column.length})`
                : `varchar(${chars(column.length)})`;
        case ColumnType.String:
            return column.charset === BINARY_CHARSET
                ? `binary(${column.length})`
                : `char(${chars(column.length)})`;
        case ColumnType.Bit:
            return `bit(${column.length})`;
        case ColumnType.Json:
            return 'json';
        case ColumnType.Enum:
            return 'enum';
        case ColumnType.Set:
            return 'set';
        case ColumnType.TinyBlob:
        case ColumnType.MediumBlob:
        case ColumnType.LongBlob:
        case ColumnType.Blob:
            return column.charset === BINARY_CHARSET ? 'blob' : 'text';
        case ColumnType.Geometry:
            return 'geometry';
        case ColumnType.Vector:
            return 'vector';
        default:
            return `type ${column.type}`;
    }
};
