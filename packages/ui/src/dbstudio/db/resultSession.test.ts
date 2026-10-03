/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import type { DbQuerySnapshot } from '@httpreq/shared';
import { describe, expect, it } from 'vitest';
import {
    afterClosing,
    closeRunTargets,
    emptyView,
    isPartial,
    returnsRows,
    runState,
    runSummary,
    runTitle,
    statementKind,
    type StatementRun,
} from './resultSession';

const snapshot = (
    patch: Partial<DbQuerySnapshot> & { rows?: number; affected?: number; columns?: number },
): DbQuerySnapshot => ({
    state: 'done',
    elapsedMs: 12,
    paused: false,
    results: [
        {
            index: 0,
            columns: Array.from({ length: patch.columns ?? 0 }, (_, i) => ({
                name: `c${i}`,
                type: 'int',
            })),
            rowCount: patch.rows ?? 0,
            complete: true,
            capped: false,
            ...(patch.affected !== undefined ? { affectedRows: patch.affected } : {}),
        },
    ],
    ...patch,
});

const run = (
    index: number,
    sql: string,
    snap: DbQuerySnapshot | null,
    extra: Partial<StatementRun> = {},
): StatementRun => ({
    index,
    runId: `r${index}`,
    sql,
    kind: statementKind(sql),
    snapshot: snap,
    resultIndex: 0,
    view: emptyView(),
    ...extra,
});

describe('statementKind', () => {
    it('reads the leading verb, past comments, and treats WITH as a query', () => {
        expect(statementKind('select 1')).toBe('SELECT');
        expect(statementKind('  -- note\n  UPDATE t SET a = 1')).toBe('UPDATE');
        expect(statementKind('/* x */ delete from t')).toBe('DELETE');
        expect(statementKind('(SELECT 1) UNION (SELECT 2)')).toBe('SELECT');
        expect(statementKind('WITH x AS (SELECT 1) SELECT * FROM x')).toBe('SELECT');
        expect(statementKind('')).toBe('STATEMENT');
    });
});

describe('titles and summaries', () => {
    const select = run(0, 'SELECT * FROM users', snapshot({ columns: 2, rows: 250 }));
    const update = run(1, 'UPDATE users SET a = 1', snapshot({ affected: 1 }));

    it('names a row-returning statement a Result and the others a Statement, by position', () => {
        expect(runTitle(select)).toBe('Result 1');
        expect(runTitle(update)).toBe('Statement 2');
        expect(returnsRows(select)).toBe(true);
        expect(returnsRows(update)).toBe(false);
    });

    it('summarises rows, affected rows, failure and progress', () => {
        expect(runSummary(select)).toBe('250 rows · 12 ms');
        expect(runSummary(update)).toBe('1 row affected · 12 ms');
        expect(runSummary(run(2, 'SELECT 1', snapshot({ columns: 1, rows: 1 })))).toBe(
            '1 row · 12 ms',
        );
        expect(runSummary(run(3, 'SELECT 1', null))).toBe('Running…');
        expect(runSummary(run(4, 'SELECT x', snapshot({ state: 'failed', results: [] })))).toBe(
            'Failed · 12 ms',
        );
    });

    it('says when only the first rows were read, or a statement was stopped', () => {
        const big = snapshot({ columns: 1, rows: 5000 });
        big.results[0]!.complete = false;
        expect(runSummary(run(0, 'SELECT 1', big, { truncated: true }))).toBe(
            'First 5,000 rows · 12 ms',
        );
        expect(
            runState(run(0, 'SELECT 1', { ...big, state: 'cancelled' }, { truncated: true })),
        ).toBe('success');
        const stopped = snapshot({ state: 'cancelled', columns: 1, rows: 10 });
        stopped.results[0]!.complete = false;
        expect(runSummary(run(0, 'SELECT 1', stopped))).toBe('Stopped · 10 rows read · 12 ms');
        expect(runState(run(0, 'SELECT 1', stopped))).toBe('stopped');
        expect(isPartial(run(0, 'SELECT 1', stopped))).toBe(true);
        expect(isPartial(select)).toBe(false);
    });
});

describe('closing results', () => {
    const runs = [0, 1, 2, 3].map((i) => run(i, `SELECT ${i}`, snapshot({ columns: 1, rows: i })));

    it('picks the statement numbers each command closes', () => {
        expect(closeRunTargets(runs, 2, 'self')).toEqual([2]);
        expect(closeRunTargets(runs, 2, 'left')).toEqual([0, 1]);
        expect(closeRunTargets(runs, 2, 'right')).toEqual([3]);
        expect(closeRunTargets(runs, 2, 'others')).toEqual([0, 1, 3]);
        expect(closeRunTargets(runs, 2, 'all')).toEqual([0, 1, 2, 3]);
        expect(closeRunTargets(runs, 9, 'all')).toEqual([]);
    });

    it('keeps the numbers of the rest and shows the neighbour of a closed shown result', () => {
        const left = afterClosing(runs, 2, [2]);
        expect(left.runs.map((r) => r.index)).toEqual([0, 1, 3]);
        expect(left.active).toBe(3);
        expect(afterClosing(runs, 1, [3]).active).toBe(1);
        expect(afterClosing(runs, 3, [0, 1, 2, 3])).toEqual({ runs: [], active: null });
    });
});
