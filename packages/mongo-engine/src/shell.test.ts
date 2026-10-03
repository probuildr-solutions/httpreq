// @vitest-environment node
/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { describe, expect, it } from 'vitest';
import { DbError } from '@httpreq/db-core';
import { encodeDocument, decodeDocument } from '@httpreq/db-protocol-mongo';
import { toShell, typeName } from './format';
import { parseRelaxed } from './relaxed';
import { parseStatement, splitShellStatements } from './shell';

const plan = (text: string, db = 'shop') => {
    const result = parseStatement(text, db);
    if (result.kind !== 'command') throw new Error('expected a command plan');
    return result;
};

describe('relaxed values', () => {
    it('reads JSON and the shell’s looser forms', () => {
        expect(parseRelaxed('{ a: 1, "b": [1, 2, 3], c: \'x\', d: null, e: true, }')).toEqual({
            a: 1,
            b: [1, 2, 3],
            c: 'x',
            d: null,
            e: true,
        });
        expect(parseRelaxed('{ /* c */ a: 1 // line\n }')).toEqual({ a: 1 });
        expect(parseRelaxed('{ $gt: 5, $in: [1,2] }')).toEqual({ $gt: 5, $in: [1, 2] });
        expect(parseRelaxed('[-1.5e2, 0x10, .5, Infinity, -Infinity]')).toEqual([
            -150,
            16,
            0.5,
            Infinity,
            -Infinity,
        ]);
        expect(parseRelaxed('"a\\nb\\u0041\\"q\\""')).toBe('a\nbA"q"');
    });

    it('reads the constructors', () => {
        expect(parseRelaxed('ObjectId("507F1F77BCF86CD799439011")')).toEqual({
            $type: 'objectId',
            $value: '507f1f77bcf86cd799439011',
        });
        expect(parseRelaxed('ISODate("2024-05-01T10:20:30Z")')).toEqual(
            new Date('2024-05-01T10:20:30Z'),
        );
        expect(parseRelaxed('new Date(1700000000000)')).toEqual(new Date(1700000000000));
        expect(parseRelaxed('NumberLong("9007199254740993")')).toEqual({
            $type: 'int64',
            $value: '9007199254740993',
        });
        expect(parseRelaxed('NumberInt(5)')).toEqual({ $type: 'int32', $value: '5' });
        expect(parseRelaxed('NumberDecimal("12.50")')).toEqual({
            $type: 'decimal128',
            $value: '12.50',
        });
        expect(parseRelaxed('UUID("123e4567-e89b-12d3-a456-426614174000")')).toEqual({
            $type: 'uuid',
            $value: '123e4567-e89b-12d3-a456-426614174000',
        });
        expect(parseRelaxed('Timestamp(10, 2)')).toEqual({ $type: 'timestamp', $value: '10:2' });
        expect(parseRelaxed('MinKey()')).toEqual({ $type: 'minKey', $value: '' });
        expect(parseRelaxed('/^ab[/]c/gi')).toEqual({ $type: 'regex', $value: '/^ab[/]c/gi' });
        expect((parseRelaxed('ObjectId()') as { $value: string }).$value).toMatch(/^[0-9a-f]{24}$/);
    });

    it('reads canonical Extended JSON, but leaves query operators alone', () => {
        expect(parseRelaxed('{"$oid": "507f1f77bcf86cd799439011"}')).toEqual({
            $type: 'objectId',
            $value: '507f1f77bcf86cd799439011',
        });
        expect(parseRelaxed('{"$date": "2024-01-01T00:00:00Z"}')).toEqual(
            new Date('2024-01-01T00:00:00Z'),
        );
        expect(parseRelaxed('{"$numberLong": "5"}')).toEqual({ $type: 'int64', $value: '5' });
        expect(parseRelaxed('{"$regularExpression": {"pattern": "a", "options": "i"}}')).toEqual({
            $type: 'regex',
            $value: '/a/i',
        });
        expect(parseRelaxed('{ $regex: "^a", $options: "i" }')).toEqual({
            $regex: '^a',
            $options: 'i',
        });
    });

    it('keeps integers beyond 2^53 exact', () => {
        expect(parseRelaxed('9007199254740993')).toBe(9007199254740993n);
    });

    it('refuses anything that is not a value, and never evaluates code', () => {
        for (const text of [
            'process.exit()',
            'function () {}',
            '(() => 1)()',
            'require("fs")',
            '{ a: bareword }',
            '{ a: 1 } trailing',
            '{ a: ',
            '[1, 2',
            '"open',
            'ObjectId("short")',
            'Evil("x")',
            '/open',
        ]) {
            expect(() => parseRelaxed(text), text).toThrow(DbError);
        }
        expect(() => parseRelaxed('{ a: ISODate("not a date") }')).toThrow(/not a valid date/);
    });

    it('points at the line and column of a mistake', () => {
        expect(() => parseRelaxed('{\n  a: 1,\n  b: @\n}')).toThrow(/line 3/);
    });

    it('limits nesting', () => {
        expect(() => parseRelaxed('['.repeat(200) + ']'.repeat(200))).toThrow(/too deeply/);
    });

    it('does not let __proto__ change a prototype', () => {
        const value = parseRelaxed('{ "__proto__": { polluted: true } }') as object;
        expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
        expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    });
});

describe('toShell', () => {
    it('writes what the parser reads back', () => {
        const value = {
            _id: { $type: 'objectId', $value: '507f1f77bcf86cd799439011' },
            name: 'Ada "the" Countess',
            when: new Date('2024-05-01T10:20:30.000Z'),
            nested: { list: [1, 2.5, null, true, { a: 'b' }] },
            'odd key': 1,
            big: 2n ** 62n,
            money: { $type: 'decimal128', $value: '1.50' },
            re: { $type: 'regex', $value: '/^a/i' },
        };
        expect(parseRelaxed(toShell(value))).toEqual({
            ...value,
            big: { $type: 'int64', $value: String(2n ** 62n) },
        });
    });

    it('names the types', () => {
        expect(typeName(1)).toBe('int');
        expect(typeName(1.5)).toBe('double');
        expect(typeName(null)).toBe('null');
        expect(typeName({ $type: 'objectId', $value: 'x'.repeat(24) })).toBe('objectId');
        expect(typeName([1])).toBe('array');
        expect(typeName({ a: 1 })).toBe('object');
        expect(typeName(new Date())).toBe('date');
    });
});

describe('statements', () => {
    it('plans find with its modifiers', () => {
        const p = plan(
            'db.orders.find({ total: { $gt: 100 } }, { _id: 0 }).sort({ total: -1 }).limit(5).skip(2)',
        );
        expect(p.database).toBe('shop');
        expect(p.shape).toBe('cursor');
        expect(p.command).toEqual({
            find: 'orders',
            filter: { total: { $gt: 100 } },
            projection: { _id: 0 },
            sort: { total: -1 },
            limit: 5,
            skip: 2,
        });
    });

    it('plans findOne as a single-batch find of one', () => {
        expect(plan('db.orders.findOne({ a: 1 })').command).toMatchObject({
            find: 'orders',
            limit: 1,
            singleBatch: true,
        });
    });

    it('takes getCollection for names that are not identifiers', () => {
        expect(plan('db.getCollection("my-orders").find({})').command).toMatchObject({
            find: 'my-orders',
        });
    });

    it('plans aggregate and counts', () => {
        expect(
            plan(
                'db.o.aggregate([{ $match: { a: 1 } }, { $group: { _id: "$b", n: { $sum: 1 } } }])',
            ).command,
        ).toMatchObject({ aggregate: 'o', cursor: {} });
        expect(plan('db.o.countDocuments({ a: 1 })').shape).toBe('count');
        expect(plan('db.o.estimatedDocumentCount()').command).toEqual({ count: 'o' });
        expect(plan('db.o.distinct("city", { a: 1 })')).toMatchObject({
            shape: 'values',
            command: { distinct: 'o', key: 'city', query: { a: 1 } },
        });
    });

    it('adds _id first when an inserted document has none, and reports the ids', () => {
        const p = plan('db.o.insertOne({ name: "x" })');
        const document = (p.command.documents as { _id: unknown; name: string }[])[0]!;
        expect(Object.keys(document)).toEqual(['_id', 'name']);
        expect(p.insertedIds).toHaveLength(1);
        const many = plan('db.o.insertMany([{ _id: 5 }, { a: 1 }], { ordered: false })');
        expect(many.command.ordered).toBe(false);
        expect(many.insertedIds![0]).toBe(5);
    });

    it('requires operators for updates and forbids them for replacements', () => {
        expect(() => parseStatement('db.o.updateOne({ a: 1 }, { b: 2 })', 'x')).toThrow(
            /update operators/,
        );
        expect(() =>
            parseStatement('db.o.updateOne({ a: 1 }, { $set: { b: 2 }, c: 3 })', 'x'),
        ).toThrow(/update operators/);
        expect(() => parseStatement('db.o.replaceOne({ a: 1 }, { $set: { b: 2 } })', 'x')).toThrow(
            /plain document/,
        );
        expect(
            plan('db.o.updateMany({ a: 1 }, { $set: { b: 2 } }, { upsert: true })').command,
        ).toMatchObject({
            update: 'o',
            updates: [{ q: { a: 1 }, u: { $set: { b: 2 } }, multi: true, upsert: true }],
        });
        expect(plan('db.o.updateOne({ a: 1 }, [{ $set: { b: "$a" } }])').write).toBe('update');
    });

    it('plans deletes with the right limit', () => {
        expect(plan('db.o.deleteOne({ a: 1 })').command).toMatchObject({
            deletes: [{ q: { a: 1 }, limit: 1 }],
        });
        expect(plan('db.o.deleteMany({})').command).toMatchObject({
            deletes: [{ q: {}, limit: 0 }],
        });
    });

    it('plans indexes with generated names', () => {
        expect(plan('db.o.createIndex({ a: 1, b: -1 }, { unique: true })').command).toMatchObject({
            createIndexes: 'o',
            indexes: [{ key: { a: 1, b: -1 }, name: 'a_1_b_-1', unique: true }],
        });
        expect(plan('db.o.dropIndex({ a: 1 })').command).toMatchObject({
            dropIndexes: 'o',
            index: 'a_1',
        });
        expect(plan('db.o.getIndexes()').command).toEqual({ listIndexes: 'o' });
    });

    it('wraps explain around a find', () => {
        expect(plan('db.o.explain("executionStats").find({ a: 1 })').command).toMatchObject({
            explain: { find: 'o' },
            verbosity: 'executionStats',
        });
        expect(() => parseStatement('db.o.explain().createIndex({a:1})', 'x')).toThrow(
            /cannot be explained/,
        );
    });

    it('handles use, show and database methods', () => {
        expect(parseStatement('use inventory', 'shop')).toEqual({
            kind: 'use',
            database: 'inventory',
        });
        expect(plan('show dbs').database).toBe('admin');
        expect(plan('show collections', 'shop').command).toMatchObject({ listCollections: 1 });
        expect(plan('db.runCommand({ ping: 1 })').command).toEqual({ ping: 1 });
        expect(plan('db.adminCommand("listDatabases")').database).toBe('admin');
        expect(plan('db.stats()').command).toEqual({ dbStats: 1 });
        expect(plan('db.getCollectionNames()').shape).toBe('values');
        expect(plan('db.createCollection("c", { capped: true, size: 1000 })').command).toEqual({
            create: 'c',
            capped: true,
            size: 1000,
        });
    });

    it('accepts comments, semicolons and line breaks inside a statement', () => {
        expect(plan('// find them\ndb.o\n  .find({ a: 1 })\n  .limit(3);').command).toMatchObject({
            find: 'o',
            limit: 3,
        });
    });

    it('gives a useful message for what it cannot do', () => {
        expect(() => parseStatement('SELECT 1', 'x')).toThrow(/starts with db\./);
        expect(() => parseStatement('db.o.frobnicate()', 'x')).toThrow(/not supported/);
        expect(() => parseStatement('db.o.find({a:1}).nonsense()', 'x')).toThrow(
            /cannot follow find/,
        );
        expect(() => parseStatement('db.o.find', 'x')).toThrow(/must be called/);
        expect(() => parseStatement('db.o.find({a:1}) extra', 'x')).toThrow(/Unexpected text/);
        expect(() => parseStatement('show roles', 'x')).toThrow(/not supported/);
        expect(() => parseStatement('', 'x')).toThrow(/nothing to run/);
        expect(() => parseStatement('db.o.find(5)', 'x')).toThrow(/must be a document/);
    });

    it('survives hostile input without a stray exception', () => {
        const hostile = [
            'db.',
            'db..find()',
            'db.o.find(',
            'db.o.find({',
            'db.o.find({a:})',
            'db.getCollection(5).find()',
            'db.o.find({a: ObjectId()}).limit(-1)',
            'db.o.find().limit("x")',
            '\u0000',
            'db.o.find({a:1})'.repeat(100),
        ];
        for (const text of hostile) {
            try {
                parseStatement(text, 'x');
            } catch (error) {
                expect(error, text).toBeInstanceOf(DbError);
            }
        }
    });

    it('produces commands the BSON encoder accepts', () => {
        const p = plan(
            'db.o.insertOne({ when: ISODate("2024-01-01"), n: NumberLong(5), d: NumberDecimal("1.5"), r: /x/i, id: UUID("123e4567-e89b-12d3-a456-426614174000") })',
        );
        const bytes = encodeDocument(p.command);
        expect((decodeDocument(bytes).value.documents as unknown[]).length).toBe(1);
    });
});

describe('splitShellStatements', () => {
    it('splits on semicolons and on line breaks outside brackets', () => {
        const texts = (input: string) => splitShellStatements(input).map((s) => s.sql);
        expect(texts('use shop\ndb.a.find({})\ndb.b.find({})')).toEqual([
            'use shop',
            'db.a.find({})',
            'db.b.find({})',
        ]);
        expect(texts('db.a.find({}); db.b.find({});')).toEqual(['db.a.find({})', 'db.b.find({})']);
    });

    it('keeps a statement that spans lines together', () => {
        const parts = splitShellStatements(
            'db.orders.aggregate([\n  { $match: { a: 1 } },\n  { $group: { _id: "$b" } }\n])\n\ndb.x.find({})',
        );
        expect(parts).toHaveLength(2);
        expect(parts[0]!.sql).toContain('$group');
    });

    it('keeps a chain that continues on the next line', () => {
        expect(splitShellStatements('db.o.find({})\n  .sort({ a: 1 })\n  .limit(5)')).toHaveLength(
            1,
        );
    });

    it('ignores semicolons and brackets inside strings and comments', () => {
        expect(
            splitShellStatements('db.o.find({ a: "x;y)" }) // end; not\ndb.p.find({})'),
        ).toHaveLength(2);
        expect(splitShellStatements('// just a comment\n/* another */')).toEqual([]);
    });

    it('reports where each statement is', () => {
        const text = 'use a\n  db.b.find({})';
        const [first, second] = splitShellStatements(text);
        expect(text.slice(first!.start, first!.end)).toBe('use a');
        expect(text.slice(second!.start, second!.end)).toBe('db.b.find({})');
    });
});

describe('asDocuments', () => {
    it('asks for whole documents and still sends a plain find', () => {
        const plan = parseStatement(
            'db.orders.find({ a: 1 }).sort({ a: -1 }).limit(5).asDocuments()',
            'shop',
        );
        expect(plan).toMatchObject({
            kind: 'command',
            documents: true,
            command: { find: 'orders', filter: { a: 1 }, sort: { a: -1 }, limit: 5 },
        });
        // nothing extra reaches the server
        expect(Object.keys((plan as { command: object }).command)).not.toContain('asDocuments');
        expect(parseStatement('db.orders.find({})', 'shop')).not.toHaveProperty('documents', true);
    });
});

describe('getSiblingDB', () => {
    it('runs on the named database without changing the current one', () => {
        const plan = parseStatement('db.getSiblingDB("other").getCollection("c").find({})', 'shop');
        expect(plan).toMatchObject({ kind: 'command', database: 'other', command: { find: 'c' } });
        expect(
            parseStatement('db.getSiblingDB("other").c.countDocuments({})', 'shop'),
        ).toMatchObject({ database: 'other' });
    });
});
