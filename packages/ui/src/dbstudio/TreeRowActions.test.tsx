/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Menu } from '../kit';
import { ConnectionsSection } from './db/ConnectionsSection';
import { buildRows, loadsFor, metaKey, type MetaEntry } from './db/explorerRows';
import { useProfiles, type ConnectionProfile } from './db/profiles';
import { resetLive, useLive } from './db/queryStore';
import { DbManagerContext, type DbManagerApi } from './db/useDbManager';
import { TREE_ROW_HEIGHT, TreeRowActions, TreeRowMenuButton } from './TreeRowActions';

afterEach(cleanup);

describe('TreeRowActions', () => {
    it('is a fixed 24px slot that centres its content on both axes', () => {
        render(
            <TreeRowActions>
                <TreeRowMenuButton aria-label="Actions for orders" />
            </TreeRowActions>,
        );
        const button = screen.getByRole('button', { name: 'Actions for orders' });
        const slot = button.parentElement!;
        expect(slot.hasAttribute('data-tree-actions')).toBe(true);
        for (const name of ['size-6', 'flex', 'items-center', 'justify-center', 'flex-none']) {
            expect(slot.className.split(/\s+/)).toContain(name);
        }
        // The slot is a flex box, not a line of text: no baseline offset can push the icon.
        expect(slot.tagName).toBe('SPAN');
        expect(slot.className).not.toMatch(/\binline\b/);
    });

    it('has a usable hit area with a smaller icon, and the same size in every state', () => {
        render(
            <TreeRowActions>
                <TreeRowMenuButton aria-label="Actions" />
            </TreeRowActions>,
        );
        const button = screen.getByRole('button', { name: 'Actions' });
        expect(button.className.split(/\s+/)).toContain('size-6');
        expect(button.querySelector('svg')?.getAttribute('width')).toBe('14');
        // Hover, focus and open states change colour and opacity only, never size or spacing.
        const states = [
            ...button.className.split(/\s+/),
            ...button.parentElement!.className.split(/\s+/),
        ].filter((c) => /^(hover:|group-hover:|focus|aria-expanded:|has-)/.test(c));
        expect(states.length).toBeGreaterThan(0);
        for (const state of states) expect(state).not.toMatch(/:(size|h|w|p[xytblr]?|m[xytblr]?)-/);
    });

    it('stays visible while its menu is open or it has focus', () => {
        render(
            <TreeRowActions>
                <TreeRowMenuButton aria-label="Actions" />
            </TreeRowActions>,
        );
        const slot = screen.getByRole('button').parentElement!;
        expect(slot.className).toMatch(/opacity-0/);
        expect(slot.className).toMatch(/focus-within:opacity-100/);
        expect(slot.className).toMatch(/has-\[\[aria-expanded=true\]\]:opacity-100/);
        expect(slot.className).toMatch(/group-hover:opacity-100/);
    });

    it('works as a menu target: opens its menu and reports the open state', () => {
        render(
            <TreeRowActions>
                <Menu>
                    <Menu.Target>
                        <TreeRowMenuButton aria-label="Actions" />
                    </Menu.Target>
                    <Menu.Dropdown>
                        <Menu.Item>Refresh</Menu.Item>
                    </Menu.Dropdown>
                </Menu>
            </TreeRowActions>,
        );
        const button = screen.getByRole('button', { name: 'Actions' });
        fireEvent.click(button);
        expect(screen.getByRole('menuitem', { name: 'Refresh' })).toBeTruthy();
        expect(button.getAttribute('aria-expanded')).toBe('true');
    });
});

describe('every level of the explorer tree', () => {
    const profile: ConnectionProfile = {
        id: 'a'.padEnd(16, '0'),
        name: 'Local',
        settings: { engine: 'mysql', host: 'h', port: 3306, tls: { mode: 'prefer' } },
        group: '',
        favorite: false,
        lastUsed: null,
    };
    const status = { [profile.id]: { id: profile.id, state: 'connected' as const, reconnects: 0 } };
    const fixtures: Record<string, unknown[]> = {
        databases: [{ name: 'shop', system: false }],
        tables: [
            { name: 'orders', kind: 'table', rows: 5 },
            { name: 'v_sales', kind: 'view' },
        ],
        columns: [{ name: 'id', type: 'int', nullable: false, primaryKey: true }],
        indexes: [{ name: 'PRIMARY', columns: ['id'], unique: true, primary: true }],
        routines: [
            { name: 'fn', kind: 'function' },
            { name: 'proc', kind: 'procedure' },
        ],
        triggers: [{ name: 'trg', table: 'orders', timing: 'BEFORE', event: 'INSERT' }],
        events: [{ name: 'ev', status: 'ENABLED', schedule: 'EVERY 1 DAY' }],
    };

    /** Expands everything, loading each list from the fixtures, until nothing new opens. */
    const populate = () => {
        const meta: Record<string, MetaEntry> = {};
        const expanded = new Set<string>();
        for (let round = 0; round < 8; round++) {
            const rows = buildRows([profile], status, meta, expanded);
            let changed = false;
            for (const row of rows) {
                if (!row.expandable) continue;
                if (!expanded.has(row.key)) {
                    expanded.add(row.key);
                    changed = true;
                }
                for (const load of loadsFor({ ...row, expanded: true })) {
                    const key = metaKey(
                        profile.id,
                        load.kind,
                        load.database,
                        load.table,
                        load.schema,
                    );
                    if (!meta[key]) {
                        meta[key] = { state: 'ready', items: fixtures[load.kind] ?? [] };
                        changed = true;
                    }
                }
            }
            if (!changed) break;
        }
        useLive.setState({ status, meta, expanded });
    };

    const manager = {
        available: true,
        engines: [],
        toggle: vi.fn(),
        connect: vi.fn(),
    } as unknown as DbManagerApi;

    beforeEach(() => {
        resetLive();
        useProfiles.setState({ profiles: [profile] });
        populate();
        render(
            <DbManagerContext.Provider value={manager}>
                <ConnectionsSection />
            </DbManagerContext.Provider>,
        );
    });

    const rows = () => screen.getAllByRole('treeitem');

    it('draws every row at the same fixed height, whatever its kind or depth', () => {
        const all = rows();
        expect(all.length).toBeGreaterThan(10);
        for (const row of all) {
            expect(row.className.split(/\s+/)).toContain(TREE_ROW_HEIGHT);
            // Hover only tints the row.
            const hover = row.className.split(/\s+/).filter((c) => c.startsWith('hover:'));
            for (const c of hover) expect(c).toMatch(/^hover:bg-/);
        }
    });

    it('uses one action slot, last in the row, for every row that has actions', () => {
        const withActions = rows().filter((row) => row.querySelector('[data-tree-actions]'));
        // connection, database, groups, tables, views, routines, triggers and events all have menus.
        expect(withActions.length).toBeGreaterThanOrEqual(8);
        for (const row of withActions) {
            const slot = row.querySelector('[data-tree-actions]') as HTMLElement;
            expect(row.lastElementChild).toBe(slot);
            expect(slot.className.split(/\s+/)).toEqual(
                expect.arrayContaining(['size-6', 'items-center', 'justify-center']),
            );
            const button = within(slot).getByRole('button');
            expect(button.getAttribute('aria-label')).toMatch(/^Actions for /);
        }
    });

    it('covers each kind of node the tree shows', () => {
        const labelled = rows()
            .filter((row) => row.querySelector('[data-tree-actions]'))
            .map((row) =>
                within(row)
                    .getByRole('button', { name: /^Actions for / })
                    .getAttribute('aria-label'),
            );
        for (const name of ['Local', 'shop', 'orders', 'v_sales', 'fn', 'proc', 'trg', 'ev'])
            expect(labelled).toContain(`Actions for ${name}`);
    });

    it('gives columns and indexes the same row, without a menu', () => {
        const columnRow = rows().find((row) => row.textContent?.startsWith('id'));
        expect(columnRow).toBeTruthy();
        expect(columnRow!.className.split(/\s+/)).toContain(TREE_ROW_HEIGHT);
        expect(columnRow!.querySelector('[data-tree-actions]')).toBeNull();
    });

    it('opens the same menu from the centred button', () => {
        const row = rows().find((r) => r.textContent?.startsWith('orders'))!;
        fireEvent.click(within(row).getByRole('button', { name: 'Actions for orders' }));
        expect(screen.getByRole('menuitem', { name: /Open table data/ })).toBeTruthy();
    });
});
