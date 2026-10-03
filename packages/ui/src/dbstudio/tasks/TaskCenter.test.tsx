/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { DbTaskSnapshot } from '@httpreq/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatDuration } from '../../format';
import { DbManagerContext, type DbManagerApi } from '../db/useDbManager';
import { TaskCenter } from './TaskCenter';
import {
    applyTaskSnapshot,
    rememberTaskRequest,
    resetTasks,
    setTaskCenterOpen,
    useTasks,
} from './taskStore';

const task = (patch: Partial<DbTaskSnapshot> = {}): DbTaskSnapshot => ({
    id: 'task0001',
    name: 'Export users',
    type: 'export',
    state: 'RUNNING',
    stage: 'Writing rows',
    bytesProcessed: 2048,
    rowsProcessed: 1200,
    percent: 40,
    startedAt: new Date(2026, 0, 1, 14, 32, 10).getTime(),
    endedAt: null,
    elapsedMs: 65_000,
    errorCount: 0,
    issues: [],
    ...patch,
});

const db = {
    taskAction: vi.fn(async () => undefined),
    startExport: vi.fn(async () => ({ taskId: 'x' })),
    startImport: vi.fn(async () => ({ taskId: 'y' })),
};
const manager = { available: true, db } as unknown as DbManagerApi;

const renderCenter = () =>
    render(
        <DbManagerContext.Provider value={manager}>
            <TaskCenter />
        </DbManagerContext.Provider>,
    );
const openPanel = () => fireEvent.click(screen.getByRole('button', { name: /Background tasks/ }));

beforeEach(() => {
    resetTasks();
    vi.clearAllMocks();
});
afterEach(cleanup);

describe('the Background Tasks popup', () => {
    it('opens from its button as a popover and closes with Escape', async () => {
        renderCenter();
        expect(screen.queryByRole('dialog')).toBeNull();
        const button = screen.getByRole('button', { name: /Background tasks/ });
        fireEvent.click(button);
        const dialog = await screen.findByRole('dialog');
        expect(button.getAttribute('aria-expanded')).toBe('true');
        expect(within(dialog).getByRole('region', { name: 'Background tasks' })).toBeTruthy();
        fireEvent.keyDown(dialog, { key: 'Escape' });
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });

    it('is anchored to the button itself, not to a wrapper around it', () => {
        renderCenter();
        // The popover's reference is the button: it carries the popup relationship.
        const button = screen.getByRole('button', { name: /Background tasks/ });
        expect(button.getAttribute('aria-haspopup')).toBe('dialog');
        openPanel();
        const dialog = screen.getByRole('dialog');
        expect(dialog.id).toBeTruthy();
        expect(button.getAttribute('aria-controls')).toBe(dialog.id);
    });

    it('says what appears here when there are no tasks', () => {
        renderCenter();
        openPanel();
        const panel = screen.getByRole('region', { name: 'Background tasks' });
        expect(within(panel).getByText('Background Tasks')).toBeTruthy();
        expect(within(panel).getByText('No active tasks')).toBeTruthy();
        expect(
            within(panel).getByText(
                /Imports, exports, backups, restores and scripts running in the background/,
            ),
        ).toBeTruthy();
        expect(
            within(panel).getByRole('button', { name: 'Clear completed' }).hasAttribute('disabled'),
        ).toBe(true);
    });

    it('shows a running task with its type, progress, status, start time and elapsed time', () => {
        act(() => applyTaskSnapshot(task()));
        renderCenter();
        openPanel();
        const row = screen.getByText('Export users').closest('[data-task-state]') as HTMLElement;
        expect(row.getAttribute('data-task-state')).toBe('RUNNING');
        expect(within(row).getByText('Export')).toBeTruthy();
        expect(within(row).getByText('Running')).toBeTruthy();
        expect(within(row).getByText('40%')).toBeTruthy();
        expect(within(row).getByRole('progressbar').getAttribute('aria-valuenow')).toBe('40');
        expect(within(row).getByText(/Started 02:32:10|Started 14:32:10/)).toBeTruthy();
        expect(within(row).getByText(`Elapsed ${formatDuration(65_000)}`)).toBeTruthy();
        expect(within(row).getByText(/1,200 rows/)).toBeTruthy();
        // A running task can be paused or cancelled, not retried or cleared.
        fireEvent.click(within(row).getByRole('button', { name: 'Cancel' }));
        expect(db.taskAction).toHaveBeenCalledWith('cancel', 'task0001');
        expect(within(row).queryByRole('button', { name: 'Retry' })).toBeNull();
        expect(screen.getByRole('button', { name: /1 running/ })).toBeTruthy();
    });

    it('shows a failed task with its error and a Retry that starts the same export again', async () => {
        const request = { taskId: 'task0001', profileId: 'p', format: 'csv' };
        rememberTaskRequest('task0001', 'export', request);
        act(() =>
            applyTaskSnapshot(
                task({
                    state: 'FAILED',
                    percent: 12,
                    endedAt: Date.now(),
                    error: { code: 'IO', message: 'The disk is full' },
                }),
            ),
        );
        renderCenter();
        openPanel();
        const row = screen.getByText('Export users').closest('[data-task-state]') as HTMLElement;
        expect(within(row).getByRole('alert').textContent).toBe('The disk is full');
        expect(within(row).getByText('Failed')).toBeTruthy();
        expect(within(row).getByText(/Took/)).toBeTruthy();
        fireEvent.click(within(row).getByRole('button', { name: 'Retry' }));
        await waitFor(() => expect(db.startExport).toHaveBeenCalledTimes(1));
        const [started] = db.startExport.mock.calls[0] as unknown as [
            { taskId: string; format: string },
        ];
        expect(started.format).toBe('csv');
        // A new task id, so the failed one stays readable beside the retry.
        expect(started.taskId).not.toBe('task0001');
    });

    it('offers no Retry for a failed task it cannot restart', () => {
        act(() => applyTaskSnapshot(task({ id: 'nostored', state: 'FAILED', endedAt: 1 })));
        renderCenter();
        openPanel();
        expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
        expect(screen.getByRole('button', { name: 'Remove' })).toBeTruthy();
    });

    it('shows a completed task at 100% and clears finished tasks, leaving running ones', () => {
        act(() => {
            applyTaskSnapshot(
                task({
                    id: 'done0001',
                    name: 'Import orders',
                    type: 'import',
                    state: 'COMPLETED',
                    percent: 100,
                    endedAt: 2,
                }),
            );
            applyTaskSnapshot(task({ id: 'run00001', name: 'Backup shop', type: 'backup' }));
        });
        renderCenter();
        openPanel();
        const finished = screen
            .getByText('Import orders')
            .closest('[data-task-state]') as HTMLElement;
        expect(within(finished).getByText('Completed')).toBeTruthy();
        expect(within(finished).getByText('100%')).toBeTruthy();
        expect(within(finished).getByRole('button', { name: 'Clear' })).toBeTruthy();
        // The panel says how many there are; the newest task is first.
        const names = screen.getAllByText(/Import orders|Backup shop/).map((n) => n.textContent);
        expect(names).toEqual(['Backup shop', 'Import orders']);

        fireEvent.click(screen.getByRole('button', { name: 'Clear completed' }));
        expect(screen.queryByText('Import orders')).toBeNull();
        expect(screen.getByText('Backup shop')).toBeTruthy();
    });

    it('lists the problems of a task with errors on request', () => {
        act(() =>
            applyTaskSnapshot(
                task({
                    state: 'COMPLETED',
                    percent: 100,
                    errorCount: 2,
                    issues: [
                        { record: 3, message: 'Bad date' },
                        { statement: 9, message: 'Duplicate key' },
                    ],
                }),
            ),
        );
        renderCenter();
        openPanel();
        fireEvent.click(screen.getByRole('button', { name: '2 problems' }));
        expect(screen.getByText('Bad date')).toBeTruthy();
        expect(screen.getByText('Duplicate key')).toBeTruthy();
    });

    it('keeps tasks running when the popup is closed', async () => {
        act(() => applyTaskSnapshot(task()));
        renderCenter();
        openPanel();
        act(() => setTaskCenterOpen(false));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        // Closing sends nothing to the host: the task is unaffected and still counted.
        expect(db.taskAction).not.toHaveBeenCalled();
        expect(useTasks.getState().tasks['task0001']?.state).toBe('RUNNING');
        expect(screen.getByRole('button', { name: /1 running/ })).toBeTruthy();
    });
});
