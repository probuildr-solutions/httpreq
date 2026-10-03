/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryTab } from './QueryTab';
import { DbManagerContext, type DbManagerApi } from './useDbManager';
import {
    patchQuery,
    resetLive,
    resetQueries,
    useLive,
    useQueries,
    type QueryTab as Tab,
} from './queryStore';
import { useProfiles } from './profiles';
import { openAdminDialog } from '../admin/dialogStore';

vi.mock('../../editor/CodeEditor', () => ({
    CodeEditor: ({ value }: { value: string }) => <div data-testid="editor">{value}</div>,
}));
vi.mock('../admin/dialogStore', () => ({ openAdminDialog: vi.fn() }));

const id = 'q0000000000000001';
const profileId = 'a'.padEnd(16, '0');
const tab = (): Tab => ({
    id,
    title: 'Query 1',
    profileId,
    database: 'a_very_long_database_name_that_must_not_widen_its_picker',
    schema: null,
    text: 'select 1',
    savedText: 'select 1',
    source: null,
    runs: [],
    activeRun: null,
    log: [],
    bottom: 'results',
    explain: null,
    explainError: null,
    inTransaction: false,
    script: null,
    scriptId: null,
    running: false,
});

const manager = {
    available: true,
    engines: [
        {
            id: 'mysql',
            displayName: 'MySQL',
            defaultPort: 3306,
            capabilities: ['sql', 'explain', 'transactions'],
        },
    ],
    listMeta: vi.fn(async () => [
        { name: 'a_very_long_database_name_that_must_not_widen_its_picker', system: false },
        { name: 'shop', system: false },
    ]),
    db: null,
    run: vi.fn(),
    cancel: vi.fn(),
    explain: vi.fn(),
    transaction: vi.fn(),
    setContext: vi.fn(),
    setConnection: vi.fn(),
} as unknown as DbManagerApi;

const renderTab = () =>
    render(
        <DbManagerContext.Provider value={manager}>
            <QueryTab id={id} />
        </DbManagerContext.Provider>,
    );

beforeEach(() => {
    resetQueries();
    resetLive();
    vi.clearAllMocks();
    useProfiles.setState({
        profiles: [
            {
                id: profileId,
                name: 'A connection with a rather long display name',
                settings: { engine: 'mysql', host: 'h', port: 3306, tls: { mode: 'prefer' } },
                group: '',
                favorite: false,
                lastUsed: null,
            },
        ],
    });
    useLive.setState({
        status: { [profileId]: { id: profileId, state: 'connected', reconnects: 0 } },
    });
    useQueries.setState({ tabs: { [id]: tab() } });
});
afterEach(cleanup);

describe('the query toolbar', () => {
    it('has exactly one Export action', () => {
        renderTab();
        const bar = screen.getByRole('toolbar', { name: 'Query' });
        expect(within(bar).getAllByRole('button', { name: 'Export' })).toHaveLength(1);
        // Every action appears once.
        const names = within(bar)
            .getAllByRole('button')
            .map((b) => b.getAttribute('data-action'))
            .filter(Boolean);
        expect(new Set(names).size).toBe(names.length);
        expect(names).toEqual(['run', 'runAll', 'stop', 'explain', 'save', 'export', 'begin']);
    });

    it('opens the export dialog for the selected statement once', () => {
        renderTab();
        fireEvent.click(screen.getByRole('button', { name: 'Export' }));
        expect(openAdminDialog).toHaveBeenCalledTimes(1);
        expect(openAdminDialog).toHaveBeenCalledWith(
            expect.objectContaining({
                kind: 'export',
                profileId,
                source: expect.objectContaining({ kind: 'query', text: 'select 1' }),
            }),
        );
    });

    it('draws the connection and database pickers at the compact toolbar size', async () => {
        renderTab();
        const connection = screen.getByRole('combobox', { name: 'Connection' });
        const database = await screen.findByRole('combobox', { name: 'Database' });
        for (const picker of [connection, database]) {
            // The height of the My Workspace picker, small type, tight padding.
            expect(picker.className).toMatch(/\bh-6\b/);
            expect(picker.className).toMatch(/text-xs/);
            expect(picker.className).toMatch(/\bpx-2\b/);
            expect(picker.className).not.toMatch(/min-h-\[42px\]|text-base/);
        }
    });

    it('truncates long names inside a fixed width instead of widening the control', async () => {
        renderTab();
        const database = await screen.findByRole('combobox', { name: 'Database' });
        const label = within(database).getByText(/a_very_long_database_name/);
        expect(label.className).toMatch(/\btruncate\b/);
        // The wrapper has a fixed width and cannot grow.
        const wrapper = database.closest('[class*="w-32"]') as HTMLElement;
        // It may shrink to a minimum and truncate, but is never sized by its content.
        expect(wrapper.className).toMatch(/min-w-20/);
        expect(wrapper.className).not.toMatch(/flex-auto|flex-1|grow/);
        expect(screen.getByRole('toolbar', { name: 'Query' }).className).toMatch(/overflow-x-auto/);
    });

    it('uses compact buttons that keep a label, a tooltip target and their place when running', () => {
        renderTab();
        const run = screen.getByRole('button', { name: 'Run' });
        expect(run.className).toMatch(/h-\[26px\]/);
        expect(run.textContent).toBe('Run');
        const before = screen.getAllByRole('button').map((b) => b.textContent);
        act(() => patchQuery(id, { running: true }));
        expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(before);
    });

    it('runs the statement at the cursor, everything, and stops', () => {
        renderTab();
        fireEvent.click(screen.getByRole('button', { name: 'Run' }));
        expect(manager.run).toHaveBeenLastCalledWith(
            id,
            expect.objectContaining({ mode: 'current' }),
        );
        fireEvent.click(screen.getByRole('button', { name: 'Run all' }));
        expect(manager.run).toHaveBeenLastCalledWith(id, expect.objectContaining({ mode: 'all' }));
        act(() => patchQuery(id, { running: true }));
        fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
        expect(manager.cancel).toHaveBeenCalledWith(id);
    });

    it('offers Commit and Roll back instead of Begin inside a transaction', () => {
        renderTab();
        fireEvent.click(screen.getByRole('button', { name: 'Begin' }));
        expect(manager.transaction).toHaveBeenCalledWith(id, 'begin');
        act(() => patchQuery(id, { inTransaction: true }));
        expect(screen.queryByRole('button', { name: 'Begin' })).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Commit' }));
        expect(manager.transaction).toHaveBeenCalledWith(id, 'commit');
        fireEvent.click(screen.getByRole('button', { name: 'Roll back' }));
        expect(manager.transaction).toHaveBeenCalledWith(id, 'rollback');
    });

    it('lists the databases when the connection is open', async () => {
        renderTab();
        await waitFor(() => expect(manager.listMeta).toHaveBeenCalled());
        fireEvent.click(await screen.findByRole('combobox', { name: 'Database' }));
        expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(
            expect.arrayContaining(['shop']),
        );
    });
});
