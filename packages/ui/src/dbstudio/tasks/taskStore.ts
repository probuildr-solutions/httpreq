/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { create } from 'zustand';
import { DB_TASK_FINAL_STATES, type DbTaskSnapshot } from '@httpreq/shared';

/**
 * What the window knows about background tasks: the latest snapshot of each, in the order they
 * started. The host sends at most a few snapshots per second per task; this store only keeps the
 * newest, so a task that runs for hours is one small object here.
 */
interface TaskState {
    tasks: Record<string, DbTaskSnapshot>;
    order: string[];
    /** Whether the task center is open. */
    open: boolean;
}

export const useTasks = create<TaskState>(() => ({ tasks: {}, order: [], open: false }));

export const resetTasks = () => useTasks.setState({ tasks: {}, order: [], open: false });

export const isFinalTask = (task: DbTaskSnapshot): boolean =>
    DB_TASK_FINAL_STATES.includes(task.state);

export const applyTaskSnapshot = (snapshot: DbTaskSnapshot) =>
    useTasks.setState((state) => ({
        tasks: { ...state.tasks, [snapshot.id]: snapshot },
        order: state.order.includes(snapshot.id) ? state.order : [...state.order, snapshot.id],
    }));

export const forgetTask = (id: string) =>
    useTasks.setState((state) => {
        const tasks = { ...state.tasks };
        delete tasks[id];
        return { tasks, order: state.order.filter((item) => item !== id) };
    });

/** The host stopped: every task still shown as running is failed, with the reason. */
export const markTasksLost = (reason: string) =>
    useTasks.setState((state) => {
        const tasks = { ...state.tasks };
        for (const [id, task] of Object.entries(tasks)) {
            if (isFinalTask(task)) continue;
            tasks[id] = {
                ...task,
                state: 'FAILED',
                stage: 'Failed',
                endedAt: Date.now(),
                message: reason,
                error: { code: 'WORKER_CRASHED', message: reason },
            };
        }
        return { tasks };
    });

export const setTaskCenterOpen = (open: boolean) => useTasks.setState({ open });

/** Tasks that have not finished. */
export const activeTasks = (state: TaskState): DbTaskSnapshot[] =>
    state.order.map((id) => state.tasks[id]!).filter((task) => !!task && !isFinalTask(task));

export const newTaskId = (): string =>
    Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) =>
        b.toString(16).padStart(2, '0'),
    ).join('');

/** The request each task was started with, so a failed or cancelled import can be resumed. */
const requests = new Map<string, { op: 'import' | 'export' | 'script'; request: unknown }>();
export const rememberTaskRequest = (
    id: string,
    op: 'import' | 'export' | 'script',
    request: unknown,
) => void requests.set(id, { op, request });
export const taskRequestOf = (id: string) => requests.get(id);
