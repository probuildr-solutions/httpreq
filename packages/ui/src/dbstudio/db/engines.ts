/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

/**
 * What the window needs to know about an engine to present it: the editor's language, how its
 * statements are split, how its objects are arranged in the explorer, and how to write a
 * statement that shows an object. The host knows nothing of these; they are about presentation.
 */

export type SplitDialect = 'mysql' | 'postgresql' | 'mongodb' | 'redis';
export type EditorLanguage = 'mysql' | 'pgsql' | 'javascript' | 'plaintext';

export interface GroupLayout {
    id: 'tables' | 'views' | 'routines' | 'triggers' | 'events';
    label: string;
    /** The kinds of object listed under `tables` or `views`; every kind when absent. */
    kinds?: string[];
}

export interface EngineLayout {
    language: EditorLanguage;
    split: SplitDialect;
    /** A level between the database and its objects (PostgreSQL schemas). */
    schemas: boolean;
    groups: GroupLayout[];
    /** The name of the object that is opened with a double click, for menus. */
    objectNoun: string;
    /** Whether an object expands to show its fields and indexes. */
    objectsExpand: boolean;
    /** The engine's wording for running statements. */
    statementNoun: string;
    /** A line shown in an empty editor to say how to begin. */
    hint: string;
}

const MYSQL_GROUPS: GroupLayout[] = [
    { id: 'tables', label: 'Tables', kinds: ['table'] },
    { id: 'views', label: 'Views', kinds: ['view'] },
    { id: 'routines', label: 'Routines' },
    { id: 'triggers', label: 'Triggers' },
    { id: 'events', label: 'Events' },
];

const LAYOUTS: Record<string, EngineLayout> = {
    mysql: {
        language: 'mysql',
        split: 'mysql',
        schemas: false,
        groups: MYSQL_GROUPS,
        objectNoun: 'table',
        objectsExpand: true,
        statementNoun: 'statement',
        hint: 'SELECT 1;',
    },
    postgresql: {
        language: 'pgsql',
        split: 'postgresql',
        schemas: true,
        groups: [
            { id: 'tables', label: 'Tables', kinds: ['table', 'foreign table'] },
            { id: 'views', label: 'Views', kinds: ['view', 'materialized view'] },
            { id: 'routines', label: 'Functions' },
            { id: 'triggers', label: 'Triggers' },
        ],
        objectNoun: 'table',
        objectsExpand: true,
        statementNoun: 'statement',
        hint: 'SELECT 1;',
    },
    mongodb: {
        language: 'javascript',
        split: 'mongodb',
        schemas: false,
        groups: [
            { id: 'tables', label: 'Collections', kinds: ['table'] },
            { id: 'views', label: 'Views', kinds: ['view'] },
        ],
        objectNoun: 'collection',
        objectsExpand: true,
        statementNoun: 'statement',
        hint: 'db.collection.find({})',
    },
    redis: {
        language: 'plaintext',
        split: 'redis',
        schemas: false,
        groups: [{ id: 'tables', label: 'Keys' }],
        objectNoun: 'key',
        objectsExpand: false,
        statementNoun: 'command',
        hint: 'PING',
    },
};

export const layoutOf = (engine: string): EngineLayout => LAYOUTS[engine] ?? LAYOUTS.mysql!;

/** Quotes an identifier the way the engine's statements need it. */
export const quoteName = (engine: string, name: string): string => {
    switch (engine) {
        case 'postgresql':
            return `"${name.replace(/"/g, '""')}"`;
        case 'mongodb':
            return JSON.stringify(name);
        case 'redis':
            return /^[A-Za-z0-9_.:/@#%+=,-]+$/.test(name)
                ? name
                : `"${name.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
        default:
            return `\`${name.replace(/`/g, '``')}\``;
    }
};

export interface ObjectTarget {
    database?: string;
    schema?: string;
    name: string;
    /** The engine's kind: `table`, `view`, a Redis key type… */
    kind: string;
}

/** The index of a Redis database named `db3`. */
const redisIndex = (database: string | undefined): string => (database ?? 'db0').replace(/^db/, '');

/** Statements that show what is in an object, one per line (or per statement). */
export const statementsToOpen = (engine: string, target: ObjectTarget, limit = 1000): string => {
    switch (engine) {
        case 'postgresql': {
            const schema = target.schema ? `${quoteName(engine, target.schema)}.` : '';
            return `SELECT *\nFROM ${schema}${quoteName(engine, target.name)}\nLIMIT ${limit};`;
        }
        case 'mongodb': {
            const use = target.database ? `use ${target.database}\n` : '';
            return `${use}db.getCollection(${JSON.stringify(target.name)}).find({}).limit(${Math.min(limit, 100)})`;
        }
        case 'redis': {
            const key = quoteName(engine, target.name);
            const select = `SELECT ${redisIndex(target.database)}\n`;
            switch (target.kind) {
                case 'hash':
                    return `${select}HGETALL ${key}`;
                case 'list':
                    return `${select}LRANGE ${key} 0 ${Math.min(limit, 100) - 1}`;
                case 'set':
                    return `${select}SMEMBERS ${key}`;
                case 'zset':
                    return `${select}ZRANGE ${key} 0 ${Math.min(limit, 100) - 1} WITHSCORES`;
                case 'stream':
                    return `${select}XRANGE ${key} - + COUNT ${Math.min(limit, 100)}`;
                default:
                    return `${select}GET ${key}`;
            }
        }
        default: {
            const database = target.database ? `${quoteName(engine, target.database)}.` : '';
            return `SELECT *\nFROM ${database}${quoteName(engine, target.name)}\nLIMIT ${limit};`;
        }
    }
};

/**
 * What an opened script starts with so it runs where the user chose: the database, and for engines
 * with schemas the schema (PostgreSQL's search path; a connection already runs on one database).
 */
export const startOfScript = (
    engine: string,
    database: string | undefined,
    schema: string | undefined,
): string =>
    startOfQuery(engine, database) +
    (engine === 'postgresql' && schema ? `SET search_path TO ${quoteName(engine, schema)};\n` : '');

/** The text a new query on a database starts with. */
export const startOfQuery = (engine: string, database: string | undefined): string => {
    if (!database) return '';
    switch (engine) {
        case 'mysql':
            return `USE ${quoteName(engine, database)};\n`;
        case 'mongodb':
            return `use ${database}\n`;
        case 'redis':
            return `SELECT ${redisIndex(database)}\n`;
        default:
            return '';
    }
};
