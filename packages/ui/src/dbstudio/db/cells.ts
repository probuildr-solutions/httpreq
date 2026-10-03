/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import type { DbCell } from '@httpreq/shared';

/** How a cell value reads in the grid. */
export const formatCell = (value: DbCell | undefined): string => {
    if (value === null || value === undefined) return 'NULL';
    if (typeof value === 'string') return value;
    if (typeof value === 'bigint' || typeof value === 'number' || typeof value === 'boolean')
        return String(value);
    if (value instanceof Date)
        return value
            .toISOString()
            .replace('T', ' ')
            .replace(/\.000Z$/, '');
    if (value instanceof Uint8Array) {
        const head = Array.from(value.subarray(0, 16), (b) => b.toString(16).padStart(2, '0'));
        return `0x${head.join('')}${value.length > 16 ? `… (${value.length} bytes)` : ''}`;
    }
    // A typed value shown on its own is its text; inside an object it is written as a constructor.
    if (!Array.isArray(value) && isTagged(value) && !SHELL_NAMES[value.$type]) return value.$value;
    return shellText(value);
};

const SHELL_NAMES: Record<string, string> = {
    objectId: 'ObjectId',
    decimal128: 'NumberDecimal',
    int64: 'NumberLong',
    int32: 'NumberInt',
    uuid: 'UUID',
};

const isTagged = (value: object): value is { $type: string; $value: string } =>
    '$type' in value && '$value' in value && Object.keys(value).length === 2;

/** One line of text for an object or array, with typed values written as constructors. */
const shellText = (value: DbCell): string => {
    if (value === null || value === undefined) return 'null';
    if (typeof value === 'string') return JSON.stringify(value);
    if (typeof value === 'bigint') return `NumberLong("${value}")`;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (value instanceof Date) return `ISODate("${value.toISOString()}")`;
    if (value instanceof Uint8Array) return formatCell(value);
    if (Array.isArray(value)) return `[${value.map(shellText).join(', ')}]`;
    if (isTagged(value)) {
        const name = SHELL_NAMES[value.$type];
        return name
            ? `${name}("${value.$value}")`
            : value.$type === 'regex'
              ? value.$value
              : JSON.stringify(value.$value);
    }
    return `{ ${Object.entries(value)
        .map(
            ([key, item]) =>
                `${/^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key)}: ${shellText(item)}`,
        )
        .join(', ')} }`;
};
