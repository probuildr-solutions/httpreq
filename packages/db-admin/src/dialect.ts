/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

/**
 * The differences between SQL engines that statement generation needs, behind one interface (the
 * strategy pattern): how to quote a name, write a value, qualify a table and which data types the
 * designer offers. The generators in this package take a `SqlDialect` and never test an engine's
 * name; adding an engine means adding a dialect.
 */
export interface ObjectName {
    /** The database (MySQL) or the schema inside the connected database (PostgreSQL). */
    schema?: string;
    database?: string;
    name: string;
}

/** A value the editor can write into a statement. */
export type SqlValue =
    | { kind: 'null' }
    | { kind: 'default' }
    | { kind: 'text'; value: string }
    | { kind: 'number'; value: string }
    | { kind: 'boolean'; value: boolean }
    | { kind: 'json'; value: string }
    | { kind: 'binary'; hex: string };

export interface SqlDialect {
    readonly id: 'mysql' | 'postgresql';
    quote(identifier: string): string;
    /** `db`.`table` or "schema"."table". */
    qualify(name: ObjectName): string;
    literal(value: SqlValue): string;
    /** The data types the table designer offers. */
    readonly dataTypes: readonly string[];
    /** Types that take a length or precision, as shown in the designer. */
    readonly lengthTypes: ReadonlySet<string>;
    /** Whether a column can be marked auto increment / identity. */
    autoIncrementClause(type: string): string;
    /** Appended to a statement that changes one row, so a duplicate match cannot change two. */
    readonly limitOneOnWrite: boolean;
    /** How one page is requested. */
    page(limit: number, offset: number): string;
    /** A case-insensitive "contains" test for the filter bar. */
    containsOperator: string;
    /** The shared hint for the editor's language. */
    readonly language: 'mysql' | 'pgsql';
}

const doubleQuote = (value: string) => `"${value.replace(/"/g, '""')}"`;
const backtick = (value: string) => `\`${value.replace(/`/g, '``')}\``;

const withoutNul = (value: string): string => value.split(String.fromCharCode(0)).join('');

const stringLiteral = (value: string): string => `'${withoutNul(value).replace(/'/g, "''")}'`;

const hexOf = (value: string): string =>
    Array.from(new TextEncoder().encode(value), (byte) => byte.toString(16).padStart(2, '0')).join(
        '',
    );

/**
 * A MySQL string. Whether a backslash escapes depends on the session's sql_mode
 * (NO_BACKSLASH_ESCAPES), so a string holding one is written as its hex bytes, which reads the same
 * in every mode.
 */
const mysqlString = (value: string): string =>
    value.includes(String.fromCharCode(92))
        ? `CONVERT(X'${hexOf(withoutNul(value))}' USING utf8mb4)`
        : stringLiteral(value);

const isNumberText = (text: string) => /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(text.trim());

const commonLiteral = (
    value: SqlValue,
    text: (v: string) => string,
    binary: (hex: string) => string,
    boolean: (v: boolean) => string,
): string => {
    switch (value.kind) {
        case 'null':
            return 'NULL';
        case 'default':
            return 'DEFAULT';
        case 'number':
            // Only text that is a number is written bare; anything else becomes a string, never code.
            return isNumberText(value.value) ? value.value.trim() : text(value.value);
        case 'boolean':
            return boolean(value.value);
        case 'binary':
            return binary(value.hex.replace(/[^0-9a-fA-F]/g, ''));
        case 'json':
        case 'text':
            return text(value.value);
    }
};

export const mysqlDialect: SqlDialect = {
    id: 'mysql',
    language: 'mysql',
    quote: backtick,
    qualify: ({ database, schema, name }) =>
        `${database || schema ? `${backtick((database ?? schema)!)}.` : ''}${backtick(name)}`,
    literal: (value) =>
        commonLiteral(
            value,
            mysqlString,
            (hex) => (hex ? `X'${hex}'` : "''"),
            (v) => (v ? '1' : '0'),
        ),
    dataTypes: [
        'tinyint',
        'smallint',
        'mediumint',
        'int',
        'bigint',
        'decimal',
        'float',
        'double',
        'bit',
        'char',
        'varchar',
        'tinytext',
        'text',
        'mediumtext',
        'longtext',
        'binary',
        'varbinary',
        'tinyblob',
        'blob',
        'mediumblob',
        'longblob',
        'date',
        'time',
        'datetime',
        'timestamp',
        'year',
        'json',
        'enum',
        'set',
        'boolean',
    ],
    lengthTypes: new Set([
        'char',
        'varchar',
        'binary',
        'varbinary',
        'decimal',
        'float',
        'double',
        'bit',
        'tinyint',
        'smallint',
        'mediumint',
        'int',
        'bigint',
        'datetime',
        'timestamp',
        'time',
        'enum',
        'set',
    ]),
    autoIncrementClause: () => 'AUTO_INCREMENT',
    limitOneOnWrite: true,
    page: (limit, offset) => (offset > 0 ? `LIMIT ${limit} OFFSET ${offset}` : `LIMIT ${limit}`),
    containsOperator: 'LIKE',
};

export const postgresDialect: SqlDialect = {
    id: 'postgresql',
    language: 'pgsql',
    quote: doubleQuote,
    qualify: ({ schema, name }) => `${schema ? `${doubleQuote(schema)}.` : ''}${doubleQuote(name)}`,
    // Standard-conforming strings are on in every supported server, so a backslash is plain.
    literal: (value) =>
        commonLiteral(
            value,
            stringLiteral,
            (hex) => `'\\x${hex}'::bytea`,
            (v) => (v ? 'TRUE' : 'FALSE'),
        ),
    dataTypes: [
        'smallint',
        'integer',
        'bigint',
        'numeric',
        'real',
        'double precision',
        'money',
        'boolean',
        'character varying',
        'character',
        'text',
        'bytea',
        'date',
        'time',
        'timestamp',
        'timestamp with time zone',
        'time with time zone',
        'interval',
        'uuid',
        'json',
        'jsonb',
        'xml',
        'inet',
        'cidr',
        'macaddr',
        'serial',
        'bigserial',
    ],
    lengthTypes: new Set(['character varying', 'character', 'numeric', 'time', 'timestamp']),
    autoIncrementClause: () => 'GENERATED BY DEFAULT AS IDENTITY',
    limitOneOnWrite: false,
    page: (limit, offset) => `LIMIT ${limit} OFFSET ${offset}`,
    containsOperator: 'ILIKE',
};

export const dialectOf = (engine: string): SqlDialect => {
    if (engine === 'mysql') return mysqlDialect;
    if (engine === 'postgresql') return postgresDialect;
    throw new Error(`There is no SQL dialect for ${engine}.`);
};

/**
 * Escapes `%`, `_` and the escape character itself for a LIKE pattern. The escape character is `!`
 * (written with `ESCAPE '!'`), not a backslash, because a backslash means something different in
 * MySQL depending on its sql_mode.
 */
export const escapeLike = (text: string): string => text.replace(/[!%_]/g, (c) => `!${c}`);
