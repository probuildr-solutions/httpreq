/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import type {
    ColumnMeta,
    DbValue,
    ExecuteOptions,
    Execution,
    RelationalSession,
    ResultEvent,
    TaskContext,
} from '@httpreq/db-core';

/**
 * Test doubles for the transfer engine: a session that streams generated rows lazily (and counts
 * how far ahead of the consumer it ever got), and a task context that records what a runner
 * reported. The session produces nothing until it is asked, so a test of a million rows needs a
 * million rows of CPU but no memory, which is the property the engine is built on.
 */
export interface FakeStreamOptions {
    columns: ColumnMeta[];
    rowCount: number;
    row: (index: number) => DbValue[];
    pageRows?: number;
    /** Fail with this after this many rows, as a dropped connection would. */
    failAfter?: { rows: number; error: Error };
}

export class FakeSession {
    /** Rows produced so far, and the most pages that were ever produced but not yet consumed. */
    produced = 0;
    consumed = 0;
    maxAhead = 0;
    cancelled = false;
    statements: string[] = [];

    constructor(private readonly stream: FakeStreamOptions) {}

    execute(sql: string, options?: ExecuteOptions): Execution {
        this.statements.push(sql);
        const { stream } = this;
        const page = options?.pageRows ?? stream.pageRows ?? 1000;
        // eslint-disable-next-line @typescript-eslint/no-this-alias -- used inside the generator
        const self = this;
        const iterate = async function* (): AsyncGenerator<ResultEvent> {
            yield { kind: 'columns', columns: stream.columns };
            for (let start = 0; start < stream.rowCount; start += page) {
                if (self.cancelled) return;
                if (stream.failAfter && start >= stream.failAfter.rows)
                    throw stream.failAfter.error;
                const rows: DbValue[][] = [];
                for (let i = start; i < Math.min(stream.rowCount, start + page); i++)
                    rows.push(stream.row(i));
                self.produced += rows.length;
                self.maxAhead = Math.max(self.maxAhead, self.produced - self.consumed);
                yield { kind: 'rows', rows };
                self.consumed += rows.length;
                await Promise.resolve();
            }
            yield { kind: 'end', rowCount: stream.rowCount };
        };
        const generator = iterate();
        return {
            [Symbol.asyncIterator]: () => generator,
            cancel: async () => {
                this.cancelled = true;
            },
        };
    }

    asSession(): RelationalSession {
        return this as unknown as RelationalSession;
    }
}

export interface RecordedContext extends TaskContext {
    reports: Record<string, unknown>[];
    issues: { record?: number; statement?: number; line?: number; message: string }[];
    checkpoints: unknown[];
    abort: () => void;
}

export const recordingContext = (): RecordedContext => {
    const controller = new AbortController();
    const context: RecordedContext = {
        id: 't0',
        signal: controller.signal,
        reports: [],
        issues: [],
        checkpoints: [],
        report: (update) => void context.reports.push(update as Record<string, unknown>),
        issue: (issue) => void context.issues.push(issue),
        checkpoint: (value) => void context.checkpoints.push(value),
        waitIfPaused: () => Promise.resolve(),
        abort: () => controller.abort(),
    };
    return context;
};
