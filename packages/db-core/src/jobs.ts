/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import type { DbErrorInfo } from './errors';

/**
 * Anything long-running (indexing a file, searching it, executing a script, importing) is a job
 * with one lifecycle, so the UI shows progress and cancellation the same way for all of them.
 */
export type JobKind = 'index' | 'search' | 'query' | 'script' | 'import' | 'export';

export type JobState = 'queued' | 'running' | 'paused' | 'done' | 'failed' | 'cancelled';

export interface JobProgress {
    /** Units completed (bytes, rows, statements: the job kind decides). */
    done: number;
    /** Total units when known up front; absent for open-ended work such as a cursor. */
    total?: number;
}

export interface JobSnapshot {
    id: string;
    kind: JobKind;
    state: JobState;
    progress: JobProgress;
    error?: DbErrorInfo;
}

const TERMINAL: ReadonlySet<JobState> = new Set(['done', 'failed', 'cancelled']);

export const isTerminalJobState = (state: JobState): boolean => TERMINAL.has(state);
