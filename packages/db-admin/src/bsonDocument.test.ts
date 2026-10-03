/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { describe, expect, it } from 'vitest';
import {
    addEntry,
    createCollectionStatement,
    diffDocument,
    fromDbValue,
    updateDocumentStatement,
    createIndexStatement,
    findStatement,
    formatNode,
    idOf,
    nodeAt,
    parseDocument,
    parseScalar,
    removeEntry,
    renameField,
    replaceDocumentStatement,
    setValue,
    toExtendedJson,
    type BsonNode,
} from './index';

const parse = (text: string): BsonNode => {
    const result = parseDocument(text);
    if (!result.ok) throw new Error(`${result.error} at ${result.position}`);
    return result.node;
};

describe('BSON documents', () => {
    it('keeps the type of every value across a read and a write', () => {
        const text = `{
  _id: ObjectId("507f1f77bcf86cd799439011"),
  name: "Ada",
  age: 36,
  big: NumberLong("9007199254740993"),
  ratio: 0.5,
  price: NumberDecimal("19.99"),
  when: ISODate("2026-01-31T12:00:00.000Z"),
  active: true,
  nothing: null,
  tags: ["a", "b"],
  nested: { deep: { x: 1 } },
  id2: UUID("123e4567-e89b-12d3-a456-426614174000"),
  pattern: /^a.*z$/i
}`;
        const node = parse(text);
        expect(nodeAt(node, ['_id'])).toEqual({ t: 'objectId', v: '507f1f77bcf86cd799439011' });
        expect(nodeAt(node, ['age'])).toEqual({ t: 'int32', v: '36' });
        expect(nodeAt(node, ['big'])).toEqual({ t: 'int64', v: '9007199254740993' });
        expect(nodeAt(node, ['ratio'])).toEqual({ t: 'double', v: '0.5' });
        expect(nodeAt(node, ['when'])).toEqual({ t: 'date', v: '2026-01-31T12:00:00.000Z' });
        expect(nodeAt(node, ['tags', 1])).toEqual({ t: 'string', v: 'b' });
        expect(nodeAt(node, ['nested', 'deep', 'x'])).toEqual({ t: 'int32', v: '1' });
        // writing it and reading it again gives the same document
        expect(parse(formatNode(node))).toEqual(node);
    });

    it('reads JSON, comments, trailing commas and extended JSON', () => {
        const node = parse(
            `{ "a": {"$oid": "507f1f77bcf86cd799439011"}, b: {"$date": "2020-01-01T00:00:00Z"}, c: {"$numberLong": "5"}, /* note */ d: [1, 2,], }`,
        );
        expect(nodeAt(node, ['a'])?.t).toBe('objectId');
        expect(nodeAt(node, ['b'])?.t).toBe('date');
        expect(nodeAt(node, ['c'])).toEqual({ t: 'int64', v: '5' });
        expect(nodeAt(node, ['d', 1])).toEqual({ t: 'int32', v: '2' });
    });

    it('reports where a document is wrong', () => {
        const result = parseDocument('{ a: 1, b: oops }');
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error).toMatch(/not a value/);
            expect(result.position).toBe(11);
        }
        expect(parseDocument('{ a: ObjectId("zz") }').ok).toBe(false);
        expect(parseDocument('{ a: 1 } extra').ok).toBe(false);
        expect(parseDocument('{ a: NumberInt("3000000000") }').ok).toBe(false);
    });

    it('never runs code', () => {
        expect(parseDocument('{ a: process.exit() }').ok).toBe(false);
        expect(parseDocument('{ a: function() { return 1 } }').ok).toBe(false);
    });

    it('edits fields, nested objects and arrays without touching the original', () => {
        const original = parse('{ a: 1, tags: ["x"], n: { k: 1 } }');
        let node = setValue(original, ['a'], { t: 'string', v: 'one' });
        node = addEntry(node, ['tags'], '', { t: 'string', v: 'y' }) as BsonNode;
        node = addEntry(node, ['n'], 'j', { t: 'bool', v: true }) as BsonNode;
        node = removeEntry(node, ['n', 'k']);
        node = renameField(node, ['a'], 'b') as BsonNode;
        expect(toExtendedJson(node)).toEqual({ b: 'one', tags: ['x', 'y'], n: { j: true } });
        expect(toExtendedJson(original)).toEqual({
            a: { $numberInt: '1' },
            tags: ['x'],
            n: { k: { $numberInt: '1' } },
        });
        expect(addEntry(node, [], 'b', { t: 'null' })).toEqual({
            error: 'The field “b” already exists.',
        });
        expect(renameField(node, ['tags'], 'b')).toEqual({
            error: 'The field “b” already exists.',
        });
    });

    it('validates typed input', () => {
        expect(parseScalar('int32', '3000000000').ok).toBe(false);
        expect(parseScalar('int64', '3000000000')).toEqual({
            ok: true,
            node: { t: 'int64', v: '3000000000' },
        });
        expect(parseScalar('objectId', 'nope').ok).toBe(false);
        expect(parseScalar('date', 'not a date').ok).toBe(false);
        expect(parseScalar('bool', 'true')).toEqual({ ok: true, node: { t: 'bool', v: true } });
        expect(parseScalar('string', ' keep spaces ')).toEqual({
            ok: true,
            node: { t: 'string', v: ' keep spaces ' },
        });
    });

    it('finds the id to address a document by', () => {
        expect(idOf(parse('{ _id: ObjectId("507f1f77bcf86cd799439011"), a: 1 }'))).toBe(
            'ObjectId("507f1f77bcf86cd799439011")',
        );
        expect(idOf(parse('{ a: 1 }'))).toBeNull();
    });
});

describe('MongoDB statements', () => {
    it('builds finds, with the database to use', () => {
        expect(
            findStatement('shop', 'orders', {
                filter: '{ total: { $gt: 5 } }',
                sort: '{ total: -1 }',
                skip: 20,
                limit: 10,
            }),
        ).toBe(
            'db.getSiblingDB("shop").getCollection("orders").find({ total: { $gt: 5 } }).sort({ total: -1 }).skip(20).limit(10)',
        );
        expect(findStatement(undefined, 'a"b')).toBe('db.getCollection("a\\"b").find({})');
    });

    it('addresses a document by its id', () => {
        expect(
            replaceDocumentStatement('d', 'c', 'ObjectId("507f1f77bcf86cd799439011")', '{ a: 2 }'),
        ).toBe(
            'db.getSiblingDB("d").getCollection("c").replaceOne({ _id: ObjectId("507f1f77bcf86cd799439011") }, { a: 2 })',
        );
    });

    it('creates collections with validation and indexes with options', () => {
        expect(
            createCollectionStatement(undefined, 'c', {
                validator: '{ $jsonSchema: {} }',
                validationLevel: 'strict',
                validationAction: 'error',
            }),
        ).toBe(
            'db.createCollection("c", { validator: { $jsonSchema: {} }, validationLevel: "strict", validationAction: "error" })',
        );
        expect(
            createIndexStatement(undefined, 'c', {
                keys: '{ email: 1 }',
                unique: true,
                expireAfterSeconds: 60,
            }),
        ).toBe(
            'db.getCollection("c").createIndex({ email: 1 }, { unique: true, expireAfterSeconds: 60 })',
        );
    });
});

describe('saving only what changed', () => {
    const base =
        '{ _id: ObjectId("507f1f77bcf86cd799439011"), name: "Ada", n: { a: 1, b: 2 }, tags: ["x", "y"], gone: 1 }';

    it('lists changed, added and removed fields, and leaves the rest alone', () => {
        const edited =
            '{ _id: ObjectId("507f1f77bcf86cd799439011"), n: { a: 5, b: 2, c: true }, name: "Ada", tags: ["x", "y", "z"] }';
        const result = diffDocument(parse(base), parse(edited));
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.set.map((s) => s.path).sort()).toEqual(['n.a', 'n.c', 'tags']);
        expect(result.unset).toEqual(['gone']);
        const statement = updateDocumentStatement(
            'shop',
            'people',
            'ObjectId("507f1f77bcf86cd799439011")',
            result,
        );
        expect(statement).toBe(
            'db.getSiblingDB("shop").getCollection("people").updateOne({ _id: ObjectId("507f1f77bcf86cd799439011") }, { $set: { "n.a": 5, "n.c": true, "tags": [ "x", "y", "z" ] }, $unset: { "gone": "" } })',
        );
    });

    it('finds nothing to save when only the order of fields differs', () => {
        const result = diffDocument(
            parse('{ _id: 1, a: 1, b: 2 }'),
            parse('{ b: 2, a: 1, _id: 1 }'),
        );
        expect(result).toEqual({ ok: true, set: [], unset: [] });
    });

    it('keeps a changed type as a change', () => {
        const result = diffDocument(
            parse('{ _id: 1, a: 1 }'),
            parse('{ _id: 1, a: NumberLong("1") }'),
        );
        expect(result.ok && result.set).toEqual([{ path: 'a', value: { t: 'int64', v: '1' } }]);
    });

    it('refuses to change _id, and names that cannot be paths', () => {
        expect(diffDocument(parse('{ _id: 1 }'), parse('{ _id: 2 }'))).toEqual({
            ok: false,
            error: 'The _id of a document cannot be changed.',
        });
        expect(diffDocument(parse('{ _id: 1 }'), parse('{ _id: 1, "a.b": 1 }')).ok).toBe(false);
    });
});

describe('reading documents from the host', () => {
    it('keeps the types the host reports', () => {
        const node = fromDbValue({
            _id: { $type: 'objectId', $value: '507f1f77bcf86cd799439011' },
            n: 5,
            big: 9007199254740991,
            f: 1.5,
            l: 10n ** 15n,
            when: new Date(Date.UTC(2026, 0, 1)),
            list: [1, { $type: 'decimal128', $value: '1.5' }],
            re: { $type: 'regex', $value: '/a.b/i' },
            bin: new Uint8Array([1, 2, 3]),
            tagged: { $type: 'binary:5', $value: 'AQID' },
            nothing: null,
        });
        expect(nodeAt(node, ['_id'])).toEqual({ t: 'objectId', v: '507f1f77bcf86cd799439011' });
        expect(nodeAt(node, ['n'])).toEqual({ t: 'int32', v: '5' });
        expect(nodeAt(node, ['big'])).toEqual({ t: 'int64', v: '9007199254740991' });
        expect(nodeAt(node, ['f'])).toEqual({ t: 'double', v: '1.5' });
        expect(nodeAt(node, ['l'])).toEqual({ t: 'int64', v: '1000000000000000' });
        expect(nodeAt(node, ['when'])).toEqual({ t: 'date', v: '2026-01-01T00:00:00.000Z' });
        expect(nodeAt(node, ['list', 1])).toEqual({ t: 'decimal128', v: '1.5' });
        expect(nodeAt(node, ['re'])).toEqual({ t: 'regex', pattern: 'a.b', flags: 'i' });
        expect(nodeAt(node, ['bin'])).toEqual({ t: 'binary', v: 'AQID', subtype: 0 });
        expect(nodeAt(node, ['tagged'])).toEqual({ t: 'binary', v: 'AQID', subtype: 5 });
        // what is shown can be read back as the same document
        expect(parse(formatNode(node))).toEqual(node);
    });
});
