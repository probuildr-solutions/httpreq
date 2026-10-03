/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { describe, expect, it } from 'vitest';
import { layoutOf, quoteName, startOfQuery, statementsToOpen } from './engines';
import { buildRows, loadsFor, metaKey, rowKey, type MetaEntry } from './explorerRows';
import { newProfileId, type ConnectionProfile } from './profiles';

const profileFor = (engine: string, extra: Record<string, unknown> = {}): ConnectionProfile => ({
    id: newProfileId(),
    name: 'Server',
    settings: { engine, host: 'h', port: 1, tls: { mode: 'prefer' }, ...extra },
    group: '',
    favorite: false,
    lastUsed: null,
});

const connectedFor = (p: ConnectionProfile) => ({
    [p.id]: { id: p.id, state: 'connected' as const, reconnects: 0 },
});

const ready = (items: unknown[]): MetaEntry => ({ state: 'ready', items });

describe('engine layouts', () => {
    it('puts schemas between a PostgreSQL database and its tables', () => {
        const p = profileFor('postgresql', { database: 'shop', username: 'me' });
        const expanded = new Set([
            rowKey('c', p.id),
            rowKey('d', p.id, 'shop'),
            rowKey('s', p.id, 'shop', 'public'),
            rowKey('g', p.id, 'shop', 'public', 'tables'),
        ]);
        const cache = {
            [metaKey(p.id, 'databases')]: ready([
                { name: 'shop', system: false },
                { name: 'other', system: false },
            ]),
            [metaKey(p.id, 'schemas', 'shop')]: ready([
                { name: 'pg_catalog', system: true },
                { name: 'public', system: false },
            ]),
            [metaKey(p.id, 'tables', 'shop', '', 'public')]: ready([
                { name: 'orders', kind: 'table', rows: 5 },
                { name: 'v', kind: 'view' },
                { name: 'mv', kind: 'materialized view' },
            ]),
        };
        const rows = buildRows([p], connectedFor(p), cache, expanded);
        expect(rows.filter((r) => r.kind === 'schema').map((r) => r.label)).toEqual([
            'public',
            'pg_catalog',
        ]);
        expect(rows.find((r) => r.label === 'orders')).toMatchObject({
            depth: 4,
            schema: 'public',
            database: 'shop',
            engine: 'postgresql',
        });
        expect(rows.find((r) => r.label === 'other')!.detail).toBe('browse only');
        expect(rows.find((r) => r.label === 'shop')!.detail).toBeUndefined();
        // Views and materialized views share a group.
        const views = buildRows(
            [p],
            connectedFor(p),
            cache,
            new Set([...expanded, rowKey('g', p.id, 'shop', 'public', 'views')]),
        );
        expect(views.filter((r) => r.kind === 'view').map((r) => r.label)).toEqual(['v', 'mv']);
    });

    it('loads schemas when a PostgreSQL database opens, and tables with the schema', () => {
        const p = profileFor('postgresql');
        const row = buildRows([p], connectedFor(p), {}, new Set())[0]!;
        expect(loadsFor({ ...row, kind: 'database', database: 'shop' })).toEqual([
            { kind: 'schemas', database: 'shop' },
        ]);
        expect(
            loadsFor({
                ...row,
                kind: 'group',
                object: 'tables',
                database: 'shop',
                schema: 'public',
            }),
        ).toEqual([{ kind: 'tables', database: 'shop', schema: 'public' }]);
        expect(
            loadsFor({
                ...row,
                kind: 'table',
                database: 'shop',
                schema: 'public',
                table: 'orders',
            }),
        ).toEqual([
            { kind: 'columns', database: 'shop', table: 'orders', schema: 'public' },
            { kind: 'indexes', database: 'shop', table: 'orders', schema: 'public' },
        ]);
    });

    it('shows MongoDB collections with their fields, and no schema level', () => {
        const p = profileFor('mongodb');
        const expanded = new Set([
            rowKey('c', p.id),
            rowKey('d', p.id, 'shop'),
            rowKey('g', p.id, 'shop', undefined, 'tables'),
            rowKey('t', p.id, 'shop', undefined, 'people'),
        ]);
        const cache = {
            [metaKey(p.id, 'databases')]: ready([{ name: 'shop', system: false }]),
            [metaKey(p.id, 'tables', 'shop')]: ready([{ name: 'people', kind: 'table', rows: 3 }]),
            [metaKey(p.id, 'columns', 'shop', 'people')]: ready([
                { name: '_id', type: 'objectId', nullable: false, primaryKey: true },
            ]),
            [metaKey(p.id, 'indexes', 'shop', 'people')]: ready([
                { name: '_id_', columns: ['_id'], unique: true },
            ]),
        };
        const rows = buildRows([p], connectedFor(p), cache, expanded);
        expect(rows.find((r) => r.kind === 'group')!.label).toBe('Collections');
        expect(rows.map((r) => r.kind)).toEqual([
            'connection',
            'database',
            'group',
            'table',
            'column',
            'index',
            'group',
        ]);
    });

    it('shows Redis keys as a flat list with their types, and a note for the cut-off', () => {
        const p = profileFor('redis');
        const expanded = new Set([
            rowKey('c', p.id),
            rowKey('d', p.id, 'db0'),
            rowKey('g', p.id, 'db0', undefined, 'tables'),
        ]);
        const cache = {
            [metaKey(p.id, 'databases')]: ready([{ name: 'db0', system: false }]),
            [metaKey(p.id, 'tables', 'db0')]: ready([
                { name: 'user:1', kind: 'hash' },
                { name: 'queue', kind: 'list' },
                { name: '… more keys than the first 5,000', kind: 'note' },
            ]),
        };
        const rows = buildRows([p], connectedFor(p), cache, expanded);
        const keys = rows.filter((r) => r.kind === 'table');
        expect(keys.map((r) => [r.label, r.detail, r.expandable])).toEqual([
            ['user:1', 'hash', false],
            ['queue', 'list', false],
        ]);
        expect(rows.at(-1)).toMatchObject({
            kind: 'message',
            label: '… more keys than the first 5,000',
        });
        expect(rows.find((r) => r.kind === 'group')!.label).toBe('Keys');
        // A key with a colon does not confuse the keys of the tree.
        expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
    });

    it('tells each engine how to name things and what to start with', () => {
        expect(quoteName('mysql', 'a`b')).toBe('`a``b`');
        expect(quoteName('postgresql', 'a"b')).toBe('"a""b"');
        expect(quoteName('mongodb', 'a"b')).toBe(JSON.stringify('a"b'));
        expect(quoteName('redis', 'user:1')).toBe('user:1');
        expect(quoteName('redis', 'two words')).toBe('"two words"');
        expect(startOfQuery('mysql', 'shop')).toBe('USE `shop`;\n');
        expect(startOfQuery('mongodb', 'shop')).toBe('use shop\n');
        expect(startOfQuery('redis', 'db3')).toBe('SELECT 3\n');
        expect(startOfQuery('postgresql', 'shop')).toBe('');
        expect(layoutOf('unknown').language).toBe('mysql');
    });

    it('writes the statements that show an object', () => {
        expect(statementsToOpen('mysql', { database: 'shop', name: 'orders', kind: 'table' })).toBe(
            'SELECT *\nFROM `shop`.`orders`\nLIMIT 1000;',
        );
        expect(
            statementsToOpen('postgresql', {
                database: 'shop',
                schema: 'sales',
                name: 'o"x',
                kind: 'table',
            }),
        ).toBe('SELECT *\nFROM "sales"."o""x"\nLIMIT 1000;');
        expect(
            statementsToOpen('mongodb', { database: 'shop', name: 'people', kind: 'table' }),
        ).toBe('use shop\ndb.getCollection("people").find({}).limit(100)');
        const redis = (kind: string) =>
            statementsToOpen('redis', { database: 'db2', name: 'k', kind });
        expect(redis('string')).toBe('SELECT 2\nGET k');
        expect(redis('hash')).toBe('SELECT 2\nHGETALL k');
        expect(redis('list')).toBe('SELECT 2\nLRANGE k 0 99');
        expect(redis('set')).toBe('SELECT 2\nSMEMBERS k');
        expect(redis('zset')).toBe('SELECT 2\nZRANGE k 0 99 WITHSCORES');
        expect(redis('stream')).toBe('SELECT 2\nXRANGE k - + COUNT 100');
    });
});
