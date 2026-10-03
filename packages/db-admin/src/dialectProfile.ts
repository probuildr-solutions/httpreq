/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { dialectOf, type SqlDialect } from './dialect';
import { routineOptions, triggerOptions } from './objects';
import {
    BSON_TYPES,
    MYSQL_TYPES,
    POSTGRES_TYPES,
    type BsonTypeName,
    type DataTypeInfo,
} from './typeCatalog';

/**
 * Everything the object editors need to know about an engine, behind one interface. The editors
 * (table, trigger, routine, event, collection) ask `dialectProfileOf(engine)` what to show and
 * never compare an engine's name: MySQL, PostgreSQL and MongoDB each provide a profile, and a new
 * engine is one more provider.
 *
 *   DialectProfile
 *     ├── MySqlProfile       (relational, AUTO_INCREMENT, events, UNSIGNED)
 *     ├── PostgreSqlProfile  (relational, identity columns, schemas, INSTEAD OF triggers)
 *     └── MongoDbProfile     (document, collections with a JSON Schema validator)
 */
export type IdentityStyle = 'auto_increment' | 'identity' | 'none';

export interface TableFeatures {
    unsigned: boolean;
    columnComments: boolean;
    generatedColumns: boolean;
    checkConstraints: boolean;
    foreignKeys: boolean;
    uniqueConstraints: boolean;
    partialIndexes: boolean;
    indexMethods: readonly string[];
    /** Identity behaviour a column can have. */
    identity: IdentityStyle;
    /** `serial` pseudo-types exist and `identity` is the modern alternative. */
    serialTypes: boolean;
    /** Types written `type[]`. */
    arrays: boolean;
    /** The table can carry a comment. */
    tableComment: boolean;
}

export interface RelationalProfile {
    kind: 'relational';
    engine: 'mysql' | 'postgresql';
    label: string;
    dialect: SqlDialect;
    typeCatalog: readonly DataTypeInfo[];
    table: TableFeatures;
    trigger: ReturnType<typeof triggerOptions>;
    procedure: ReturnType<typeof routineOptions>;
    function: ReturnType<typeof routineOptions>;
    event: { supported: boolean };
    /** Schemas group tables inside a database (PostgreSQL). */
    schemas: boolean;
    /** The type a new column starts with. */
    defaultColumnType: { type: string; length?: string };
}

export interface DocumentProfile {
    kind: 'document';
    engine: 'mongodb';
    label: string;
    bsonTypes: readonly BsonTypeName[];
    collection: {
        capped: boolean;
        timeSeries: boolean;
        clusteredIndex: boolean;
        collation: boolean;
        validation: boolean;
        nestedFields: boolean;
    };
}

export type DialectProfile = RelationalProfile | DocumentProfile;

const relational = (
    engine: 'mysql' | 'postgresql',
    parts: Pick<
        RelationalProfile,
        'label' | 'typeCatalog' | 'table' | 'event' | 'schemas' | 'defaultColumnType'
    >,
): RelationalProfile => {
    const dialect = dialectOf(engine);
    return {
        kind: 'relational',
        engine,
        dialect,
        trigger: triggerOptions(dialect),
        procedure: routineOptions(dialect, 'procedure'),
        function: routineOptions(dialect, 'function'),
        ...parts,
    };
};

const PROFILES: Record<string, DialectProfile> = {
    mysql: relational('mysql', {
        label: 'MySQL',
        typeCatalog: MYSQL_TYPES,
        schemas: false,
        event: { supported: true },
        defaultColumnType: { type: 'varchar', length: '255' },
        table: {
            unsigned: true,
            columnComments: true,
            generatedColumns: true,
            checkConstraints: true,
            foreignKeys: true,
            uniqueConstraints: true,
            partialIndexes: false,
            indexMethods: ['BTREE', 'HASH'],
            identity: 'auto_increment',
            serialTypes: false,
            arrays: false,
            tableComment: true,
        },
    }),
    postgresql: relational('postgresql', {
        label: 'PostgreSQL',
        typeCatalog: POSTGRES_TYPES,
        schemas: true,
        event: { supported: false },
        defaultColumnType: { type: 'text' },
        table: {
            unsigned: false,
            columnComments: false,
            generatedColumns: true,
            checkConstraints: true,
            foreignKeys: true,
            uniqueConstraints: true,
            partialIndexes: true,
            indexMethods: ['btree', 'hash', 'gin', 'gist', 'spgist', 'brin'],
            identity: 'identity',
            serialTypes: true,
            arrays: true,
            tableComment: true,
        },
    }),
    mongodb: {
        kind: 'document',
        engine: 'mongodb',
        label: 'MongoDB',
        bsonTypes: BSON_TYPES,
        collection: {
            capped: true,
            timeSeries: true,
            clusteredIndex: true,
            collation: true,
            validation: true,
            nestedFields: true,
        },
    },
};

/** The profile of an engine, or `undefined` for one with no object editors (Redis). */
export const dialectProfileOf = (engine: string): DialectProfile | undefined => PROFILES[engine];

/** The relational profile of an engine; throws for one that is not relational. */
export const relationalProfileOf = (engine: string): RelationalProfile => {
    const profile = PROFILES[engine];
    if (profile?.kind !== 'relational') throw new Error(`${engine} has no relational profile.`);
    return profile;
};
