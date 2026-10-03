/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import type { DbValue } from '@httpreq/db-core';
import type { BsonNode } from './bsonDocument';

const base64 = (bytes: Uint8Array): string => {
    let text = '';
    for (let i = 0; i < bytes.length; i += 0x8000)
        text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(text);
};

const isTagged = (value: object): value is { $type: string; $value: string } => {
    const keys = Object.keys(value);
    return (
        keys.length === 2 &&
        typeof (value as { $type?: unknown }).$type === 'string' &&
        typeof (value as { $value?: unknown }).$value === 'string'
    );
};

/**
 * A value as the database host returns it, as a node of the document editor. Types the host does
 * not keep apart are shown by their value (a whole-number double reads as an int32); the editor
 * saves only the fields a person changes, so those are never rewritten by accident.
 */
export const fromDbValue = (value: DbValue): BsonNode => {
    if (value === null || value === undefined) return { t: 'null' };
    switch (typeof value) {
        case 'boolean':
            return { t: 'bool', v: value };
        case 'string':
            return { t: 'string', v: value };
        case 'bigint':
            return { t: 'int64', v: value.toString() };
        case 'number':
            if (Number.isInteger(value)) {
                if (value >= -2147483648 && value <= 2147483647)
                    return { t: 'int32', v: String(value) };
                if (Number.isSafeInteger(value)) return { t: 'int64', v: String(value) };
            }
            return { t: 'double', v: String(value) };
        default:
            break;
    }
    if (value instanceof Date) return { t: 'date', v: value.toISOString() };
    if (value instanceof Uint8Array) return { t: 'binary', v: base64(value), subtype: 0 };
    if (Array.isArray(value)) return { t: 'array', items: value.map(fromDbValue) };
    if (isTagged(value)) {
        const { $type: type, $value: text } = value;
        switch (type) {
            case 'objectId':
                return { t: 'objectId', v: text };
            case 'decimal128':
                return { t: 'decimal128', v: text };
            case 'int64':
                return { t: 'int64', v: text };
            case 'int32':
                return { t: 'int32', v: text };
            case 'double':
                return { t: 'double', v: text };
            case 'uuid':
                return { t: 'uuid', v: text };
            case 'minKey':
                return { t: 'minKey' };
            case 'maxKey':
                return { t: 'maxKey' };
            case 'regex': {
                const last = text.lastIndexOf('/');
                return { t: 'regex', pattern: text.slice(1, last), flags: text.slice(last + 1) };
            }
            case 'timestamp': {
                const [seconds, increment] = text.split(':').map(Number);
                return { t: 'timestamp', seconds: seconds ?? 0, increment: increment ?? 0 };
            }
            case 'date': {
                const date = new Date(Number(text));
                return Number.isNaN(date.getTime())
                    ? { t: 'string', v: text }
                    : { t: 'date', v: date.toISOString() };
            }
            default:
                if (type.startsWith('binary:'))
                    return { t: 'binary', v: text, subtype: Number(type.slice(7)) || 0 };
                return { t: 'string', v: text };
        }
    }
    return {
        t: 'object',
        entries: Object.entries(value).map(([key, item]) => ({
            key,
            value: fromDbValue(item as DbValue),
        })),
    };
};
