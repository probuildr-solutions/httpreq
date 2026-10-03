/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { describe, expect, it } from 'vitest';
import {
    BSON_TYPES,
    MYSQL_TYPES,
    POSTGRES_TYPES,
    alterEventSql,
    createCollectionFromDesign,
    createEventSql,
    createRoutineSql,
    createTableSql,
    createTriggerSql,
    dialectProfileOf,
    addChildField,
    duplicateFieldIn,
    emptyCollection,
    emptyDesign,
    emptyEvent,
    eventFromDefinition,
    fieldsFromJsonSchema,
    flattenFields,
    findType,
    jsonSchemaFromFields,
    moveFieldIn,
    mysqlDialect,
    newField,
    postgresDialect,
    relationalProfileOf,
    removeFieldIn,
    searchTypes,
    updateFieldIn,
    updateItemsIn,
    validateCollection,
    validateEvent,
    validateRoutine,
    validateTrigger,
    type FieldDesign,
    type TriggerDesign,
} from './index';

const names = (catalog: readonly { name: string }[]) => catalog.map((type) => type.name);

describe('type catalogs', () => {
    it('offers the MySQL types of every category', () => {
        const have = names(MYSQL_TYPES);
        for (const type of [
            'tinyint',
            'smallint',
            'mediumint',
            'int',
            'bigint',
            'decimal',
            'numeric',
            'float',
            'double',
            'bit',
            'date',
            'datetime',
            'timestamp',
            'time',
            'year',
            'char',
            'varchar',
            'binary',
            'varbinary',
            'tinytext',
            'text',
            'mediumtext',
            'longtext',
            'tinyblob',
            'blob',
            'mediumblob',
            'longblob',
            'enum',
            'set',
            'json',
            'geometry',
            'point',
            'polygon',
        ])
            expect(have).toContain(type);
    });

    it('offers the PostgreSQL types, including ranges, geometry and identity-capable integers', () => {
        const have = names(POSTGRES_TYPES);
        for (const type of [
            'smallint',
            'integer',
            'bigint',
            'decimal',
            'numeric',
            'real',
            'double precision',
            'smallserial',
            'serial',
            'bigserial',
            'character',
            'character varying',
            'text',
            'bytea',
            'date',
            'time',
            'time with time zone',
            'timestamp',
            'timestamp with time zone',
            'interval',
            'boolean',
            'uuid',
            'json',
            'jsonb',
            'xml',
            'inet',
            'cidr',
            'macaddr',
            'int4range',
            'tstzrange',
            'point',
            'polygon',
        ])
            expect(have).toContain(type);
        expect(POSTGRES_TYPES.find((type) => type.name === 'integer')?.counter).toBe(true);
    });

    it('finds a type by alias and ignores an array suffix', () => {
        expect(findType(POSTGRES_TYPES, 'INT4')?.name).toBe('integer');
        expect(findType(POSTGRES_TYPES, 'varchar[]')?.name).toBe('character varying');
        expect(findType(MYSQL_TYPES, 'integer')?.name).toBe('int');
        expect(findType(MYSQL_TYPES, 'nonsense')).toBeUndefined();
    });

    it('searches best matches first', () => {
        const hits = names(searchTypes(MYSQL_TYPES, 'int'));
        expect(hits[0]).toBe('int');
        expect(hits).toContain('bigint');
        expect(searchTypes(MYSQL_TYPES, '').length).toBe(MYSQL_TYPES.length);
        expect(names(searchTypes(POSTGRES_TYPES, 'range'))).toContain('daterange');
    });

    it('drives the dialects, so the designer lists exactly the catalog', () => {
        expect(mysqlDialect.dataTypes).toEqual(names(MYSQL_TYPES));
        expect(postgresDialect.dataTypes).toEqual(names(POSTGRES_TYPES));
        expect(mysqlDialect.lengthTypes.has('varchar')).toBe(true);
        expect(postgresDialect.lengthTypes.has('numeric')).toBe(true);
        expect(postgresDialect.lengthTypes.has('text')).toBe(false);
    });

    it('lists the BSON types', () => {
        expect(BSON_TYPES).toEqual(
            expect.arrayContaining([
                'double',
                'objectId',
                'decimal',
                'minKey',
                'maxKey',
                'binData',
            ]),
        );
    });
});

describe('dialect profiles', () => {
    it('describes each engine through data, not comparisons', () => {
        const mysql = relationalProfileOf('mysql');
        const pg = relationalProfileOf('postgresql');
        expect(mysql.table.identity).toBe('auto_increment');
        expect(mysql.table.unsigned).toBe(true);
        expect(mysql.event.supported).toBe(true);
        expect(pg.table.identity).toBe('identity');
        expect(pg.table.serialTypes).toBe(true);
        expect(pg.table.partialIndexes).toBe(true);
        expect(pg.event.supported).toBe(false);
        expect(pg.schemas).toBe(true);
        expect(pg.trigger.timings).toContain('INSTEAD OF');
        expect(mysql.trigger.timings).not.toContain('INSTEAD OF');
        expect(mysql.function.modes).toEqual(['IN']);
        expect(pg.procedure.modes).toEqual(['IN', 'OUT', 'INOUT']);
    });

    it('gives MongoDB a document profile and Redis none', () => {
        const mongo = dialectProfileOf('mongodb');
        expect(mongo?.kind).toBe('document');
        expect(mongo && mongo.kind === 'document' && mongo.collection.timeSeries).toBe(true);
        expect(dialectProfileOf('redis')).toBeUndefined();
        expect(() => relationalProfileOf('mongodb')).toThrow();
    });
});

describe('triggers', () => {
    const trigger = (patch: Partial<TriggerDesign> = {}): TriggerDesign => ({
        name: 'audit_users',
        table: 'users',
        timing: 'AFTER',
        events: ['INSERT'],
        body: 'INSERT INTO log VALUES (NEW.id);',
        ...patch,
    });

    it('accepts a valid MySQL trigger and orders it against another', () => {
        expect(validateTrigger(mysqlDialect, trigger())).toEqual([]);
        const [sql] = createTriggerSql(
            mysqlDialect,
            trigger({ order: { position: 'FOLLOWS', trigger: 'first_one' } }),
        );
        expect(sql).toContain('FOR EACH ROW\nFOLLOWS `first_one`');
    });

    it('rejects what MySQL cannot do', () => {
        const problems = validateTrigger(
            mysqlDialect,
            trigger({ timing: 'INSTEAD OF', events: ['INSERT', 'UPDATE'] }),
        );
        expect(problems.join(' ')).toMatch(/INSTEAD OF/);
        expect(problems.join(' ')).toMatch(/one event/);
        expect(validateTrigger(mysqlDialect, trigger({ events: ['TRUNCATE'] })).join(' ')).toMatch(
            /TRUNCATE/,
        );
    });

    it('supports multiple events, TRUNCATE and a column list on PostgreSQL', () => {
        const design = trigger({
            events: ['INSERT', 'UPDATE'],
            updateOf: ['email'],
            when: 'NEW.email IS NOT NULL',
        });
        expect(validateTrigger(postgresDialect, design)).toEqual([]);
        const statements = createTriggerSql(postgresDialect, design);
        expect(statements[1]).toContain('INSERT OR UPDATE OF "email" ON');
        expect(statements[1]).toContain('WHEN (NEW.email IS NOT NULL)');
        expect(
            validateTrigger(
                postgresDialect,
                trigger({ events: ['TRUNCATE'], forEachRow: true }),
            ).join(' '),
        ).toMatch(/once per statement/);
        expect(
            validateTrigger(postgresDialect, trigger({ events: ['TRUNCATE'], forEachRow: false })),
        ).toEqual([]);
    });

    it('asks for the missing pieces', () => {
        const problems = validateTrigger(
            mysqlDialect,
            trigger({ name: ' ', table: '', events: [], body: '' }),
        );
        expect(problems).toHaveLength(4);
    });
});

describe('routines', () => {
    const base = {
        kind: 'procedure' as const,
        name: 'archive_old',
        parameters: [{ name: 'cutoff', mode: 'IN' as const, type: 'date' }],
        body: 'DELETE FROM t WHERE d < cutoff;',
    };

    it('validates parameters and the return type', () => {
        expect(validateRoutine(mysqlDialect, base)).toEqual([]);
        const problems = validateRoutine(mysqlDialect, {
            ...base,
            kind: 'function',
            parameters: [
                { name: 'a', mode: 'OUT', type: 'int' },
                { name: 'a', mode: 'IN', type: '' },
                { name: '1bad', mode: 'IN', type: 'int' },
            ],
        });
        expect(problems.join(' ')).toMatch(/OUT is not available for a function/);
        expect(problems.join(' ')).toMatch(/used twice/);
        expect(problems.join(' ')).toMatch(/needs a data type/);
        expect(problems.join(' ')).toMatch(/plain identifier/);
        expect(problems.join(' ')).toMatch(/return type/);
    });

    it('writes PostgreSQL defaults, security and ownership', () => {
        const statements = createRoutineSql(postgresDialect, {
            ...base,
            parameters: [{ name: 'cutoff', mode: 'IN', type: 'date', default: 'now()' }],
            security: 'DEFINER',
            owner: 'admin',
        });
        expect(statements[0]).toContain('IN "cutoff" date DEFAULT now()');
        expect(statements[0]).toContain('SECURITY DEFINER');
        expect(statements[1]).toBe('ALTER PROCEDURE "archive_old"(date) OWNER TO "admin";');
    });

    it('writes MySQL security and comment, and leaves PostgreSQL-only options out', () => {
        const [sql] = createRoutineSql(mysqlDialect, {
            ...base,
            parameters: [{ name: 'cutoff', mode: 'IN', type: 'date', default: 'now()' }],
            security: 'INVOKER',
            comment: 'Cleanup',
            owner: 'ignored',
        });
        expect(sql).toContain("SQL SECURITY INVOKER\nCOMMENT 'Cleanup'");
        expect(sql).not.toContain('DEFAULT');
        expect(sql).not.toContain('OWNER');
    });
});

describe('events', () => {
    it('writes a recurring event with start and end', () => {
        const [sql] = createEventSql(mysqlDialect, {
            ...emptyEvent(),
            name: 'nightly',
            database: 'shop',
            interval: { every: 1, unit: 'DAY' },
            start: '2026-01-01T02:00',
            end: '2026-12-31 00:00:00',
            comment: 'Purge',
            body: 'DELETE FROM sessions WHERE expired = 1',
        });
        expect(sql).toBe(
            [
                'CREATE EVENT `shop`.`nightly`',
                "ON SCHEDULE EVERY 1 DAY STARTS '2026-01-01 02:00:00' ENDS '2026-12-31 00:00:00'",
                'ON COMPLETION PRESERVE',
                'ENABLE',
                "COMMENT 'Purge'",
                'DO DELETE FROM sessions WHERE expired = 1;',
            ].join('\n'),
        );
    });

    it('writes a one-off event, not preserved and disabled, wrapping several statements', () => {
        const [sql] = createEventSql(mysqlDialect, {
            ...emptyEvent(),
            name: 'once',
            schedule: 'once',
            start: '2026-05-05 10:00:00',
            preserve: false,
            status: 'DISABLE',
            body: 'DELETE FROM a; DELETE FROM b;',
        });
        expect(sql).toContain("ON SCHEDULE AT '2026-05-05 10:00:00'");
        expect(sql).toContain('ON COMPLETION NOT PRESERVE\nDISABLE');
        expect(sql).toContain('DO BEGIN\nDELETE FROM a; DELETE FROM b;;\nEND;'.replace(';;', ';'));
    });

    it('drops before creating when editing', () => {
        const statements = alterEventSql(mysqlDialect, {
            ...emptyEvent(),
            name: 'nightly',
            body: 'SELECT 1',
        });
        expect(statements[0]).toBe('DROP EVENT IF EXISTS `nightly`;');
        expect(statements[1]).toMatch(/^CREATE EVENT/);
    });

    it('validates the schedule', () => {
        expect(validateEvent({ ...emptyEvent(), name: 'x', body: 'SELECT 1' })).toEqual([]);
        const problems = validateEvent({
            ...emptyEvent(),
            name: '',
            interval: { every: 0, unit: 'DAY' },
            start: '2026-02-01 00:00:00',
            end: '2026-01-01 00:00:00',
            body: '',
        });
        expect(problems.join(' ')).toMatch(/needs a name/);
        expect(problems.join(' ')).toMatch(/whole number/);
        expect(problems.join(' ')).toMatch(/end must come after/);
        expect(problems.join(' ')).toMatch(/needs a body/);
        expect(
            validateEvent({ ...emptyEvent(), name: 'x', schedule: 'once', body: 'SELECT 1' }),
        ).toEqual(['Choose when the event runs.']);
    });

    it('reads an event back from its definition', () => {
        const event = eventFromDefinition(
            "CREATE EVENT `nightly` ON SCHEDULE EVERY 2 HOUR STARTS '2026-01-01 00:00:00' ON COMPLETION NOT PRESERVE DISABLE COMMENT 'it''s' DO DELETE FROM t",
            { name: 'nightly', database: 'shop' },
        );
        expect(event).toMatchObject({
            schedule: 'recurring',
            interval: { every: 2, unit: 'HOUR' },
            start: '2026-01-01 00:00:00',
            preserve: false,
            status: 'DISABLE',
            comment: "it's",
            body: 'DELETE FROM t',
        });
    });
});

describe('collection designer', () => {
    it('builds a nested JSON Schema from fields', () => {
        const address = { ...newField('object'), name: 'address', required: true };
        address.children = [
            { ...newField('string'), name: 'city', required: true, rules: { maxLength: '60' } },
        ];
        const tags = { ...newField('array'), name: 'tags', rules: { minItems: '1' } };
        tags.items = { bsonType: 'string', children: [] };
        const age = {
            ...newField('int'),
            name: 'age',
            description: 'in years',
            rules: { minimum: '0', maximum: '150' },
        };
        const schema = jsonSchemaFromFields([address, tags, age, newField('string')]);
        expect(schema).toEqual({
            bsonType: 'object',
            required: ['address'],
            properties: {
                address: {
                    bsonType: 'object',
                    required: ['city'],
                    properties: { city: { bsonType: 'string', maxLength: 60 } },
                },
                tags: { bsonType: 'array', minItems: 1, items: { bsonType: 'string' } },
                age: { bsonType: 'int', description: 'in years', minimum: 0, maximum: 150 },
            },
        });
    });

    it('reads fields back from a schema, nested and with array items', () => {
        const fields = fieldsFromJsonSchema({
            bsonType: 'object',
            required: ['name'],
            properties: {
                name: { bsonType: 'string', enum: ['a', 'b'] },
                lines: {
                    bsonType: 'array',
                    items: {
                        bsonType: 'object',
                        properties: { sku: { bsonType: 'string' } },
                    },
                },
            },
        });
        expect(fields.map((field) => [field.name, field.bsonType, field.required])).toEqual([
            ['name', 'string', true],
            ['lines', 'array', false],
        ]);
        expect(fields[0]!.rules.enum).toBe('a, b');
        expect(fields[1]!.items?.children[0]?.name).toBe('sku');
    });

    it('creates a capped collection with a validator', () => {
        const design = {
            ...emptyCollection(),
            name: 'logs',
            database: 'app',
            capped: true,
            sizeBytes: 1048576,
            maxDocuments: 5000,
            fields: [{ ...newField('string'), name: 'level', required: true }],
        };
        expect(validateCollection(design)).toEqual([]);
        const [statement] = createCollectionFromDesign(design);
        expect(statement).toContain('db.getSiblingDB("app").createCollection("logs"');
        expect(statement).toContain('capped: true');
        expect(statement).toContain('size: 1048576');
        expect(statement).toContain('max: 5000');
        expect(statement).toContain('validator: { $jsonSchema:');
        expect(statement).toMatch(/"required": \[\s+"level"/);
    });

    it('creates a time series collection with a collation', () => {
        const [statement] = createCollectionFromDesign({
            ...emptyCollection(),
            name: 'readings',
            timeSeries: {
                timeField: 'ts',
                metaField: 'sensor',
                granularity: 'minutes',
                expireAfterSeconds: 86400,
            },
            collation: { locale: 'en', strength: 2 },
        });
        expect(statement).toContain(
            'timeseries: { timeField: "ts", metaField: "sensor", granularity: "minutes" }',
        );
        expect(statement).toContain('expireAfterSeconds: 86400');
        expect(statement).toContain('collation: { locale: "en", strength: 2 }');
        expect(statement).not.toContain('validator');
    });

    it('rejects impossible designs', () => {
        const problems = validateCollection({
            ...emptyCollection(),
            name: 'system.x',
            capped: true,
            timeSeries: { timeField: '' },
            clusteredIndex: true,
            fields: [
                { ...newField('string'), name: 'a', rules: { pattern: '(' } },
                { ...newField('int'), name: 'a', rules: { minimum: 'abc' } },
                newField('string'),
            ],
        });
        const text = problems.join(' | ');
        expect(text).toMatch(/reserved/);
        expect(text).toMatch(/cannot be capped/);
        expect(text).toMatch(/maximum size/);
        expect(text).toMatch(/time field/);
        expect(text).toMatch(/clustered index/);
        expect(text).toMatch(/not a valid expression/);
        expect(text).toMatch(/defined twice/);
        expect(text).toMatch(/must be a number/);
        expect(text).toMatch(/has no name/);
    });
});

describe('collection field tree', () => {
    const field = (name: string, type: Parameters<typeof newField>[0] = 'string') => ({
        ...newField(type),
        name,
    });

    it('flattens objects, arrays and their items depth first', () => {
        const address = { ...field('address', 'object'), children: [field('city'), field('zip')] };
        const lines = {
            ...field('lines', 'array'),
            items: { bsonType: 'object' as const, children: [field('sku')] },
        };
        const rows = flattenFields([address, lines, field('age', 'int')]);
        expect(rows.map((r) => [r.kind === 'items' ? '[]' : r.field.name, r.depth])).toEqual([
            ['address', 0],
            ['city', 1],
            ['zip', 1],
            ['lines', 0],
            ['[]', 1],
            ['sku', 2],
            ['age', 0],
        ]);
        expect(rows.find((r) => r.field.name === 'address')?.canNest).toBe(true);
        expect(rows.find((r) => r.field.name === 'age')?.canNest).toBe(false);
    });

    it('adds a child to an object and to the items of an array', () => {
        const address = field('address', 'object');
        const lines = {
            ...field('lines', 'array'),
            items: { bsonType: 'object' as const, children: [] },
        };
        let tree = addChildField([address, lines], address.id, field('city'));
        tree = addChildField(tree, `${lines.id}:items`, field('sku'));
        expect(tree[0]!.children.map((f) => f.name)).toEqual(['city']);
        expect(tree[1]!.items?.children.map((f) => f.name)).toEqual(['sku']);
        expect(addChildField(tree, null, field('top')).map((f) => f.name)).toEqual([
            'address',
            'lines',
            'top',
        ]);
    });

    it('updates, removes, duplicates and moves fields at any depth', () => {
        const city = field('city');
        const zip = field('zip');
        const address = { ...field('address', 'object'), children: [city, zip] };
        let tree: FieldDesign[] = [address];

        tree = updateFieldIn(tree, zip.id, { required: true });
        expect(tree[0]!.children[1]!.required).toBe(true);

        tree = moveFieldIn(tree, zip.id, -1);
        expect(tree[0]!.children.map((f) => f.name)).toEqual(['zip', 'city']);
        expect(moveFieldIn(tree, zip.id, -1)[0]!.children.map((f) => f.name)).toEqual([
            'zip',
            'city',
        ]);

        tree = duplicateFieldIn(tree, city.id);
        expect(tree[0]!.children.map((f) => f.name)).toEqual(['zip', 'city', 'city_copy']);
        expect(new Set(tree[0]!.children.map((f) => f.id)).size).toBe(3);

        tree = removeFieldIn(tree, zip.id);
        expect(tree[0]!.children.map((f) => f.name)).toEqual(['city', 'city_copy']);
    });

    it('drops children and items when a field changes type', () => {
        const address = { ...field('address', 'object'), children: [field('city')] };
        const asString = updateFieldIn([address], address.id, { bsonType: 'string' })[0]!;
        expect(asString.children).toEqual([]);
        const asArray = updateFieldIn([address], address.id, { bsonType: 'array' })[0]!;
        expect(asArray.items?.bsonType).toBe('string');
        expect(updateItemsIn([asArray], address.id, 'int')[0]!.items?.bsonType).toBe('int');
    });
});

describe('type search ranking and zoned types', () => {
    it('ranks an alias typed in full ahead of longer names that start with it', () => {
        expect(searchTypes(POSTGRES_TYPES, 'int4')[0]?.name).toBe('integer');
        expect(searchTypes(POSTGRES_TYPES, 'timestamptz')[0]?.name).toBe(
            'timestamp with time zone',
        );
        expect(searchTypes(POSTGRES_TYPES, 'integer')[0]?.name).toBe('integer');
    });

    it('writes the digits of a zoned type before the zone', () => {
        const sql = createTableSql(postgresDialect, {
            ...emptyDesign('events'),
            columns: [
                {
                    id: 'a',
                    name: 'at',
                    type: 'timestamp with time zone',
                    length: '3',
                    nullable: false,
                },
                {
                    id: 'b',
                    name: 'clock',
                    type: 'time with time zone',
                    length: '0',
                    nullable: true,
                },
                { id: 'c', name: 'plain', type: 'timestamp', length: '6', nullable: true },
            ],
        });
        expect(sql[0]).toContain('"at" timestamp(3) with time zone NOT NULL');
        expect(sql[0]).toContain('"clock" time(0) with time zone NULL');
        expect(sql[0]).toContain('"plain" timestamp(6) NULL');
    });
});
