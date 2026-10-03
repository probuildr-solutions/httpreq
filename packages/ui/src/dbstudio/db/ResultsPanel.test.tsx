/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { DbQuerySnapshot } from '@httpreq/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ResultsPanel } from './ResultsPanel';
import { patchQuery, resetQueries, useQueries, type QueryTab } from './queryStore';
import { emptyView, statementKind, type StatementRun } from './resultSession';
import { DbManagerContext, type DbManagerApi } from './useDbManager';

const id = 'q0000000000000001';

const rowsSnapshot = (rows: number, columns = ['id']): DbQuerySnapshot => ({
    state: 'done',
    elapsedMs: rows,
    paused: false,
    results: [
        {
            index: 0,
            columns: columns.map((name) => ({ name, type: 'int' })),
            rowCount: rows,
            complete: true,
            capped: false,
        },
    ],
});
const affectedSnapshot = (affected: number): DbQuerySnapshot => ({
    state: 'done',
    elapsedMs: 4,
    paused: false,
    results: [
        {
            index: 0,
            columns: [],
            rowCount: 0,
            complete: true,
            capped: false,
            affectedRows: affected,
        },
    ],
});

const run = (index: number, sql: string, snapshot: DbQuerySnapshot | null): StatementRun => ({
    index,
    runId: `run${index}`.padEnd(16, '0'),
    sql,
    kind: statementKind(sql),
    snapshot,
    resultIndex: 0,
    view: emptyView(),
});

const tabWith = (runs: StatementRun[], activeRun: number | null = runs.length - 1): QueryTab => ({
    id,
    title: 'Query 1',
    profileId: null,
    database: null,
    schema: null,
    text: '',
    savedText: '',
    source: null,
    runs,
    activeRun,
    log: [],
    bottom: 'results',
    explain: null,
    explainError: null,
    inTransaction: false,
    script: null,
    scriptId: null,
    running: false,
});

const pages: string[] = [];
const manager = {
    available: true,
    db: {
        page: vi.fn(async (runId: string) => {
            pages.push(runId);
            return { rows: [[1], [2]], clipped: [], firstRow: 0, pageSize: 1000 };
        }),
        cell: vi.fn(),
    },
    setResult: vi.fn((tabId: string, run: number) => patchQuery(tabId, { activeRun: run })),
    closeResults: vi.fn(async () => undefined),
    setResultView: vi.fn(),
    demand: vi.fn(),
    fetchAll: vi.fn(),
} as unknown as DbManagerApi;

function Harness() {
    const tab = useQueries((state) => state.tabs[id]);
    return tab ? <ResultsPanel tab={tab} /> : null;
}
const show = (runs: StatementRun[], active?: number | null) => {
    useQueries.setState({ tabs: { [id]: tabWith(runs, active) } });
    return render(
        <DbManagerContext.Provider value={manager}>
            <Harness />
        </DbManagerContext.Provider>,
    );
};

const three = () => [
    run(0, 'SELECT * FROM users', rowsSnapshot(250)),
    run(1, 'SELECT * FROM roles', rowsSnapshot(18)),
    run(2, 'SELECT * FROM permissions', rowsSnapshot(64)),
];

beforeEach(() => {
    resetQueries();
    pages.length = 0;
    vi.clearAllMocks();
});
afterEach(cleanup);

describe('result tabs for several statements', () => {
    it('shows one tab per statement, in order, and the metadata of the shown one', () => {
        show(three());
        const tabs = within(screen.getByRole('tablist', { name: 'Results' })).getAllByRole('tab');
        expect(tabs.map((t) => t.textContent)).toEqual([
            expect.stringContaining('Result 1'),
            expect.stringContaining('Result 2'),
            expect.stringContaining('Result 3'),
        ]);
        // The newest result is shown, with its snippet, row count and duration.
        expect(tabs[2]!.getAttribute('aria-selected')).toBe('true');
        expect(screen.getByText('SELECT * FROM permissions')).toBeTruthy();
        expect(screen.getByText('64 rows · 64 ms')).toBeTruthy();
    });

    it('shows a single statement without a tab strip, only its header', () => {
        show([run(0, 'SELECT 1', rowsSnapshot(1))]);
        expect(screen.queryByRole('tablist', { name: 'Results' })).toBeNull();
        expect(screen.getByText('SELECT 1')).toBeTruthy();
        expect(screen.getByText('Result 1')).toBeTruthy();
    });

    it('switches results without running anything, and each keeps its own grid', async () => {
        show(three());
        await waitFor(() => expect(pages).toContain(three()[2]!.runId));
        fireEvent.click(screen.getByRole('tab', { name: /Result 1/ }));
        expect(manager.setResult).toHaveBeenCalledWith(id, 0);
        expect(screen.getByText('SELECT * FROM users')).toBeTruthy();
        expect(screen.getByText('250 rows · 250 ms')).toBeTruthy();
        // The grid of the first result reads its own host query, not the last one's.
        await waitFor(() => expect(pages).toContain(three()[0]!.runId));
        expect((manager as unknown as { run?: unknown }).run).toBeUndefined();
    });

    it('reports where a grid was left when its result is hidden, so it opens there again', async () => {
        show(three());
        await waitFor(() => expect(pages).toContain(three()[2]!.runId));
        act(() => manager.setResult(id, 0));
        await waitFor(() =>
            expect(manager.setResultView).toHaveBeenCalledWith(id, 2, {
                scrollTop: 0,
                selected: null,
            }),
        );
    });

    it('lists statements that change data by what they changed, in order, among the results', () => {
        show(
            [
                run(0, 'UPDATE users SET active = 1', affectedSnapshot(1)),
                run(1, 'SELECT * FROM users WHERE id = 10', rowsSnapshot(1)),
                run(2, 'DELETE FROM temp_records', affectedSnapshot(42)),
                run(3, 'SELECT COUNT(*) FROM temp_records', rowsSnapshot(1)),
            ],
            2,
        );
        const names = within(screen.getByRole('tablist', { name: 'Results' }))
            .getAllByRole('tab')
            .map((t) => t.textContent);
        expect(names).toEqual([
            expect.stringContaining('Statement 1'),
            expect.stringContaining('Result 2'),
            expect.stringContaining('Statement 3'),
            expect.stringContaining('Result 4'),
        ]);
        // Said in the pane and, with its time, in the header.
        expect(screen.getAllByText(/42 rows affected/).length).toBeGreaterThan(1);
        expect(screen.getByText('42 rows affected · 4 ms')).toBeTruthy();
    });

    it('shows a failed statement with its error and keeps the earlier results', () => {
        show([
            run(0, 'SELECT 1', rowsSnapshot(1)),
            run(1, 'SELECT nope', {
                state: 'failed',
                results: [],
                elapsedMs: 3,
                paused: false,
                error: { code: 'SQL', message: 'Unknown column nope' },
            }),
        ]);
        expect(screen.getByRole('alert').textContent).toContain('Unknown column nope');
        expect(
            within(screen.getByRole('tab', { name: /Statement 2|Result 2/ })).getByLabelText(
                'Failed',
            ),
        ).toBeTruthy();
        expect(
            within(screen.getByRole('tab', { name: /Result 1/ })).getByLabelText('Succeeded'),
        ).toBeTruthy();
    });
});

describe('closing result tabs', () => {
    it('closes one result from its button', () => {
        show(three());
        fireEvent.click(screen.getByRole('button', { name: 'Close Result 2' }));
        expect(manager.closeResults).toHaveBeenCalledWith(id, 'self', 1);
    });

    it('offers close, left, right, others and all from the context menu, with the right mode', () => {
        show(three());
        fireEvent.contextMenu(screen.getByRole('tab', { name: /Result 2/ }));
        const menu = screen.getByRole('menu', { name: 'Result actions' });
        const items = within(menu)
            .getAllByRole('menuitem')
            .map((i) => i.textContent);
        expect(items).toEqual([
            'Close Result',
            'Close Results to the Left',
            'Close Results to the Right',
            'Close Other Results',
            'Close All Results',
        ]);
        fireEvent.click(within(menu).getByRole('menuitem', { name: 'Close Results to the Right' }));
        expect(manager.closeResults).toHaveBeenCalledWith(id, 'right', 1);
    });

    it('disables left on the first result and right on the last', () => {
        show(three());
        fireEvent.contextMenu(screen.getByRole('tab', { name: /Result 1/ }));
        expect(
            screen
                .getByRole('menuitem', { name: 'Close Results to the Left' })
                .hasAttribute('disabled'),
        ).toBe(true);
        cleanup();
        show(three());
        fireEvent.contextMenu(screen.getByRole('tab', { name: /Result 3/ }));
        expect(
            screen
                .getByRole('menuitem', { name: 'Close Results to the Right' })
                .hasAttribute('disabled'),
        ).toBe(true);
    });
});
