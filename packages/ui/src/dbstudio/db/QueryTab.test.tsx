/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryTab } from './QueryTab';
import { DbManagerContext, type DbManagerApi } from './useDbManager';
import {
    patchQuery,
    resetLive,
    resetQueries,
    useQueries,
    type QueryTab as Tab,
} from './queryStore';
import { useProfiles } from './profiles';

vi.mock('../../editor/CodeEditor', () => ({
    CodeEditor: ({ value }: { value: string }) => <div data-testid="editor">{value}</div>,
}));

const id = 'q0000000000000001';
const tab = (): Tab => ({
    id,
    title: 'Query 1',
    profileId: 'a'.padEnd(16, '0'),
    database: null,
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
    listMeta: async () => [],
    db: null,
    run: vi.fn(),
    cancel: vi.fn(),
} as unknown as DbManagerApi;

beforeEach(() => {
    resetQueries();
    resetLive();
    useProfiles.setState({
        profiles: [
            {
                id: 'a'.padEnd(16, '0'),
                name: 'Local',
                settings: { engine: 'mysql', host: 'h', port: 3306, tls: { mode: 'prefer' } },
                group: '',
                favorite: false,
                lastUsed: null,
            },
        ],
    });
    useQueries.setState({ tabs: { [id]: tab() } });
});
afterEach(cleanup);

describe('the query toolbar while a statement runs', () => {
    it('keeps Run, Run all and Stop in place and only changes which can be used', () => {
        render(
            <DbManagerContext.Provider value={manager}>
                <QueryTab id={id} />
            </DbManagerContext.Provider>,
        );
        const bar = screen.getByTestId('query-tab').firstElementChild as HTMLElement;
        const labels = () =>
            Array.from(bar.querySelectorAll('button')).map((b) => b.textContent?.trim());
        const before = labels();
        const run = screen.getByRole('button', { name: 'Run' });
        const stop = screen.getByRole('button', { name: 'Stop' });
        expect(run.hasAttribute('disabled')).toBe(false);
        expect(stop.hasAttribute('disabled')).toBe(true);
        // a fixed-height strip that cannot wrap
        expect(bar.className).toMatch(/\bh-9\b/);
        expect(bar.className).not.toMatch(/flex-wrap/);

        act(() => patchQuery(id, { running: true }));
        expect(screen.getByRole('button', { name: 'Run' })).toBe(run);
        expect(screen.getByRole('button', { name: 'Stop' })).toBe(stop);
        expect(run.hasAttribute('disabled')).toBe(true);
        expect(screen.getByRole('button', { name: 'Run all' }).hasAttribute('disabled')).toBe(true);
        expect(stop.hasAttribute('disabled')).toBe(false);
        expect(labels()).toEqual(before);
    });

    it('does not rebuild the editor when a run starts and finishes', () => {
        render(
            <DbManagerContext.Provider value={manager}>
                <QueryTab id={id} />
            </DbManagerContext.Provider>,
        );
        const editor = screen.getByTestId('editor');
        act(() => patchQuery(id, { running: true }));
        act(() =>
            patchQuery(id, { running: false, log: [{ index: 0, sql: 'select 1', state: 'done' }] }),
        );
        expect(screen.getByTestId('editor')).toBe(editor);
    });
});
