/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import type { DbQuerySnapshot, DbResultInfo } from '@httpreq/shared';
import { formatDuration } from '../../format';
import { closeTargets, nextActive, type CloseMode } from '../tabs/tabCommands';

/**
 * The results of one execution, as a session: every statement a run produced keeps its own entry
 * (its host query, its metadata, its view state) so a "Run all" of several statements shows each
 * outcome in order, and none replaces another. These are pure functions over that session, so the
 * rules can be tested without a window or a database.
 */

/** What the grid of one result remembers, so switching tabs and coming back is seamless. */
export interface ResultViewState {
    scrollTop: number;
    selected: { row: number; column: number } | null;
}

export const emptyView = (): ResultViewState => ({ scrollTop: 0, selected: null });

/** One executed statement and its outcome. */
export interface StatementRun {
    /** The statement's number in its execution, from 0. Stable: closing a result never renumbers. */
    index: number;
    /** The host's id for the statement; the grid reads pages with it. */
    runId: string;
    /** The beginning of the statement, one line. */
    sql: string;
    /** `SELECT`, `UPDATE`, `CALL`… */
    kind: string;
    snapshot: DbQuerySnapshot | null;
    /** Which result set of the statement is shown (a `CALL` may return several). */
    resultIndex: number;
    view: ResultViewState;
    /**
     * The statement was followed by another and its rows were read only up to the run-all limit,
     * then the host released the cursor. The rows that are in remain readable.
     */
    truncated?: boolean;
}

const WORD = /^[\s(]*([A-Za-z]+)/;

/** The leading verb of a statement; comments are skipped. */
export const statementKind = (sql: string): string => {
    const text = sql.replace(/^(?:\s+|--[^\n]*\n?|#[^\n]*\n?|\/\*[\s\S]*?\*\/)+/, '').trimStart();
    const word = WORD.exec(text)?.[1]?.toUpperCase();
    if (!word) return 'STATEMENT';
    return word === 'WITH' ? 'SELECT' : word;
};

/** The statement has not finished: no snapshot yet, or one still running. */
export const isRunning = (run: StatementRun): boolean =>
    !run.snapshot || run.snapshot.state === 'running';

/** The index of the last element satisfying the test, or -1. */
export const lastIndexWhere = <T>(items: readonly T[], test: (item: T) => boolean): number => {
    for (let index = items.length - 1; index >= 0; index--) if (test(items[index]!)) return index;
    return -1;
};

/** A statement that returns rows shows a grid; the others report what they changed. */
export const returnsRows = (run: StatementRun): boolean =>
    (run.snapshot?.results.some((result) => result.columns.length > 0) ?? false) ||
    (!run.snapshot &&
        ['SELECT', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN', 'VALUES', 'TABLE'].includes(run.kind));

export const activeRunOf = (
    runs: readonly StatementRun[],
    active: number | null,
): StatementRun | null => runs.find((run) => run.index === active) ?? null;

/** The result set of a run that its grid shows. */
export const resultOfRun = (run: StatementRun | null): DbResultInfo | null =>
    run?.snapshot?.results[run.resultIndex] ?? null;

/** `Result 2` for a statement that returns rows, `Statement 3` for the rest. */
export const runTitle = (run: StatementRun): string =>
    `${returnsRows(run) ? 'Result' : 'Statement'} ${run.index + 1}`;

const COUNT = new Intl.NumberFormat('en-US');
const plural = (n: number, noun: string) => `${COUNT.format(n)} ${noun}${n === 1 ? '' : 's'}`;

/** `250 rows · 92 ms`, `1 row affected · 12 ms`, `Failed`, `Running…`. */
export const runSummary = (run: StatementRun): string => {
    const snapshot = run.snapshot;
    if (!snapshot) return 'Running…';
    const time = formatDuration(snapshot.elapsedMs);
    if (snapshot.state === 'failed') return `Failed · ${time}`;
    const result = resultOfRun(run);
    if (run.truncated && result?.columns.length)
        return `First ${plural(result.rowCount, 'row')} · ${time}`;
    if (snapshot.state === 'cancelled')
        return result?.columns.length
            ? `Stopped · ${plural(result.rowCount, 'row')} read · ${time}`
            : `Stopped · ${time}`;
    if (!result) return time;
    if (result.columns.length) {
        const rows = plural(result.rowCount, 'row');
        const partial = !result.complete ? (snapshot.state === 'running' ? ' so far' : '+') : '';
        return `${rows}${partial} · ${time}`;
    }
    if (result.affectedRows !== undefined)
        return `${plural(result.affectedRows, 'row')} affected · ${time}`;
    return `${result.info ?? 'OK'} · ${time}`;
};

export type RunState = 'running' | 'success' | 'error' | 'stopped';

export const runState = (run: StatementRun): RunState => {
    const state = run.snapshot?.state;
    if (!state || state === 'running') return 'running';
    if (run.truncated) return 'success';
    return state === 'failed' ? 'error' : state === 'cancelled' ? 'stopped' : 'success';
};

/** Whether a stopped row result holds fewer rows than the statement produced. */
export const isPartial = (run: StatementRun): boolean => {
    const result = resultOfRun(run);
    return (
        !!result &&
        result.columns.length > 0 &&
        !result.complete &&
        run.snapshot?.state !== 'running'
    );
};

/* ---------- Closing ---------- */

export type ResultCloseMode = CloseMode;

/** The statement numbers a close command closes. */
export const closeRunTargets = (
    runs: readonly StatementRun[],
    index: number,
    mode: ResultCloseMode,
): number[] =>
    closeTargets(
        runs.map((run) => ({ id: String(run.index), pinned: false })),
        String(index),
        mode,
    ).map(Number);

/** The runs left after closing some, and the one to show (the neighbour of the shown one). */
export const afterClosing = (
    runs: readonly StatementRun[],
    active: number | null,
    closing: readonly number[],
): { runs: StatementRun[]; active: number | null } => {
    const gone = new Set(closing.map(String));
    const order = runs.map((run) => String(run.index));
    const next = nextActive(order, gone, active === null ? null : String(active));
    return {
        runs: runs.filter((run) => !gone.has(String(run.index))),
        active: next === null ? null : Number(next),
    };
};
