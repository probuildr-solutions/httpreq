/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import type { ColumnMeta, DbValue } from '@httpreq/db-core';

/** The kind of value a field holds, for column headers and schema sampling. */
export const typeName = (value: DbValue | undefined): string => {
    if (value === null || value === undefined) return 'null';
    switch (typeof value) {
        case 'boolean':
            return 'bool';
        case 'number':
            return Number.isInteger(value) ? 'int' : 'double';
        case 'bigint':
            return 'long';
        case 'string':
            return 'string';
        default:
            break;
    }
    if (value instanceof Date) return 'date';
    if (value instanceof Uint8Array) return 'binData';
    if (Array.isArray(value)) return 'array';
    const tagged = value as { $type?: unknown; $value?: unknown };
    if (
        typeof tagged.$type === 'string' &&
        typeof tagged.$value === 'string' &&
        Object.keys(value).length === 2
    ) {
        return tagged.$type.startsWith('binary:') ? 'binData' : tagged.$type;
    }
    return 'object';
};

const SHELL_NAMES: Record<string, string> = {
    objectId: 'ObjectId',
    decimal128: 'NumberDecimal',
    int64: 'NumberLong',
    int32: 'NumberInt',
    uuid: 'UUID',
};

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/**
 * Writes a value the way a MongoDB shell prints it, indented, with types spelled as constructors
 * (`ObjectId("…")`, `ISODate("…")`). What it prints, the editor's parser reads back.
 */
export const toShell = (value: DbValue | undefined, indent = 0, step = 2): string => {
    if (value === undefined || value === null) return 'null';
    switch (typeof value) {
        case 'boolean':
            return String(value);
        case 'number':
            return Object.is(value, -0) ? '-0' : String(value);
        case 'bigint':
            return `NumberLong("${value}")`;
        case 'string':
            return JSON.stringify(value);
        default:
            break;
    }
    if (value instanceof Date)
        return Number.isNaN(value.getTime()) ? 'null' : `ISODate("${value.toISOString()}")`;
    if (value instanceof Uint8Array)
        return `BinData(0, "${Buffer.from(value).toString('base64')}")`;
    const pad = ' '.repeat(indent + step);
    const close = ' '.repeat(indent);
    if (Array.isArray(value)) {
        if (value.length === 0) return '[]';
        return `[\n${value.map((item) => pad + toShell(item, indent + step, step)).join(',\n')}\n${close}]`;
    }
    const tagged = value as { $type?: unknown; $value?: unknown };
    if (
        typeof tagged.$type === 'string' &&
        typeof tagged.$value === 'string' &&
        Object.keys(value).length === 2
    ) {
        const type = tagged.$type;
        const text = tagged.$value;
        if (SHELL_NAMES[type]) return `${SHELL_NAMES[type]}(${JSON.stringify(text)})`;
        if (type === 'regex') return text;
        if (type === 'timestamp') return `Timestamp(${text.replace(':', ', ')})`;
        if (type === 'minKey') return 'MinKey()';
        if (type === 'maxKey') return 'MaxKey()';
        if (type === 'double') return text;
        if (type === 'javascript') return JSON.stringify(text);
        if (type.startsWith('binary:')) return `BinData(${type.slice(7)}, "${text}")`;
        return JSON.stringify(text);
    }
    const keys = Object.keys(value);
    if (keys.length === 0) return '{}';
    const entries = keys.map((key) => {
        const name = IDENTIFIER.test(key) ? key : JSON.stringify(key);
        return `${pad}${name}: ${toShell((value as { [key: string]: DbValue })[key], indent + step, step)}`;
    });
    return `{\n${entries.join(',\n')}\n${close}}`;
};

/** One line, for a table cell or a log. */
export const toShellLine = (value: DbValue | undefined): string =>
    toShell(value, 0, 0).replace(/\n/g, ' ').replace(/\s+/g, ' ');

/**
 * Turns documents into table columns. The columns come from the first batch (the keys in order of
 * first appearance, `_id` first, at most `MAX_COLUMNS`); fields that only show up in later
 * documents are counted and reported, never silently dropped.
 */
export const MAX_COLUMNS = 40;

export class DocumentTable {
    private names: string[] = [];
    private seen = new Set<string>();
    /** Documents that had a field that is not a column. */
    hidden = 0;

    /** Fixes the columns from the first documents and returns them. */
    begin(first: { [key: string]: DbValue }[]): ColumnMeta[] {
        for (const document of first) {
            for (const key of Object.keys(document)) {
                if (!this.seen.has(key) && this.names.length < MAX_COLUMNS) {
                    this.seen.add(key);
                    this.names.push(key);
                }
            }
        }
        // `_id` leads when there is one.
        const id = this.names.indexOf('_id');
        if (id > 0) this.names.unshift(...this.names.splice(id, 1));
        return this.names.map((name) => {
            const types = new Set<string>();
            for (const document of first) {
                const value = document[name];
                if (value !== undefined) types.add(typeName(value));
                if (types.size > 2) break;
            }
            types.delete('null');
            return {
                name,
                type: types.size === 0 ? 'null' : types.size === 1 ? [...types][0]! : 'mixed',
            };
        });
    }

    rows(documents: { [key: string]: DbValue }[]): DbValue[][] {
        return documents.map((document) => {
            for (const key of Object.keys(document)) {
                if (!this.seen.has(key)) {
                    this.hidden++;
                    break;
                }
            }
            return this.names.map((name) => document[name] ?? null);
        });
    }
}

/**
 * The `.asDocuments()` result: a single `document` column with each whole document as the cell, so
 * nothing is dropped or flattened.
 */
export class RawDocumentTable {
    hidden = 0;

    begin(first?: unknown[]): ColumnMeta[] {
        void first;
        return [{ name: 'document', type: 'object' }];
    }

    rows(documents: { [key: string]: DbValue }[]): DbValue[][] {
        return documents.map((document) => [document]);
    }
}
