/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { escapeLike, type ObjectName, type SqlDialect, type SqlValue } from './dialect';

/**
 * Statements for browsing and editing the rows of a table: one page at a time, filtered and
 * sorted on the server, and changes addressed by key. The grid never holds a table: it asks for a
 * page, shows it, and writes back single rows.
 */

export type FilterOperator =
    | 'eq'
    | 'ne'
    | 'lt'
    | 'lte'
    | 'gt'
    | 'gte'
    | 'contains'
    | 'startsWith'
    | 'endsWith'
    | 'isNull'
    | 'notNull'
    | 'in';

export const FILTER_OPERATORS: { id: FilterOperator; label: string; needsValue: boolean }[] = [
    { id: 'eq', label: 'equals', needsValue: true },
    { id: 'ne', label: 'does not equal', needsValue: true },
    { id: 'lt', label: 'is less than', needsValue: true },
    { id: 'lte', label: 'is at most', needsValue: true },
    { id: 'gt', label: 'is greater than', needsValue: true },
    { id: 'gte', label: 'is at least', needsValue: true },
    { id: 'contains', label: 'contains', needsValue: true },
    { id: 'startsWith', label: 'starts with', needsValue: true },
    { id: 'endsWith', label: 'ends with', needsValue: true },
    { id: 'in', label: 'is one of (comma separated)', needsValue: true },
    { id: 'isNull', label: 'is empty (NULL)', needsValue: false },
    { id: 'notNull', label: 'is not empty', needsValue: false },
];

export interface FilterClause {
    column: string;
    operator: FilterOperator;
    value?: string;
}

export interface SortClause {
    column: string;
    direction: 'asc' | 'desc';
}

export interface BrowseQuery {
    table: ObjectName;
    /** Columns to read; every column when absent. */
    columns?: string[];
    filters: FilterClause[];
    /** A WHERE condition the user wrote; ANDed with the filters. Never rewritten. */
    rawWhere?: string;
    sort: SortClause[];
    limit: number;
    offset: number;
}

const filterSql = (dialect: SqlDialect, filter: FilterClause): string => {
    const column = dialect.quote(filter.column);
    const text = (value: string) => dialect.literal({ kind: 'text', value });
    const value = filter.value ?? '';
    switch (filter.operator) {
        case 'isNull':
            return `${column} IS NULL`;
        case 'notNull':
            return `${column} IS NOT NULL`;
        case 'eq':
            return `${column} = ${text(value)}`;
        case 'ne':
            return `${column} <> ${text(value)}`;
        case 'lt':
            return `${column} < ${text(value)}`;
        case 'lte':
            return `${column} <= ${text(value)}`;
        case 'gt':
            return `${column} > ${text(value)}`;
        case 'gte':
            return `${column} >= ${text(value)}`;
        case 'contains':
        case 'startsWith':
        case 'endsWith': {
            const body = escapeLike(value);
            const pattern =
                filter.operator === 'contains'
                    ? `%${body}%`
                    : filter.operator === 'startsWith'
                      ? `${body}%`
                      : `%${body}`;
            // The column may not be text: both engines accept the comparison after a cast.
            const subject =
                dialect.id === 'postgresql' ? `${column}::text` : `CAST(${column} AS CHAR)`;
            return `${subject} ${dialect.containsOperator} ${text(pattern)} ESCAPE '!'`;
        }
        case 'in': {
            const items = value
                .split(',')
                .map((item) => item.trim())
                .filter(Boolean);
            return items.length ? `${column} IN (${items.map(text).join(', ')})` : 'FALSE';
        }
    }
};

export const whereSql = (
    dialect: SqlDialect,
    filters: FilterClause[],
    rawWhere?: string,
): string => {
    const parts = filters.map((filter) => filterSql(dialect, filter));
    if (rawWhere?.trim()) parts.push(`(${rawWhere.trim()})`);
    return parts.length ? `\nWHERE ${parts.join('\n  AND ')}` : '';
};

export const selectPageSql = (dialect: SqlDialect, query: BrowseQuery): string => {
    const columns = query.columns?.length
        ? query.columns.map((c) => dialect.quote(c)).join(', ')
        : '*';
    const order = query.sort.length
        ? `\nORDER BY ${query.sort.map((s) => `${dialect.quote(s.column)} ${s.direction.toUpperCase()}`).join(', ')}`
        : '';
    return `SELECT ${columns}\nFROM ${dialect.qualify(query.table)}${whereSql(dialect, query.filters, query.rawWhere)}${order}\n${dialect.page(query.limit, query.offset)};`;
};

export const countSql = (
    dialect: SqlDialect,
    table: ObjectName,
    filters: FilterClause[],
    rawWhere?: string,
): string =>
    `SELECT COUNT(*) AS total FROM ${dialect.qualify(table)}${whereSql(dialect, filters, rawWhere)};`;

/* ---------- Single-row changes ---------- */

export interface ColumnValue {
    column: string;
    value: SqlValue;
}

const keyWhere = (dialect: SqlDialect, key: ColumnValue[]): string => {
    if (key.length === 0)
        throw new Error('A row can only be changed when it can be identified by a key.');
    return key
        .map(({ column, value }) =>
            value.kind === 'null'
                ? `${dialect.quote(column)} IS NULL`
                : `${dialect.quote(column)} = ${dialect.literal(value)}`,
        )
        .join(' AND ');
};

export const insertRowSql = (
    dialect: SqlDialect,
    table: ObjectName,
    values: ColumnValue[],
): string => {
    const target = dialect.qualify(table);
    if (values.length === 0)
        return dialect.id === 'mysql'
            ? `INSERT INTO ${target} () VALUES ();`
            : `INSERT INTO ${target} DEFAULT VALUES;`;
    return `INSERT INTO ${target} (${values.map((v) => dialect.quote(v.column)).join(', ')})\nVALUES (${values.map((v) => dialect.literal(v.value)).join(', ')});`;
};

export const updateRowSql = (
    dialect: SqlDialect,
    table: ObjectName,
    key: ColumnValue[],
    changes: ColumnValue[],
): string => {
    if (changes.length === 0) throw new Error('There is nothing to change.');
    return `UPDATE ${dialect.qualify(table)}\nSET ${changes.map((c) => `${dialect.quote(c.column)} = ${dialect.literal(c.value)}`).join(', ')}\nWHERE ${keyWhere(dialect, key)}${dialect.limitOneOnWrite ? '\nLIMIT 1' : ''};`;
};

export const deleteRowSql = (dialect: SqlDialect, table: ObjectName, key: ColumnValue[]): string =>
    `DELETE FROM ${dialect.qualify(table)}\nWHERE ${keyWhere(dialect, key)}${dialect.limitOneOnWrite ? '\nLIMIT 1' : ''};`;

/* ---------- Cell values ---------- */

export type TypeCategory = 'number' | 'boolean' | 'json' | 'binary' | 'temporal' | 'text';

export const categoryOfType = (type: string): TypeCategory => {
    const t = type.toLowerCase();
    if (/\b(json|jsonb)\b/.test(t)) return 'json';
    if (/(blob|binary|bytea|varbinary)/.test(t)) return 'binary';
    if (/^(bool|boolean)\b/.test(t)) return 'boolean';
    if (/^(tinyint\(1\)|bit\(1\))$/.test(t)) return 'boolean';
    if (/(int|serial|decimal|numeric|float|double|real|money|bit|year)/.test(t)) return 'number';
    if (/(date|time|interval)/.test(t)) return 'temporal';
    return 'text';
};

/**
 * Reads what the user typed in a cell into a value for the column's type, or says why it cannot.
 * `null` and `default` are chosen explicitly (a menu or button), never by typing a word, so the
 * text "NULL" stays text.
 */
export const parseCellInput = (
    type: string,
    input: string,
): { ok: true; value: SqlValue } | { ok: false; error: string } => {
    switch (categoryOfType(type)) {
        case 'number':
            return /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(input.trim())
                ? { ok: true, value: { kind: 'number', value: input.trim() } }
                : { ok: false, error: 'Enter a number.' };
        case 'boolean': {
            const text = input.trim().toLowerCase();
            if (['true', 't', '1', 'yes', 'on'].includes(text))
                return { ok: true, value: { kind: 'boolean', value: true } };
            if (['false', 'f', '0', 'no', 'off'].includes(text))
                return { ok: true, value: { kind: 'boolean', value: false } };
            return { ok: false, error: 'Enter true or false.' };
        }
        case 'json':
            try {
                JSON.parse(input);
                return { ok: true, value: { kind: 'json', value: input } };
            } catch (error) {
                return { ok: false, error: `Not valid JSON: ${(error as Error).message}` };
            }
        case 'binary': {
            const hex = input.trim().replace(/^0x/i, '').replace(/\s+/g, '');
            return /^[0-9a-fA-F]*$/.test(hex) && hex.length % 2 === 0
                ? { ok: true, value: { kind: 'binary', hex } }
                : { ok: false, error: 'Enter bytes as hexadecimal digits, two per byte.' };
        }
        default:
            return { ok: true, value: { kind: 'text', value: input } };
    }
};
