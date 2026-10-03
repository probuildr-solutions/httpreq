/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { act, renderHook } from '@testing-library/react';
import type {
    DbHostEvent,
    DbHostOp,
    DbQuerySnapshot,
    DbResultInfo,
    DbStudioBridge,
} from '@httpreq/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useProfiles } from './profiles';
import {
    DEFAULT_RUN_ALL_ROW_LIMIT,
    resetLive,
    resetQueries,
    useQueries,
    useQuerySettings,
} from './queryStore';
import { runSummary, runTitle } from './resultSession';
import { useDbManagerState, type DbManagerApi } from './useDbManager';

const profileId = 'a'.padEnd(16, '0');

/** What a fake statement does on the fake host. */
interface Plan {
    /** Columns of a row-returning statement; omit for one that changes data. */
    columns?: string[];
    /** Rows the statement would produce in all. */
    rows?: number;
    affected?: number;
    /** Rows the host reads before pausing for the window (the first page and its read-ahead). */
    firstWindow?: number;
    /** The statement never finishes until cancelled. */
    hang?: boolean;
    fail?: string;
}

interface FakeRun {
    plan: Plan;
    read: number;
    state: DbQuerySnapshot['state'];
}

/** A database host in memory: it records every call and pushes snapshots as the real one does. */
function fakeHost(plans: Record<string, Plan>) {
    const listeners = new Set<(event: DbHostEvent) => void>();
    const runs = new Map<string, FakeRun>();
    const calls: { op: DbHostOp; payload: Record<string, unknown> }[] = [];
    const queryOrder: string[] = [];

    const snapshotOf = (run: FakeRun): DbQuerySnapshot => {
        const plan = run.plan;
        const complete = plan.rows === undefined || run.read >= plan.rows;
        const paused = run.state === 'running' && !plan.hang && !complete;
        const result: DbResultInfo = {
            index: 0,
            columns: (plan.columns ?? []).map((name) => ({ name, type: 'int' })),
            rowCount: run.read,
            complete: run.state === 'done' ? true : complete && !plan.hang,
            capped: false,
            ...(plan.affected !== undefined ? { affectedRows: plan.affected } : {}),
        };
        return {
            state: run.state,
            results: plan.fail ? [] : [result],
            elapsedMs: 5,
            paused,
            ...(plan.fail ? { error: { code: 'SQL', message: plan.fail } } : {}),
        };
    };
    const emit = (queryId: string) => {
        const run = runs.get(queryId);
        if (!run) return;
        const event: DbHostEvent = {
            topic: 'query.state',
            payload: { queryId, connectionId: profileId, snapshot: snapshotOf(run) },
        } as DbHostEvent;
        for (const listener of listeners) listener(event);
    };
    const settle = (queryId: string) => {
        const run = runs.get(queryId)!;
        if (run.plan.fail) run.state = 'failed';
        else if (run.plan.hang) run.state = 'running';
        else {
            const total = run.plan.rows ?? 0;
            if (run.read >= total) run.state = 'done';
        }
        emit(queryId);
    };

    const handlers: Partial<Record<DbHostOp, (p: Record<string, unknown>) => unknown>> = {
        'engines.list': () => [
            { id: 'mysql', displayName: 'MySQL', defaultPort: 3306, capabilities: ['sql'] },
        ],
        'conn.open': () => ({ id: profileId, state: 'connected', reconnects: 0 }),
        'meta.list': () => [],
        'sql.split': (p) =>
            String(p.text)
                .split(';')
                .map((part) => part.trim())
                .filter(Boolean)
                .map((sql, i) => ({ start: i, end: i + sql.length, sql, kind: 0 })),
        'query.start': (p) => {
            const queryId = String(p.queryId);
            // The connection runs one statement at a time: a run waiting for the window to scroll
            // is stopped to make room, and its rows so far stay readable.
            for (const [otherId, other] of runs) {
                if (other.state === 'running' && !other.plan.hang) {
                    other.state = 'cancelled';
                    emit(otherId);
                }
            }
            const plan = plans[String(p.sql)] ?? { affected: 0 };
            const run: FakeRun = { plan, read: 0, state: 'running' };
            runs.set(queryId, run);
            queryOrder.push(queryId);
            const total = plan.rows ?? 0;
            run.read = plan.hang ? 0 : Math.min(total, plan.firstWindow ?? total);
            setTimeout(() => settle(queryId), 0);
            return { queryId };
        },
        'query.demand': (p) => {
            const queryId = String(p.queryId);
            const run = runs.get(queryId);
            if (run && run.state === 'running') {
                run.read = Math.min(run.plan.rows ?? 0, Number(p.rows));
                setTimeout(() => settle(queryId), 0);
            }
        },
        'query.cancel': (p) => {
            const run = runs.get(String(p.queryId));
            if (run && run.state === 'running') {
                run.state = 'cancelled';
                emit(String(p.queryId));
            }
        },
        'query.close': (p) => {
            runs.delete(String(p.queryId));
        },
    };

    const bridge = {
        dbRequest: async (op: DbHostOp, payload?: unknown) => {
            const body = (payload ?? {}) as Record<string, unknown>;
            calls.push({ op, payload: body });
            const handler = handlers[op];
            return { ok: true as const, value: handler ? await handler(body) : undefined };
        },
        onDbEvent: (listener: (event: DbHostEvent) => void) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        setDbPassword: async () => true,
        hasDbPassword: async () => false,
        deleteDbPassword: async () => undefined,
    } as unknown as DbStudioBridge;

    return {
        bridge,
        calls,
        queryOrder,
        liveRuns: () => [...runs.keys()],
        called: (op: DbHostOp) => calls.filter((c) => c.op === op).map((c) => c.payload),
    };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

async function open(plans: Record<string, Plan>) {
    const host = fakeHost(plans);
    const { result } = renderHook(() => useDbManagerState(host.bridge));
    await act(async () => {
        await tick();
    });
    let id = '';
    act(() => {
        id = (result.current as DbManagerApi).newQuery(profileId, '', 'Query 1');
    });
    const tab = () => useQueries.getState().tabs[id]!;
    const run = async (text: string, mode: 'all' | 'current' = 'all') => {
        await act(async () => {
            await (result.current as DbManagerApi).run(id, { text, mode });
        });
    };
    return { host, manager: () => result.current as DbManagerApi, id, tab, run };
}

beforeEach(() => {
    resetQueries();
    resetLive();
    useQuerySettings.setState({ runAllRowLimit: DEFAULT_RUN_ALL_ROW_LIMIT });
    useProfiles.setState({
        profiles: [
            {
                id: profileId,
                name: 'Local',
                settings: { engine: 'mysql', host: 'h', port: 3306, tls: { mode: 'prefer' } },
                group: '',
                favorite: false,
                lastUsed: null,
            },
        ],
    });
});
afterEach(() => {
    resetQueries();
});

describe('Run all with several SELECT statements', () => {
    const plans = {
        'SELECT * FROM users': { columns: ['id'], rows: 250 },
        'SELECT * FROM roles': { columns: ['id'], rows: 18 },
        'SELECT * FROM permissions': { columns: ['id'], rows: 64 },
    };
    const script = 'SELECT * FROM users; SELECT * FROM roles; SELECT * FROM permissions';

    it('keeps every result as its own entry, in order, with its own metadata', async () => {
        const { tab, run, host } = await open(plans);
        await run(script);

        const runs = tab().runs;
        expect(runs.map((r) => r.index)).toEqual([0, 1, 2]);
        expect(runs.map((r) => r.sql)).toEqual(Object.keys(plans));
        expect(runs.map((r) => r.snapshot?.results[0]?.rowCount)).toEqual([250, 18, 64]);
        expect(runs.map((r) => runTitle(r))).toEqual(['Result 1', 'Result 2', 'Result 3']);
        expect(runs[0] && runSummary(runs[0])).toMatch(/^250 rows · /);
        expect(runs[1] && runSummary(runs[1])).toMatch(/^18 rows · /);
        // The newest result is shown, and nothing was released along the way.
        expect(tab().activeRun).toBe(2);
        expect(host.called('query.close')).toEqual([]);
        expect(tab().running).toBe(false);
    });

    it('does not rerun anything when another result is shown', async () => {
        const { tab, run, host, manager, id } = await open(plans);
        await run(script);
        const started = host.called('query.start').length;
        act(() => manager().setResult(id, 0));
        act(() => manager().setResult(id, 1));
        expect(tab().activeRun).toBe(1);
        expect(host.called('query.start')).toHaveLength(started);
        expect(tab().runs.map((r) => r.snapshot?.results[0]?.rowCount)).toEqual([250, 18, 64]);
    });

    it('releases the previous execution when a new one starts', async () => {
        const { tab, run, host } = await open(plans);
        await run(script);
        const first = tab().runs.map((r) => r.runId);
        await run('SELECT * FROM roles');
        expect(host.called('query.close').map((p) => p.queryId)).toEqual(first);
        expect(tab().runs).toHaveLength(1);
    });
});

describe('Run all with mixed statements', () => {
    const plans = {
        'UPDATE users SET active = 1 WHERE id = 10': { affected: 1 },
        'SELECT * FROM users WHERE id = 10': { columns: ['id'], rows: 1 },
        'DELETE FROM temp_records WHERE expired = 1': { affected: 42 },
        'SELECT COUNT(*) FROM temp_records': { columns: ['n'], rows: 1 },
    };

    it('preserves statement order and keeps the intermediate outcomes', async () => {
        const { tab, run } = await open(plans);
        await run(Object.keys(plans).join('; '));
        const runs = tab().runs;
        expect(runs.map((r) => r.kind)).toEqual(['UPDATE', 'SELECT', 'DELETE', 'SELECT']);
        expect(runs.map((r) => runTitle(r))).toEqual([
            'Statement 1',
            'Result 2',
            'Statement 3',
            'Result 4',
        ]);
        expect(runSummary(runs[0]!)).toMatch(/^1 row affected · /);
        expect(runSummary(runs[1]!)).toMatch(/^1 row · /);
        expect(runSummary(runs[2]!)).toMatch(/^42 rows affected · /);
        expect(runSummary(runs[3]!)).toMatch(/^1 row · /);
    });

    it('stops at a failing statement and keeps what ran before it', async () => {
        const { tab, run } = await open({
            ...plans,
            'SELECT * FROM users WHERE id = 10': { fail: 'Unknown column' },
        });
        await run(Object.keys(plans).join('; '));
        const runs = tab().runs;
        expect(runs).toHaveLength(2);
        expect(runs[0]?.snapshot?.state).toBe('done');
        expect(runs[1]?.snapshot?.state).toBe('failed');
        expect(runs[1]?.snapshot?.error?.message).toBe('Unknown column');
        expect(tab().running).toBe(false);
    });
});

describe('large results', () => {
    it('reads an earlier result on, up to the limit, before the next statement starts', async () => {
        useQuerySettings.setState({ runAllRowLimit: 5000 });
        const { tab, run, host } = await open({
            'SELECT * FROM events': { columns: ['id'], rows: 2_000_000, firstWindow: 1000 },
            'SELECT 1': { columns: ['n'], rows: 1 },
        });
        await run('SELECT * FROM events; SELECT 1');
        const [first, second] = tab().runs;
        expect(host.called('query.demand')).toEqual([
            expect.objectContaining({ result: 0, rows: 5000 }),
        ]);
        // Cut at the limit, not at the first screen, and said so.
        expect(first?.snapshot?.results[0]?.rowCount).toBe(5000);
        expect(first?.truncated).toBe(true);
        expect(runSummary(first!)).toMatch(/^First 5,000 rows · /);
        expect(second?.snapshot?.results[0]?.rowCount).toBe(1);
        expect(host.called('query.close')).toEqual([]);
    });

    it('holds counts and metadata in the window, never the rows', async () => {
        const { tab, run } = await open({
            'SELECT * FROM events': { columns: ['id'], rows: 1_000_000 },
        });
        await run('SELECT * FROM events');
        expect(tab().runs[0]?.snapshot?.results[0]?.rowCount).toBe(1_000_000);
        // A million rows here would be megabytes; the tab is a few hundred bytes of counts.
        expect(JSON.stringify(tab()).length).toBeLessThan(5_000);
    });

    it('does not read on for the last statement, so its rows are fetched as the grid scrolls', async () => {
        const { run, host } = await open({
            'SELECT * FROM events': { columns: ['id'], rows: 2_000_000, firstWindow: 1000 },
        });
        await run('SELECT * FROM events');
        expect(host.called('query.demand')).toEqual([]);
    });
});

describe('cancellation', () => {
    it('stops the running statement and leaves the finished results as they are', async () => {
        const { tab, host, manager, id } = await open({
            'SELECT 1': { columns: ['n'], rows: 1 },
            'SELECT SLEEP(100)': { columns: ['n'], hang: true },
            'SELECT 3': { columns: ['n'], rows: 1 },
        });
        let pending: Promise<void> = Promise.resolve();
        await act(async () => {
            pending = manager().run(id, {
                text: 'SELECT 1; SELECT SLEEP(100); SELECT 3',
                mode: 'all',
            });
            await tick();
            await tick();
        });
        expect(tab().running).toBe(true);
        expect(tab().runs.map((r) => r.snapshot?.state)).toEqual(['done', 'running']);

        await act(async () => {
            await manager().cancel(id);
            await pending;
        });
        const runs = tab().runs;
        expect(host.called('query.cancel')).toEqual([{ queryId: runs[1]!.runId }]);
        expect(runs.map((r) => r.snapshot?.state)).toEqual(['done', 'cancelled']);
        // The third statement never started, and the first result is intact.
        expect(runs).toHaveLength(2);
        expect(runs[0]?.snapshot?.results[0]?.rowCount).toBe(1);
        expect(tab().running).toBe(false);
    });
});

describe('closing results', () => {
    const plans = {
        'SELECT 1': { columns: ['n'], rows: 1 },
        'SELECT 2': { columns: ['n'], rows: 2 },
        'SELECT 3': { columns: ['n'], rows: 3 },
        'SELECT 4': { columns: ['n'], rows: 4 },
    };
    const script = Object.keys(plans).join('; ');
    const indexes = (tab: () => { runs: { index: number }[] }) => tab().runs.map((r) => r.index);

    it('closes one result and releases only its query', async () => {
        const { tab, run, host, manager, id } = await open(plans);
        await run(script);
        const ids = tab().runs.map((r) => r.runId);
        await act(async () => manager().closeResults(id, 'self', 1));
        expect(indexes(tab)).toEqual([0, 2, 3]);
        expect(host.called('query.close')).toEqual([{ queryId: ids[1] }]);
        // The other results are untouched.
        expect(tab().runs.map((r) => r.snapshot?.results[0]?.rowCount)).toEqual([1, 3, 4]);
    });

    it('closes the others, to the left, to the right and all', async () => {
        const { tab, run, manager, id } = await open(plans);
        await run(script);
        await act(async () => manager().closeResults(id, 'left', 2));
        expect(indexes(tab)).toEqual([2, 3]);
        await act(async () => manager().closeResults(id, 'right', 2));
        expect(indexes(tab)).toEqual([2]);

        await run(script);
        await act(async () => manager().closeResults(id, 'others', 1));
        expect(indexes(tab)).toEqual([1]);
        expect(tab().activeRun).toBe(1);
        await act(async () => manager().closeResults(id, 'all', 1));
        expect(indexes(tab)).toEqual([]);
        expect(tab().activeRun).toBeNull();
    });

    it('shows the neighbour when the shown result is closed, and numbers never shift', async () => {
        const { tab, run, manager, id } = await open(plans);
        await run(script);
        act(() => manager().setResult(id, 1));
        await act(async () => manager().closeResults(id, 'self', 1));
        expect(tab().activeRun).toBe(2);
        expect(tab().runs.map((r) => runTitle(r))).toEqual(['Result 1', 'Result 3', 'Result 4']);
    });

    it('releases every result when the query tab closes', async () => {
        const { tab, run, host, manager, id } = await open(plans);
        await run(script);
        const ids = tab().runs.map((r) => r.runId);
        await act(async () => manager().closeQuery(id));
        expect(host.called('query.close').map((p) => p.queryId)).toEqual(ids);
        expect(useQueries.getState().tabs[id]).toBeUndefined();
    });

    it('remembers where each grid was left, per result', async () => {
        const { tab, run, manager, id } = await open(plans);
        await run(script);
        act(() =>
            manager().setResultView(id, 0, { scrollTop: 480, selected: { row: 3, column: 0 } }),
        );
        act(() => manager().setResultView(id, 2, { scrollTop: 24, selected: null }));
        expect(tab().runs.map((r) => r.view)).toEqual([
            { scrollTop: 480, selected: { row: 3, column: 0 } },
            { scrollTop: 0, selected: null },
            { scrollTop: 24, selected: null },
            { scrollTop: 0, selected: null },
        ]);
    });
});
