/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { formatCell } from './cells';
import { buildRows, loadsFor, metaKey, rowKey, type MetaEntry } from './explorerRows';
import { newProfileId, parseProfiles, type ConnectionProfile } from './profiles';
import { MAX_HISTORY, redactForHistory, resetHistory, useHistory } from './queryStore';

const profile = (id = newProfileId()): ConnectionProfile => ({
    id,
    name: 'Local',
    settings: { engine: 'mysql', host: '127.0.0.1', port: 3306, tls: { mode: 'prefer' } },
    group: '',
    favorite: false,
    lastUsed: null,
});

describe('parseProfiles', () => {
    it('keeps valid profiles and drops damaged ones', () => {
        const good = profile();
        const raw = JSON.stringify([
            good,
            { ...good, id: 'not-hex' },
            { ...good, id: newProfileId(), settings: { ...good.settings, port: 70_000 } },
            null,
            'x',
        ]);
        expect(parseProfiles(raw).map((p) => p.id)).toEqual([good.id]);
    });

    it('never carries a password field through', () => {
        const good = profile();
        const withSecret = { ...good, settings: { ...good.settings, password: 'hunter2' } };
        const [parsed] = parseProfiles(JSON.stringify([withSecret]));
        expect(JSON.stringify(parsed)).not.toContain('hunter2');
    });

    it('drops duplicate ids and survives garbage', () => {
        const good = profile();
        expect(parseProfiles(JSON.stringify([good, good]))).toHaveLength(1);
        expect(parseProfiles('{not json')).toEqual([]);
        expect(parseProfiles(null)).toEqual([]);
    });
});

describe('buildRows', () => {
    const p = profile('aaaaaaaaaaaaaaaa');
    const connected = { [p.id]: { id: p.id, state: 'connected' as const, reconnects: 0 } };
    const ready = (items: unknown[]): MetaEntry => ({ state: 'ready', items });

    it('shows a disconnected connection as a single, unexpandable row', () => {
        const rows = buildRows([p], {}, {}, new Set());
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            kind: 'connection',
            expandable: false,
            status: 'disconnected',
        });
    });

    it('lists user databases before system ones, with a loading row until they arrive', () => {
        const expanded = new Set([rowKey('c', p.id)]);
        expect(buildRows([p], connected, {}, expanded).at(-1)).toMatchObject({
            kind: 'message',
            loading: true,
        });
        const cache = {
            [metaKey(p.id, 'databases')]: ready([
                { name: 'mysql', system: true },
                { name: 'shop', system: false },
            ]),
        };
        const rows = buildRows([p], connected, cache, expanded);
        expect(rows.filter((r) => r.kind === 'database').map((r) => r.label)).toEqual([
            'shop',
            'mysql',
        ]);
    });

    it('shows tables with columns once expanded and filters by name', () => {
        const expanded = new Set([
            rowKey('c', p.id),
            rowKey('d', p.id, 'shop'),
            rowKey('g', p.id, 'shop', undefined, 'tables'),
            rowKey('t', p.id, 'shop', undefined, 'orders'),
        ]);
        const cache = {
            [metaKey(p.id, 'databases')]: ready([{ name: 'shop', system: false }]),
            [metaKey(p.id, 'tables', 'shop')]: ready([
                { name: 'orders', kind: 'table', rows: 1200 },
                { name: 'users', kind: 'table' },
                { name: 'v_sales', kind: 'view' },
            ]),
            [metaKey(p.id, 'columns', 'shop', 'orders')]: ready([
                { name: 'id', type: 'int', nullable: false, primaryKey: true },
            ]),
            [metaKey(p.id, 'indexes', 'shop', 'orders')]: ready([]),
        };
        const rows = buildRows([p], connected, cache, expanded);
        const labels = rows.map((r) => r.label);
        expect(labels).toContain('orders');
        expect(labels).toContain('id');
        expect(labels).not.toContain('v_sales'); // the Views group is collapsed
        expect(rows.find((r) => r.label === 'orders')?.detail).toBe('1,200 rows');
        expect(
            buildRows([p], connected, cache, expanded, 'ord')
                .filter((r) => r.kind === 'table')
                .map((r) => r.label),
        ).toEqual(['orders']);
    });

    it('says what each row needs loaded', () => {
        const row = buildRows([p], connected, {}, new Set())[0]!;
        expect(loadsFor(row)).toEqual([{ kind: 'databases' }]);
        expect(loadsFor({ ...row, kind: 'group', object: 'views', database: 'shop' })).toEqual([
            { kind: 'tables', database: 'shop', schema: undefined },
        ]);
    });
});

describe('history', () => {
    beforeEach(() => {
        localStorage.clear();
        resetHistory();
    });

    it('hides statements that carry a password', () => {
        expect(redactForHistory("CREATE USER 'a' IDENTIFIED BY 'secret'")).not.toContain('secret');
        expect(redactForHistory("ALTER USER a SET PASSWORD = 'x'")).not.toContain("'x'");
        expect(redactForHistory('SELECT 1')).toBe('SELECT 1');
    });

    it('records newest first, caps its length and can be cleared per connection', () => {
        const { add } = useHistory.getState();
        for (let i = 0; i < MAX_HISTORY + 5; i++) {
            add({
                profileId: i % 2 ? 'b' : 'a',
                sql: `SELECT ${i}`,
                at: i,
                elapsedMs: 1,
                state: 'done',
            });
        }
        const entries = useHistory.getState().entries;
        expect(entries).toHaveLength(MAX_HISTORY);
        expect(entries[0]!.sql).toBe(`SELECT ${MAX_HISTORY + 4}`);
        useHistory.getState().clear('a');
        expect(useHistory.getState().entries.every((e) => e.profileId === 'b')).toBe(true);
    });

    it('records nothing while turned off', () => {
        useHistory.getState().setEnabled(false);
        useHistory
            .getState()
            .add({ profileId: 'a', sql: 'SELECT 1', at: 1, elapsedMs: 1, state: 'done' });
        expect(useHistory.getState().entries).toHaveLength(0);
    });
});

describe('formatCell', () => {
    it('renders each kind of value', () => {
        expect(formatCell(null)).toBe('NULL');
        expect(formatCell(10n ** 20n)).toBe('100000000000000000000');
        expect(formatCell(new Date('2024-05-01T10:20:30.000Z'))).toBe('2024-05-01 10:20:30');
        expect(formatCell(new Uint8Array([1, 2, 255]))).toBe('0x0102ff');
        expect(formatCell({ $type: 'decimal', $value: '1.50' })).toBe('1.50');
        expect(formatCell({ a: 1 })).toBe('{ a: 1 }');
        expect(formatCell({ $type: 'objectId', $value: 'abc' })).toBe('ObjectId("abc")');
        expect(formatCell({ id: { $type: 'objectId', $value: 'abc' }, tags: ['x', 1] })).toBe(
            '{ id: ObjectId("abc"), tags: ["x", 1] }',
        );
    });
});
