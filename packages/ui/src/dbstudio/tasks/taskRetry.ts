/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import type {
    DbExportRequest,
    DbImportRequest,
    DbScriptTaskRequest,
    DbTaskSnapshot,
} from '@httpreq/shared';
import type { DbApi } from '../db/dbApi';
import { newTaskId, rememberTaskRequest, taskRequestOf } from './taskStore';

/** Whether a failed or cancelled task can be started again from the request it was started with. */
export const canRetryTask = (task: DbTaskSnapshot): boolean =>
    (task.state === 'FAILED' || task.state === 'CANCELLED') && taskRequestOf(task.id) !== undefined;

/**
 * Starts a task again as a new one, with the request the old one used. The old task stays in the
 * list until the user clears it, so what failed remains readable beside the retry.
 */
export async function retryTask(db: DbApi, task: DbTaskSnapshot): Promise<string | null> {
    const stored = taskRequestOf(task.id);
    if (!stored) return null;
    const taskId = newTaskId();
    switch (stored.op) {
        case 'export': {
            const request: DbExportRequest = { ...(stored.request as DbExportRequest), taskId };
            rememberTaskRequest(taskId, 'export', request);
            await db.startExport(request);
            return taskId;
        }
        case 'import': {
            // A fresh attempt, not a resume: the "Resume import" action continues from a checkpoint.
            const { resume: _resume, ...rest } = stored.request as DbImportRequest;
            void _resume;
            const request: DbImportRequest = { ...rest, taskId };
            rememberTaskRequest(taskId, 'import', request);
            await db.startImport(request);
            return taskId;
        }
        case 'script': {
            const request: DbScriptTaskRequest = {
                ...(stored.request as DbScriptTaskRequest),
                taskId,
            };
            rememberTaskRequest(taskId, 'script', request);
            await db.startScriptTask(request);
            return taskId;
        }
    }
}
