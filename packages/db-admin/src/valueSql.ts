/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import type { DbValue } from '@httpreq/db-core';
import type { SqlValue } from './dialect';
import { categoryOfType } from './rowEdit';

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** `YYYY-MM-DD HH:MM:SS[.mmm]` in UTC, the form both MySQL and PostgreSQL read. */
export const sqlDateText = (value: Date): string =>
    `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())} ${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}:${pad(value.getUTCSeconds())}${
        value.getUTCMilliseconds() ? `.${pad(value.getUTCMilliseconds(), 3)}` : ''
    }`;

export const hexOfBytes = (bytes: Uint8Array): string =>
    Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/** A value as a plain JSON structure: dates as ISO text, bytes as hex, typed values as their text. */
export const toPlainJson = (value: DbValue): unknown => {
    if (value === null || typeof value !== 'object')
        return typeof value === 'bigint' ? value.toString() : value;
    if (value instanceof Date) return value.toISOString();
    if (value instanceof Uint8Array) return hexOfBytes(value);
    if (Array.isArray(value)) return value.map(toPlainJson);
    const tagged = value as { $type?: unknown; $value?: unknown };
    if (
        typeof tagged.$type === 'string' &&
        typeof tagged.$value === 'string' &&
        Object.keys(value).length === 2
    )
        return tagged.$value;
    return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, toPlainJson(item as DbValue)]),
    );
};

/**
 * A value a result holds (or an input record carries), as the value of a statement for a column
 * of the given type. One definition for the table editor, the SQL export and the importers, so a
 * date, a binary value or a JSON column is written the same way wherever it comes from.
 */
export const dbValueToSqlValue = (value: DbValue | undefined, type = ''): SqlValue => {
    if (value === null || value === undefined) return { kind: 'null' };
    const category = categoryOfType(type);
    if (typeof value === 'boolean') return { kind: 'boolean', value };
    if (typeof value === 'number' || typeof value === 'bigint') {
        return category === 'boolean'
            ? { kind: 'boolean', value: Number(value) !== 0 }
            : { kind: 'number', value: String(value) };
    }
    if (typeof value === 'string')
        return category === 'json' ? { kind: 'json', value } : { kind: 'text', value };
    if (value instanceof Date) return { kind: 'text', value: sqlDateText(value) };
    if (value instanceof Uint8Array) return { kind: 'binary', hex: hexOfBytes(value) };
    return { kind: 'json', value: JSON.stringify(toPlainJson(value)) };
};
