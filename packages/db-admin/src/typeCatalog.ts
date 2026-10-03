/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

/**
 * The data types each engine offers, with what each one takes: a length, a precision and scale,
 * fractional-second digits, a list of values. The designer reads this metadata to decide which
 * inputs to enable for a type, so no form component names a type or an engine.
 */
export type DataTypeCategory =
    | 'Numeric'
    | 'Date and time'
    | 'String'
    | 'Binary'
    | 'Boolean'
    | 'Structured'
    | 'Network'
    | 'Geometric'
    | 'Range'
    | 'Other';

/** What a type is parameterised by. */
export type TypeParams =
    | 'none'
    /** `varchar(255)`. */
    | 'length'
    /** `numeric(10)` or `numeric(10,2)`. */
    | 'precisionScale'
    /** `datetime(6)`: fractional-second digits. */
    | 'fractional'
    /** `enum('a','b')`: a list of quoted values. */
    | 'values';

export interface DataTypeInfo {
    name: string;
    category: DataTypeCategory;
    params: TypeParams;
    /** The type can be marked unsigned (MySQL integers and decimals). */
    unsigned?: boolean;
    /** The type can be an auto increment / identity column. */
    counter?: boolean;
    /** Other names the search matches (`integer` for `int`). */
    aliases?: readonly string[];
    /** A short hint shown beside the type in the list. */
    hint?: string;
}

const t = (
    category: DataTypeCategory,
    name: string,
    params: TypeParams = 'none',
    extra: Partial<DataTypeInfo> = {},
): DataTypeInfo => ({ name, category, params, ...extra });

const mysqlInt = (name: string, hint: string, aliases?: string[]) =>
    t('Numeric', name, 'none', { unsigned: true, counter: true, hint, aliases });

export const MYSQL_TYPES: readonly DataTypeInfo[] = [
    mysqlInt('tinyint', '1 byte'),
    mysqlInt('smallint', '2 bytes'),
    mysqlInt('mediumint', '3 bytes'),
    mysqlInt('int', '4 bytes', ['integer']),
    mysqlInt('bigint', '8 bytes'),
    t('Numeric', 'decimal', 'precisionScale', { unsigned: true, aliases: ['numeric', 'dec'] }),
    t('Numeric', 'numeric', 'precisionScale', { unsigned: true }),
    t('Numeric', 'float', 'precisionScale', { unsigned: true, counter: false }),
    t('Numeric', 'double', 'precisionScale', { unsigned: true, aliases: ['double precision'] }),
    t('Numeric', 'bit', 'length'),
    t('Boolean', 'boolean', 'none', { aliases: ['bool'], hint: 'alias of tinyint(1)' }),
    t('Date and time', 'date'),
    t('Date and time', 'datetime', 'fractional'),
    t('Date and time', 'timestamp', 'fractional'),
    t('Date and time', 'time', 'fractional'),
    t('Date and time', 'year'),
    t('String', 'char', 'length'),
    t('String', 'varchar', 'length'),
    t('String', 'tinytext'),
    t('String', 'text', 'length'),
    t('String', 'mediumtext'),
    t('String', 'longtext'),
    t('Binary', 'binary', 'length'),
    t('Binary', 'varbinary', 'length'),
    t('Binary', 'tinyblob'),
    t('Binary', 'blob', 'length'),
    t('Binary', 'mediumblob'),
    t('Binary', 'longblob'),
    t('Other', 'enum', 'values'),
    t('Other', 'set', 'values'),
    t('Structured', 'json'),
    t('Geometric', 'geometry'),
    t('Geometric', 'point'),
    t('Geometric', 'linestring'),
    t('Geometric', 'polygon'),
    t('Geometric', 'multipoint'),
    t('Geometric', 'multilinestring'),
    t('Geometric', 'multipolygon'),
    t('Geometric', 'geometrycollection'),
];

const pgInt = (name: string, hint: string, aliases?: string[]) =>
    t('Numeric', name, 'none', { counter: true, hint, aliases });

export const POSTGRES_TYPES: readonly DataTypeInfo[] = [
    pgInt('smallint', '2 bytes', ['int2']),
    pgInt('integer', '4 bytes', ['int', 'int4']),
    pgInt('bigint', '8 bytes', ['int8']),
    t('Numeric', 'decimal', 'precisionScale'),
    t('Numeric', 'numeric', 'precisionScale'),
    t('Numeric', 'real', 'none', { aliases: ['float4'] }),
    t('Numeric', 'double precision', 'none', { aliases: ['float8', 'double'] }),
    t('Numeric', 'smallserial', 'none', { counter: true, hint: 'auto-numbered smallint' }),
    t('Numeric', 'serial', 'none', { counter: true, hint: 'auto-numbered integer' }),
    t('Numeric', 'bigserial', 'none', { counter: true, hint: 'auto-numbered bigint' }),
    t('Numeric', 'money'),
    t('Boolean', 'boolean', 'none', { aliases: ['bool'] }),
    t('String', 'character varying', 'length', { aliases: ['varchar'] }),
    t('String', 'character', 'length', { aliases: ['char'] }),
    t('String', 'text'),
    t('Binary', 'bytea'),
    t('Binary', 'bit', 'length'),
    t('Binary', 'bit varying', 'length', { aliases: ['varbit'] }),
    t('Date and time', 'date'),
    t('Date and time', 'time', 'fractional'),
    t('Date and time', 'time with time zone', 'fractional', { aliases: ['timetz'] }),
    t('Date and time', 'timestamp', 'fractional'),
    t('Date and time', 'timestamp with time zone', 'fractional', { aliases: ['timestamptz'] }),
    t('Date and time', 'interval'),
    t('Structured', 'uuid'),
    t('Structured', 'json'),
    t('Structured', 'jsonb'),
    t('Structured', 'xml'),
    t('Structured', 'tsvector'),
    t('Structured', 'tsquery'),
    t('Network', 'inet'),
    t('Network', 'cidr'),
    t('Network', 'macaddr'),
    t('Network', 'macaddr8'),
    t('Geometric', 'point'),
    t('Geometric', 'line'),
    t('Geometric', 'lseg'),
    t('Geometric', 'box'),
    t('Geometric', 'path'),
    t('Geometric', 'polygon'),
    t('Geometric', 'circle'),
    t('Range', 'int4range'),
    t('Range', 'int8range'),
    t('Range', 'numrange'),
    t('Range', 'daterange'),
    t('Range', 'tsrange'),
    t('Range', 'tstzrange'),
    t('Range', 'int4multirange'),
    t('Range', 'tstzmultirange'),
    t('Other', 'pg_lsn'),
    t('Other', 'oid'),
];

export const TYPE_CATEGORY_ORDER: readonly DataTypeCategory[] = [
    'Numeric',
    'Boolean',
    'String',
    'Binary',
    'Date and time',
    'Structured',
    'Network',
    'Geometric',
    'Range',
    'Other',
];

/** The type names, in catalog order. */
export const typeNames = (catalog: readonly DataTypeInfo[]): string[] =>
    catalog.map((type) => type.name);

/** Finds a type by name or alias, ignoring case and a trailing `[]` array marker. */
export const findType = (
    catalog: readonly DataTypeInfo[],
    text: string,
): DataTypeInfo | undefined => {
    const wanted = text
        .trim()
        .toLowerCase()
        .replace(/(\[\d*\])+$/, '');
    return catalog.find(
        (type) => type.name === wanted || type.aliases?.some((alias) => alias === wanted),
    );
};

/** The catalog entries matching a search text, best matches first (name before alias before hint). */
export const searchTypes = (catalog: readonly DataTypeInfo[], query: string): DataTypeInfo[] => {
    const needle = query
        .trim()
        .toLowerCase()
        .replace(/(\[\d*\])+$/, '');
    if (!needle) return [...catalog];
    const score = (type: DataTypeInfo): number => {
        if (type.name === needle) return 0;
        // An alias typed in full is what was meant, ahead of longer names that start with it.
        if (type.aliases?.includes(needle)) return 0.5;
        if (type.name.startsWith(needle)) return 1;
        if (type.aliases?.some((alias) => alias.startsWith(needle))) return 2;
        if (type.name.includes(needle)) return 3;
        if (type.category.toLowerCase().includes(needle)) return 4;
        if (type.aliases?.some((alias) => alias.includes(needle))) return 5;
        return Infinity;
    };
    return catalog
        .map((type) => ({ type, rank: score(type) }))
        .filter((item) => item.rank !== Infinity)
        .sort((a, b) => a.rank - b.rank)
        .map((item) => item.type);
};

/* ---------- MongoDB ---------- */

export const BSON_TYPES = [
    'double',
    'string',
    'object',
    'array',
    'binData',
    'objectId',
    'bool',
    'date',
    'null',
    'regex',
    'javascript',
    'int',
    'timestamp',
    'long',
    'decimal',
    'minKey',
    'maxKey',
] as const;

export type BsonTypeName = (typeof BSON_TYPES)[number];
