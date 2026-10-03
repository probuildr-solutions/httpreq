/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import type { DbQuerySnapshot } from '@httpreq/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applyExecutionEvent, changesShape } from './executionEvents';
import { resetHistory, resetQueries, useHistory, useQueries, type QueryTab } from './queryStore';
import {
    executeStatements,
    readOn,
    type ExecutionDeps,
    type ExecutionEvent,
    type Settle,
} from './statementExecution';

const snapshot = (patch: {
    state?: DbQuerySnapshot['state'];
    rows?: number;
    columns?: number;
    complete?: boolean;
    paused?: boolean;
    affected?: number;
}): DbQuerySnapshot => ({
    state: patch.state ?? 'done',
    elapsedMs: 3,
    paused: patch.paused ?? false,
    results: [
        {
            index: 0,
            columns: Array.from({ length: patch.columns ?? 0 }, (_, i) => ({
                name: `c${i}`,
                type: 'int',
            })),
            rowCount: patch.rows ?? 0,
            complete: patch.complete ?? true,
            capped: false,
            ...(patch.affected !== undefined ? { affectedRows: patch.affected } : {}),
        },
    ],
});

/** A host in memory: a statement settles with whatever its text maps to. */
function setup(outcomes: Record<string, DbQuerySnapshot | Error>, rowLimit = 100) {
    const settled = new Map<string, Settle>();
    const ids = ['r0', 'r1', 'r2', 'r3', 'r4'];
    const started: string[] = [];
    const demands: { rows: number }[] = [];
    const deps: ExecutionDeps = {
        db: {
            startQuery: vi.fn(async (_connection: string, id: string, sql: string) => {
                started.push(sql);
                const outcome = outcomes[sql];
                if (outcome instanceof Error) throw outcome;
                setTimeout(() => settled.get(id)?.(outcome ?? snapshot({})), 0);
            }),
            demand: vi.fn(async (id: string, _result: number, rows: number) => {
                demands.push({ rows });
                // The host reads up to the demand, then pauses again (or finishes).
                setTimeout(
                    () =>
                        settled.get(id)?.(
                            rows >= 1_000_000
                                ? snapshot({ columns: 1, rows: 1_000_000 })
                                : snapshot({
                                      state: 'running',
                                      paused: true,
                                      columns: 1,
                                      rows,
                                      complete: false,
                                  }),
                        ),
                    0,
                );
            }),
        },
        settled,
        connectionId: 'c',
        rowLimit,
        newId: () => ids.shift()!,
    };
    const events: ExecutionEvent[] = [];
    return { deps, events, emit: (e: ExecutionEvent) => events.push(e), started, demands, settled };
}

const types = (events: ExecutionEvent[]) => events.map((e) => e.type);

describe('executeStatements', () => {
    it('reports the whole execution as events, in order', async () => {
        const { deps, events, emit } = setup({
            'SELECT 1': snapshot({ columns: 1, rows: 1 }),
            'UPDATE t SET a = 1': snapshot({ affected: 5 }),
        });
        const outcome = await executeStatements(
            deps,
            [{ sql: 'SELECT 1' }, { sql: 'UPDATE t SET a = 1' }],
            emit,
        );
        expect(outcome).toBe('completed');
        expect(types(events)).toEqual([
            'executionStarted',
            'statementStarted',
            'statementCompleted',
            'statementStarted',
            'statementCompleted',
            'executionCompleted',
        ]);
        expect(events[0]).toEqual({ type: 'executionStarted', statements: 2 });
        const started = events.filter((e) => e.type === 'statementStarted');
        expect(started.map((e) => e.type === 'statementStarted' && e.statement.kind)).toEqual([
            'SELECT',
            'UPDATE',
        ]);
        expect(events.at(-1)).toEqual({ type: 'executionCompleted', outcome: 'completed' });
    });

    it('stops at a statement the server rejects and never starts the rest', async () => {
        const { deps, events, emit, started } = setup({
            'SELECT 1': snapshot({ columns: 1, rows: 1 }),
            'SELECT nope': snapshot({ state: 'failed' }),
            'SELECT 3': snapshot({}),
        });
        const outcome = await executeStatements(
            deps,
            [{ sql: 'SELECT 1' }, { sql: 'SELECT nope' }, { sql: 'SELECT 3' }],
            emit,
        );
        expect(outcome).toBe('failed');
        expect(started).toEqual(['SELECT 1', 'SELECT nope']);
        expect(events.at(-1)).toEqual({ type: 'executionCompleted', outcome: 'failed' });
    });

    it('reports a statement the host could not start as failed', async () => {
        const { deps, events, emit } = setup({
            'SELECT 1': new Error('A statement is already running'),
        });
        const outcome = await executeStatements(deps, [{ sql: 'SELECT 1' }], emit);
        expect(outcome).toBe('failed');
        expect(events.find((e) => e.type === 'statementFailed')).toMatchObject({
            message: 'A statement is already running',
        });
        // The wait for it is dropped, so nothing is left pending.
        expect(deps.settled.size).toBe(0);
    });

    it('says when it was cancelled, and does not run what follows', async () => {
        const { deps, events, emit, started } = setup({
            'SELECT 1': snapshot({ state: 'cancelled', columns: 1, rows: 4, complete: false }),
        });
        const outcome = await executeStatements(
            deps,
            [{ sql: 'SELECT 1' }, { sql: 'SELECT 2' }],
            emit,
        );
        expect(outcome).toBe('cancelled');
        expect(started).toEqual(['SELECT 1']);
        expect(types(events).slice(-2)).toEqual(['executionCancelled', 'executionCompleted']);
    });

    it('reads an earlier result on to the limit before the next statement, and says it was cut', async () => {
        const { deps, events, emit, demands } = setup(
            {
                big: snapshot({
                    state: 'running',
                    paused: true,
                    columns: 1,
                    rows: 1000,
                    complete: false,
                }),
                'SELECT 2': snapshot({ columns: 1, rows: 1 }),
            },
            5000,
        );
        await executeStatements(deps, [{ sql: 'big' }, { sql: 'SELECT 2' }], emit);
        expect(demands).toEqual([{ rows: 5000 }]);
        expect(types(events)).toContain('statementTruncated');
        // It is told after the read-on and before the statement is reported complete.
        expect(types(events).indexOf('statementTruncated')).toBeLessThan(
            types(events).indexOf('statementCompleted'),
        );
    });

    it('does not read on for the last statement: its rows come as the grid scrolls', async () => {
        const { deps, emit, demands } = setup(
            {
                big: snapshot({
                    state: 'running',
                    paused: true,
                    columns: 1,
                    rows: 1000,
                    complete: false,
                }),
            },
            5000,
        );
        await executeStatements(deps, [{ sql: 'big' }], emit);
        expect(demands).toEqual([]);
    });

    it('does not cut a result that the read-on completes', async () => {
        const { deps, events, emit } = setup(
            {
                big: snapshot({
                    state: 'running',
                    paused: true,
                    columns: 1,
                    rows: 10,
                    complete: false,
                }),
                'SELECT 2': snapshot({}),
            },
            2_000_000,
        );
        await executeStatements(deps, [{ sql: 'big' }, { sql: 'SELECT 2' }], emit);
        expect(types(events)).not.toContain('statementTruncated');
        const done = events.find((e) => e.type === 'statementCompleted');
        expect(done?.type === 'statementCompleted' && done.snapshot.results[0]?.rowCount).toBe(
            1_000_000,
        );
    });
});

describe('readOn', () => {
    it('gives up when the host stops answering demands', async () => {
        const { deps } = setup({});
        (deps.db.demand as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('gone'));
        const first = snapshot({
            state: 'running',
            paused: true,
            columns: 1,
            rows: 10,
            complete: false,
        });
        const result = await readOn(deps, 'r0', first, 100);
        expect(result).toBe(first);
        expect(deps.settled.size).toBe(0);
    });

    it('does nothing for a result that is not paused or already has enough rows', async () => {
        const { deps, demands } = setup({});
        await readOn(deps, 'r0', snapshot({ columns: 1, rows: 10 }), 100);
        await readOn(
            deps,
            'r0',
            snapshot({ state: 'running', paused: true, columns: 1, rows: 500, complete: false }),
            100,
        );
        expect(demands).toEqual([]);
    });
});

describe('changesShape', () => {
    it('tells a new or reshaped result from more rows of a known one', () => {
        const base = snapshot({ columns: 2, rows: 10, complete: false });
        expect(changesShape(null, base)).toBe(true);
        expect(changesShape(base, snapshot({ columns: 2, rows: 500, complete: false }))).toBe(
            false,
        );
        expect(changesShape(base, snapshot({ columns: 2, rows: 500, complete: true }))).toBe(true);
        expect(changesShape(base, { ...base, results: [...base.results, base.results[0]!] })).toBe(
            true,
        );
    });
});

describe('applyExecutionEvent', () => {
    const tabId = 'q0000000000000001';
    const tab = (): QueryTab => ({
        id: tabId,
        title: 'Query 1',
        profileId: 'p',
        database: null,
        schema: null,
        text: '',
        savedText: '',
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
        running: true,
    });
    const state = () => useQueries.getState().tabs[tabId]!;
    const apply = (event: ExecutionEvent) =>
        applyExecutionEvent(
            { tabId, profileId: 'p' },
            event,
            () => useQueries.getState().tabs[tabId],
        );
    const statement = (index: number, sql: string) => ({
        index,
        runId: `run${index}`,
        sql,
        preview: sql,
        kind: sql.split(' ')[0]!.toUpperCase(),
    });

    beforeEach(() => {
        resetQueries();
        resetHistory();
        useQueries.setState({ tabs: { [tabId]: tab() } });
    });

    it('appends a result per statement, shows the newest and keeps the others', () => {
        apply({ type: 'statementStarted', statement: statement(0, 'SELECT 1') });
        apply({ type: 'statementStarted', statement: statement(1, 'SELECT 2') });
        expect(state().runs.map((r) => r.index)).toEqual([0, 1]);
        expect(state().activeRun).toBe(1);
        expect(state().log.map((l) => l.state)).toEqual(['running', 'running']);
    });

    it('does not move the shown result if the user chose another one', () => {
        apply({ type: 'statementStarted', statement: statement(0, 'SELECT 1') });
        apply({ type: 'statementStarted', statement: statement(1, 'SELECT 2') });
        useQueries.setState({ tabs: { [tabId]: { ...state(), activeRun: 0 } } });
        apply({ type: 'statementStarted', statement: statement(2, 'SELECT 3') });
        expect(state().activeRun).toBe(0);
    });

    it('stores each statement’s snapshot on its own run', () => {
        apply({ type: 'statementStarted', statement: statement(0, 'SELECT 1') });
        apply({ type: 'statementStarted', statement: statement(1, 'SELECT 2') });
        apply({
            type: 'resultMetadataAvailable',
            runId: 'run0',
            snapshot: snapshot({ columns: 1, rows: 7 }),
        });
        expect(state().runs[0]?.snapshot?.results[0]?.rowCount).toBe(7);
        expect(state().runs[1]?.snapshot).toBeNull();
        apply({
            type: 'resultRowsAvailable',
            runId: 'run0',
            snapshot: snapshot({ columns: 1, rows: 9 }),
        });
        expect(state().runs[0]?.snapshot?.results[0]?.rowCount).toBe(9);
    });

    it('records completion in the log and the history, and shows messages for a failure', () => {
        apply({ type: 'statementStarted', statement: statement(0, 'UPDATE t SET a = 1') });
        apply({
            type: 'statementCompleted',
            statement: statement(0, 'UPDATE t SET a = 1'),
            snapshot: snapshot({ affected: 3 }),
        });
        expect(state().log[0]).toMatchObject({ state: 'done', affectedRows: 3 });
        expect(useHistory.getState().entries[0]).toMatchObject({
            sql: 'UPDATE t SET a = 1',
            state: 'done',
            affectedRows: 3,
        });
        expect(state().bottom).toBe('results');

        apply({ type: 'statementStarted', statement: statement(1, 'SELECT x') });
        apply({
            type: 'statementCompleted',
            statement: statement(1, 'SELECT x'),
            snapshot: { ...snapshot({}), state: 'failed', error: { code: 'SQL', message: 'bad' } },
        });
        expect(state().bottom).toBe('messages');
        expect(state().log[1]).toMatchObject({ state: 'failed', message: 'bad' });
    });

    it('keeps a password out of the history, as before', () => {
        apply({
            type: 'statementStarted',
            statement: statement(0, "ALTER USER x IDENTIFIED BY 'secret'"),
        });
        apply({
            type: 'statementCompleted',
            statement: statement(0, "ALTER USER x IDENTIFIED BY 'secret'"),
            snapshot: snapshot({}),
        });
        expect(JSON.stringify(useHistory.getState().entries)).not.toContain('secret');
    });

    it('shows a statement that could not start as a failed result', () => {
        apply({ type: 'statementStarted', statement: statement(0, 'SELECT 1') });
        apply({ type: 'statementFailed', statement: statement(0, 'SELECT 1'), message: 'busy' });
        expect(state().runs[0]?.snapshot).toMatchObject({
            state: 'failed',
            error: { message: 'busy' },
        });
        expect(state().bottom).toBe('messages');
    });

    it('marks a cut result and ends the run', () => {
        apply({ type: 'statementStarted', statement: statement(0, 'SELECT 1') });
        apply({ type: 'statementTruncated', runId: 'run0' });
        expect(state().runs[0]?.truncated).toBe(true);
        apply({ type: 'executionCompleted', outcome: 'completed' });
        expect(state().running).toBe(false);
    });
});
