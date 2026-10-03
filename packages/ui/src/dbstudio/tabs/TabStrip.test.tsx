/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { settleConfirm, useConfirmStore } from '../../confirm';
import { resetAdmin, openAdminTab } from '../admin/adminStore';
import { DbManagerContext, type DbManagerApi } from '../db/useDbManager';
import { resetQueries, useQueries, type QueryTab } from '../db/queryStore';
import { resetStudio, useStudioStore } from '../studioStore';
import { DbStudioContext, type DbStudioApi } from '../useDbStudio';
import { resetTabMeta, useTabMeta } from './tabMetaStore';
import { TabStrip } from './TabStrip';

const query = (id: string, title: string, text = '', saved = text): QueryTab => ({
    id,
    title,
    profileId: null,
    database: null,
    schema: null,
    text,
    savedText: saved,
    source: null,
    runId: null,
    snapshot: null,
    log: [],
    resultIndex: 0,
    bottom: 'results',
    explain: null,
    explainError: null,
    inTransaction: false,
    script: null,
    scriptId: null,
    running: false,
});

const open = (...tabs: QueryTab[]) => {
    useQueries.setState({ tabs: Object.fromEntries(tabs.map((t) => [t.id, t])) });
    useStudioStore.setState({ order: tabs.map((t) => t.id), activeId: tabs[0]?.id ?? null });
};

const manager = (overrides: Partial<DbManagerApi> = {}): DbManagerApi =>
    ({
        available: true,
        engines: [],
        newQuery: vi.fn(() => 'q0000000000000099'),
        closeQuery: vi.fn(async (id: string) => {
            useQueries.setState((state) => {
                const tabs = { ...state.tabs };
                delete tabs[id];
                return { tabs };
            });
            useStudioStore.setState((state) => ({
                order: state.order.filter((item) => item !== id),
            }));
        }),
        ...overrides,
    }) as unknown as DbManagerApi;

const studio = (overrides: Partial<DbStudioApi> = {}): DbStudioApi =>
    ({
        available: true,
        openFile: vi.fn(),
        closeTab: vi.fn(),
        saveText: vi.fn(async () => ({ kind: 'saved', token: 't', name: 'saved.sql' })),
        ...overrides,
    }) as unknown as DbStudioApi;

const Harness = ({ children, m, s }: { children: ReactNode; m: DbManagerApi; s: DbStudioApi }) => (
    <DbManagerContext.Provider value={m}>
        <DbStudioContext.Provider value={s}>{children}</DbStudioContext.Provider>
    </DbManagerContext.Provider>
);

const names = () => screen.getAllByRole('tab').map((tab) => tab.textContent);
const menuItem = (name: string) => screen.getByRole('menuitem', { name });
const rightClick = (title: string) =>
    fireEvent.contextMenu(screen.getByRole('tab', { name: new RegExp(title) }));

beforeEach(() => {
    resetStudio();
    resetQueries();
    resetAdmin();
    resetTabMeta();
});
afterEach(() => {
    cleanup();
    settleConfirm('cancel');
});

describe('tab context menu', () => {
    const ids = [
        'q0000000000000001',
        'q0000000000000002',
        'q0000000000000003',
        'q0000000000000004',
    ];
    const four = () => open(...ids.map((id, i) => query(id, `Tab ${i + 1}`)));

    it('closes tabs to the left, to the right and the others, and all', async () => {
        four();
        const m = manager();
        render(<TabStrip />, {
            wrapper: (p) => (
                <Harness m={m} s={studio()}>
                    {p.children}
                </Harness>
            ),
        });
        rightClick('Tab 2');
        fireEvent.click(menuItem('Close Tabs to the Left'));
        await waitFor(() => expect(names()).toHaveLength(3));
        expect(names().join()).not.toContain('Tab 1');

        rightClick('Tab 3');
        fireEvent.click(menuItem('Close Tabs to the Right'));
        await waitFor(() => expect(names()).toHaveLength(2));
        expect(names().join()).not.toContain('Tab 4');

        rightClick('Tab 3');
        fireEvent.click(menuItem('Close Other Tabs'));
        await waitFor(() => expect(names()).toHaveLength(1));
        expect(names()[0]).toContain('Tab 3');
    });

    it('disables close left on the first tab and close right on the last', () => {
        four();
        render(<TabStrip />, {
            wrapper: (p) => (
                <Harness m={manager()} s={studio()}>
                    {p.children}
                </Harness>
            ),
        });
        rightClick('Tab 1');
        expect(menuItem('Close Tabs to the Left').hasAttribute('disabled')).toBe(true);
        expect(menuItem('Close Tabs to the Right').hasAttribute('disabled')).toBe(false);
    });

    it('keeps pinned tabs open unless told to include them', async () => {
        four();
        render(<TabStrip />, {
            wrapper: (p) => (
                <Harness m={manager()} s={studio()}>
                    {p.children}
                </Harness>
            ),
        });
        rightClick('Tab 3');
        fireEvent.click(menuItem('Pin Tab'));
        // pinned tabs move to the left of the strip
        expect(names()[0]).toContain('Tab 3');
        rightClick('Tab 4');
        fireEvent.click(menuItem('Close Tabs to the Left'));
        await waitFor(() => expect(names()).toHaveLength(2));
        expect(names().join()).toContain('Tab 3');

        rightClick('Tab 4');
        fireEvent.click(menuItem('Close All Tabs, Including Pinned'));
        await waitFor(() => expect(screen.queryAllByRole('tab')).toHaveLength(0));
    });

    it('asks once for any number of tabs with unsaved changes, and saves them on request', async () => {
        open(
            query(ids[0]!, 'Draft one', 'select 1', ''),
            query(ids[1]!, 'Draft two', 'select 2', ''),
            query(ids[2]!, 'Saved', 'select 3', 'select 3'),
        );
        const s = studio();
        render(<TabStrip />, {
            wrapper: (p) => (
                <Harness m={manager()} s={s}>
                    {p.children}
                </Harness>
            ),
        });
        rightClick('Saved');
        fireEvent.click(menuItem('Close Other Tabs'));
        await waitFor(() => expect(useConfirmStore.getState().request).not.toBeNull());
        const request = useConfirmStore.getState().request!;
        expect(request.title).toBe('Close 2 tabs?');
        expect(request.message).toContain('Draft one');
        expect(request.message).toContain('Draft two');
        act(() => settleConfirm('confirm'));
        await waitFor(() => expect(names()).toHaveLength(1));
        expect(s.saveText).toHaveBeenCalledTimes(2);
        expect(useConfirmStore.getState().request).toBeNull();
    });

    it('closes without saving when asked, and nothing closes on cancel', async () => {
        open(query(ids[0]!, 'Draft', 'select 1', ''), query(ids[1]!, 'Other'));
        const s = studio();
        render(<TabStrip />, {
            wrapper: (p) => (
                <Harness m={manager()} s={s}>
                    {p.children}
                </Harness>
            ),
        });
        fireEvent.click(screen.getByRole('button', { name: 'Close Draft' }));
        await waitFor(() => expect(useConfirmStore.getState().request).not.toBeNull());
        act(() => settleConfirm('cancel'));
        await waitFor(() => expect(useConfirmStore.getState().request).toBeNull());
        expect(names()).toHaveLength(2);

        fireEvent.click(screen.getByRole('button', { name: 'Close Draft' }));
        await waitFor(() => expect(useConfirmStore.getState().request).not.toBeNull());
        act(() => settleConfirm('alternate'));
        await waitFor(() => expect(names()).toHaveLength(1));
        expect(s.saveText).not.toHaveBeenCalled();
    });

    it('keeps a tab open when its save is cancelled, while the others close', async () => {
        open(query(ids[0]!, 'Draft', 'select 1', ''), query(ids[1]!, 'Plain'));
        const s = studio({ saveText: vi.fn(async () => ({ kind: 'cancelled' as const })) });
        render(<TabStrip />, {
            wrapper: (p) => (
                <Harness m={manager()} s={s}>
                    {p.children}
                </Harness>
            ),
        });
        rightClick('Plain');
        fireEvent.click(menuItem('Close All Tabs'));
        await waitFor(() => expect(useConfirmStore.getState().request).not.toBeNull());
        act(() => settleConfirm('confirm'));
        await waitFor(() => expect(names()).toHaveLength(1));
        expect(names()[0]).toContain('Draft');
    });

    it('renames and duplicates a query tab', async () => {
        open(query(ids[0]!, 'Original', 'select 1'));
        const m = manager();
        render(<TabStrip />, {
            wrapper: (p) => (
                <Harness m={m} s={studio()}>
                    {p.children}
                </Harness>
            ),
        });
        rightClick('Original');
        fireEvent.click(menuItem('Rename Tab'));
        const input = await screen.findByLabelText('Tab name');
        fireEvent.change(input, { target: { value: 'Renamed' } });
        fireEvent.keyDown(input, { key: 'Enter' });
        await waitFor(() => expect(useQueries.getState().tabs[ids[0]!]!.title).toBe('Renamed'));

        rightClick('Renamed');
        fireEvent.click(menuItem('Duplicate Tab'));
        expect(m.newQuery).toHaveBeenCalledWith(null, 'select 1', 'Renamed (copy)');
    });

    it('reopens a closed query tab with its text', async () => {
        open(
            query(ids[0]!, 'Keep', 'select 1', 'select 1'),
            query(ids[1]!, 'Gone', 'select 42', 'select 42'),
        );
        const m = manager();
        render(<TabStrip />, {
            wrapper: (p) => (
                <Harness m={m} s={studio()}>
                    {p.children}
                </Harness>
            ),
        });
        fireEvent.click(screen.getByRole('button', { name: 'Close Gone' }));
        await waitFor(() => expect(names()).toHaveLength(1));
        expect(useTabMeta.getState().closed[0]?.text).toBe('select 42');
        fireEvent.click(screen.getByRole('button', { name: 'Reopen closed tab' }));
        expect(m.newQuery).toHaveBeenCalledWith(null, 'select 42', 'Gone');
    });

    it('applies the same menu to table editors and diagrams', async () => {
        open(query(ids[0]!, 'Query'));
        openAdminTab({ kind: 'table', title: 'orders', profileId: 'p1', name: 'orders' });
        openAdminTab({ kind: 'er', title: 'Diagram', profileId: 'p1' });
        render(<TabStrip />, {
            wrapper: (p) => (
                <Harness m={manager()} s={studio()}>
                    {p.children}
                </Harness>
            ),
        });
        expect(names()).toHaveLength(3);
        rightClick('orders');
        fireEvent.click(menuItem('Close Tabs to the Right'));
        await waitFor(() => expect(names()).toHaveLength(2));
        expect(within(screen.getAllByRole('tab')[1]!).getByText('orders')).toBeTruthy();
    });
});
