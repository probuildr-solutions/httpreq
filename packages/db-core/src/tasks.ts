/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { toDbError, type DbErrorInfo } from './errors';

/**
 * The background task system: one place that knows about everything long-running (an export, an
 * import, a dump being executed, an index being built), gives each the same lifecycle, and
 * reports progress at a pace a window can afford.
 *
 * A task is a runner function with a context. The runner does the work and calls `report` as it
 * goes; the manager owns the state machine
 *
 *     PENDING → RUNNING ⇄ PAUSED → COMPLETED
 *                  ↓         ↓
 *              CANCELLING → CANCELLED          (or FAILED from RUNNING)
 *
 * and turns the runner's reports into snapshots. Reports can come thousands of times a second; the
 * manager hands a listener at most one snapshot per task per `minIntervalMs` (plus one for every
 * change of state), so a window is never flooded however fast rows are processed.
 */

export type TaskType =
    | 'export'
    | 'import'
    | 'script'
    | 'backup'
    | 'restore'
    | 'bulk-update'
    | 'index'
    | 'query'
    | 'parse';

export type TaskState =
    'PENDING' | 'RUNNING' | 'PAUSED' | 'CANCELLING' | 'CANCELLED' | 'COMPLETED' | 'FAILED';

/** What a task is about, shown in the task center. None of it is a path. */
export interface TaskInfo {
    name: string;
    type: TaskType;
    /** Where the data comes from (a table, a file name, a query). */
    source?: string;
    /** Where it goes. */
    destination?: string;
    database?: string;
    /** The table or collection concerned. */
    target?: string;
    /** The file's name (never its directory). */
    file?: string;
    connectionId?: string;
    totalBytes?: number;
    totalRows?: number;
    /** Whether a failed or cancelled task can be started again from its checkpoint. */
    resumable?: boolean;
}

export interface TaskIssue {
    /** Record number (1-based) in the input, where the input has records. */
    record?: number;
    /** Statement number (1-based), for a script. */
    statement?: number;
    /** Approximate line number in the file. */
    line?: number;
    message: string;
}

export interface TaskSnapshot extends TaskInfo {
    id: string;
    state: TaskState;
    /** What the task is doing now: `Reading`, `Writing`, `Committing`… */
    stage: string;
    bytesProcessed: number;
    rowsProcessed: number;
    /** 0 to 100, or null when the total is not known. */
    percent: number | null;
    startedAt: number | null;
    endedAt: number | null;
    elapsedMs: number;
    errorCount: number;
    /** The first problems, up to a cap; `errorCount` counts all of them. */
    issues: TaskIssue[];
    message?: string;
    error?: DbErrorInfo;
    /** Where a resumed run would start; opaque to the window. */
    checkpoint?: unknown;
}

export interface ProgressUpdate {
    stage?: string;
    bytesProcessed?: number;
    rowsProcessed?: number;
    totalBytes?: number;
    totalRows?: number;
    message?: string;
}

export interface TaskContext {
    readonly id: string;
    /** Aborted when the task is cancelled. Pass it to anything that can be interrupted. */
    readonly signal: AbortSignal;
    report(update: ProgressUpdate): void;
    /** Records a problem that did not stop the task (a rejected row, a failed statement). */
    issue(issue: TaskIssue): void;
    /** Remembers where a resumed run would start. */
    checkpoint(value: unknown): void;
    /** Resolves at once while running; waits while the task is paused. */
    waitIfPaused(): Promise<void>;
}

export type TaskRunner = (context: TaskContext) => Promise<void | { message?: string }>;

export interface TaskManagerOptions {
    /** Tasks that run at once; the rest wait as PENDING. */
    maxConcurrent?: number;
    /** Least time between two snapshots of one task, state changes aside. */
    minIntervalMs?: number;
    /** Finished tasks kept for the task center. */
    keepFinished?: number;
    /** How long a cancelled task may take to stop before it is reported as cancelled anyway. */
    cancelGraceMs?: number;
    /** Most issues kept per task. */
    maxIssues?: number;
    now?: () => number;
}

interface Entry {
    snapshot: TaskSnapshot;
    runner: TaskRunner;
    abort: AbortController;
    paused: boolean;
    resumeWaiters: (() => void)[];
    lastEmit: number;
    timer?: ReturnType<typeof setTimeout>;
    graceTimer?: ReturnType<typeof setTimeout>;
    done?: Promise<void>;
}

const TERMINAL: ReadonlySet<TaskState> = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);
export const isTerminalTask = (state: TaskState): boolean => TERMINAL.has(state);

export class BackgroundTaskManager {
    private readonly entries = new Map<string, Entry>();
    private readonly listeners = new Set<(snapshot: TaskSnapshot) => void>();
    private counter = 0;
    private readonly options: Required<Omit<TaskManagerOptions, 'now'>> & { now: () => number };

    constructor(options: TaskManagerOptions = {}) {
        this.options = {
            maxConcurrent: options.maxConcurrent ?? 2,
            minIntervalMs: options.minIntervalMs ?? 250,
            keepFinished: options.keepFinished ?? 50,
            cancelGraceMs: options.cancelGraceMs ?? 15_000,
            maxIssues: options.maxIssues ?? 200,
            now: options.now ?? Date.now,
        };
    }

    onChange(listener: (snapshot: TaskSnapshot) => void): () => void {
        this.listeners.add(listener);
        return () => void this.listeners.delete(listener);
    }

    /** Queues a task. It starts at once if there is room, otherwise when another finishes. */
    submit(info: TaskInfo, runner: TaskRunner, id?: string): string {
        const taskId =
            id ??
            `t${(++this.counter).toString(16).padStart(8, '0')}${Math.floor(
                Math.random() * 0xffffffff,
            )
                .toString(16)
                .padStart(8, '0')}`;
        const entry: Entry = {
            snapshot: {
                ...info,
                id: taskId,
                state: 'PENDING',
                stage: 'Waiting',
                bytesProcessed: 0,
                rowsProcessed: 0,
                percent: null,
                startedAt: null,
                endedAt: null,
                elapsedMs: 0,
                errorCount: 0,
                issues: [],
            },
            runner,
            abort: new AbortController(),
            paused: false,
            resumeWaiters: [],
            lastEmit: 0,
        };
        this.entries.set(taskId, entry);
        this.emit(entry, true);
        this.pump();
        return taskId;
    }

    get(id: string): TaskSnapshot | undefined {
        const entry = this.entries.get(id);
        return entry ? this.view(entry) : undefined;
    }

    list(): TaskSnapshot[] {
        return [...this.entries.values()].map((entry) => this.view(entry));
    }

    /** Cancels a task: a waiting one at once, a running one by stopping its work. */
    cancel(id: string): void {
        const entry = this.entries.get(id);
        if (!entry) return;
        const { state } = entry.snapshot;
        if (isTerminalTask(state) || state === 'CANCELLING') return;
        if (state === 'PENDING') {
            this.finish(entry, 'CANCELLED', { message: 'Cancelled before it started.' });
            return;
        }
        entry.snapshot = { ...entry.snapshot, state: 'CANCELLING', stage: 'Stopping' };
        entry.abort.abort();
        this.wake(entry);
        this.emit(entry, true);
        // A runner that ignores the signal must not leave the task "stopping" for ever.
        entry.graceTimer = setTimeout(() => {
            if (!isTerminalTask(entry.snapshot.state))
                this.finish(entry, 'CANCELLED', { message: 'Stopped.' });
        }, this.options.cancelGraceMs);
        entry.graceTimer.unref?.();
    }

    pause(id: string): void {
        const entry = this.entries.get(id);
        if (!entry || entry.snapshot.state !== 'RUNNING') return;
        entry.paused = true;
        entry.snapshot = { ...entry.snapshot, state: 'PAUSED' };
        this.emit(entry, true);
    }

    resume(id: string): void {
        const entry = this.entries.get(id);
        if (!entry || entry.snapshot.state !== 'PAUSED') return;
        entry.paused = false;
        entry.snapshot = { ...entry.snapshot, state: 'RUNNING' };
        this.wake(entry);
        this.emit(entry, true);
    }

    /** Forgets a finished task. */
    remove(id: string): boolean {
        const entry = this.entries.get(id);
        if (!entry || !isTerminalTask(entry.snapshot.state)) return false;
        this.entries.delete(id);
        return true;
    }

    /** Waits for a task to reach a final state (tests, and shutdown). */
    async settled(id: string): Promise<TaskSnapshot | undefined> {
        await this.entries.get(id)?.done;
        return this.get(id);
    }

    /** Cancels everything and waits for it to stop. */
    async dispose(): Promise<void> {
        for (const id of this.entries.keys()) this.cancel(id);
        await Promise.all(
            [...this.entries.values()].map((entry) => entry.done?.catch(() => undefined)),
        );
        for (const entry of this.entries.values()) {
            clearTimeout(entry.timer);
            clearTimeout(entry.graceTimer);
        }
        this.listeners.clear();
    }

    /* ---------- Internals ---------- */

    private running(): number {
        let count = 0;
        for (const entry of this.entries.values()) {
            const { state } = entry.snapshot;
            if (state === 'RUNNING' || state === 'PAUSED' || state === 'CANCELLING') count++;
        }
        return count;
    }

    private pump(): void {
        for (const entry of this.entries.values()) {
            if (this.running() >= this.options.maxConcurrent) return;
            if (entry.snapshot.state === 'PENDING') this.start(entry);
        }
    }

    private start(entry: Entry): void {
        entry.snapshot = {
            ...entry.snapshot,
            state: 'RUNNING',
            stage: 'Starting',
            startedAt: this.options.now(),
        };
        this.emit(entry, true);
        const context: TaskContext = {
            id: entry.snapshot.id,
            signal: entry.abort.signal,
            report: (update) => this.report(entry, update),
            issue: (issue) => this.issue(entry, issue),
            checkpoint: (value) => {
                entry.snapshot = { ...entry.snapshot, checkpoint: value };
            },
            waitIfPaused: () =>
                entry.paused
                    ? new Promise<void>((resolve) => entry.resumeWaiters.push(resolve))
                    : Promise.resolve(),
        };
        entry.done = (async () => {
            try {
                const result = await entry.runner(context);
                if (isTerminalTask(entry.snapshot.state)) return;
                const cancelled = entry.abort.signal.aborted;
                this.finish(entry, cancelled ? 'CANCELLED' : 'COMPLETED', {
                    message: (result && result.message) || undefined,
                });
            } catch (error) {
                if (isTerminalTask(entry.snapshot.state)) return;
                const info = toDbError(error);
                if (entry.abort.signal.aborted || info.code === 'CANCELLED') {
                    this.finish(entry, 'CANCELLED', {});
                } else {
                    this.finish(entry, 'FAILED', { error: info.toInfo(), message: info.message });
                }
            }
        })();
    }

    private finish(
        entry: Entry,
        state: 'COMPLETED' | 'FAILED' | 'CANCELLED',
        extra: { message?: string; error?: DbErrorInfo },
    ): void {
        clearTimeout(entry.graceTimer);
        const now = this.options.now();
        entry.snapshot = {
            ...entry.snapshot,
            state,
            stage: state === 'COMPLETED' ? 'Done' : state === 'FAILED' ? 'Failed' : 'Cancelled',
            endedAt: now,
            percent: state === 'COMPLETED' ? 100 : entry.snapshot.percent,
            ...(extra.message !== undefined ? { message: extra.message } : {}),
            ...(extra.error ? { error: extra.error } : {}),
        };
        this.wake(entry);
        this.emit(entry, true);
        this.trim();
        this.pump();
    }

    /** Old finished tasks go, oldest first, so the list does not grow for ever. */
    private trim(): void {
        const finished = [...this.entries.values()].filter((e) => isTerminalTask(e.snapshot.state));
        for (const entry of finished.slice(
            0,
            Math.max(0, finished.length - this.options.keepFinished),
        ))
            this.entries.delete(entry.snapshot.id);
    }

    private wake(entry: Entry): void {
        const waiters = entry.resumeWaiters.splice(0);
        entry.paused = false;
        for (const resolve of waiters) resolve();
    }

    private report(entry: Entry, update: ProgressUpdate): void {
        if (isTerminalTask(entry.snapshot.state)) return;
        entry.snapshot = {
            ...entry.snapshot,
            ...(update.stage !== undefined ? { stage: update.stage } : {}),
            ...(update.bytesProcessed !== undefined
                ? { bytesProcessed: update.bytesProcessed }
                : {}),
            ...(update.rowsProcessed !== undefined ? { rowsProcessed: update.rowsProcessed } : {}),
            ...(update.totalBytes !== undefined ? { totalBytes: update.totalBytes } : {}),
            ...(update.totalRows !== undefined ? { totalRows: update.totalRows } : {}),
            ...(update.message !== undefined ? { message: update.message } : {}),
        };
        this.emit(entry, false);
    }

    private issue(entry: Entry, issue: TaskIssue): void {
        const { snapshot } = entry;
        entry.snapshot = {
            ...snapshot,
            errorCount: snapshot.errorCount + 1,
            issues:
                snapshot.issues.length < this.options.maxIssues
                    ? [...snapshot.issues, issue]
                    : snapshot.issues,
        };
        this.emit(entry, false);
    }

    private view(entry: Entry): TaskSnapshot {
        const { snapshot } = entry;
        const end = snapshot.endedAt ?? this.options.now();
        const total = snapshot.totalBytes ?? undefined;
        let percent = snapshot.percent;
        if (snapshot.state !== 'COMPLETED') {
            if (total && total > 0)
                percent = Math.min(99, Math.floor((snapshot.bytesProcessed / total) * 100));
            else if (snapshot.totalRows && snapshot.totalRows > 0)
                percent = Math.min(
                    99,
                    Math.floor((snapshot.rowsProcessed / snapshot.totalRows) * 100),
                );
        }
        return {
            ...snapshot,
            percent,
            elapsedMs: snapshot.startedAt === null ? 0 : Math.max(0, end - snapshot.startedAt),
        };
    }

    /** Delivers a snapshot now (a state change) or at most once per interval (progress). */
    private emit(entry: Entry, immediate: boolean): void {
        const now = this.options.now();
        const due = entry.lastEmit + this.options.minIntervalMs;
        if (immediate || now >= due) {
            clearTimeout(entry.timer);
            entry.timer = undefined;
            entry.lastEmit = now;
            const snapshot = this.view(entry);
            for (const listener of this.listeners) listener(snapshot);
            return;
        }
        if (entry.timer) return;
        // The newest numbers go out when the interval ends.
        entry.timer = setTimeout(() => {
            entry.timer = undefined;
            this.emit(entry, true);
        }, due - now);
        entry.timer.unref?.();
    }
}
