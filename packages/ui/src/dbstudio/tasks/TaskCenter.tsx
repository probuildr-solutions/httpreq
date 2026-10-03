/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { IconListCheck } from '@tabler/icons-react';
import { useState } from 'react';
import type { DbImportRequest, DbTaskSnapshot } from '@httpreq/shared';
import { formatDuration, formatSize } from '../../format';
import { ActionIcon, Button, Popover, Progress, Text, Tooltip, cx } from '../../kit';
import { useDbManager } from '../db/useDbManager';
import {
    activeTasks,
    forgetTask,
    isFinalTask,
    newTaskId,
    rememberTaskRequest,
    setTaskCenterOpen,
    taskRequestOf,
    useTasks,
} from './taskStore';

const STATE_TEXT: Record<DbTaskSnapshot['state'], string> = {
    PENDING: 'Waiting',
    RUNNING: 'Running',
    PAUSED: 'Paused',
    CANCELLING: 'Stopping',
    CANCELLED: 'Cancelled',
    COMPLETED: 'Completed',
    FAILED: 'Failed',
};

const STATE_COLOR: Record<DbTaskSnapshot['state'], string> = {
    PENDING: 'text-dimmed',
    RUNNING: 'text-primary-text',
    PAUSED: 'text-warning-text',
    CANCELLING: 'text-warning-text',
    CANCELLED: 'text-dimmed',
    COMPLETED: 'text-success-text',
    FAILED: 'text-danger-text',
};

const COUNT = new Intl.NumberFormat('en-US');

/**
 * The button in the tab strip and the panel it opens: every background task with its state,
 * progress, counts and actions. The panel floats over the workbench, and each row has a fixed
 * layout (a one-line title, a fixed-height bar, one line of numbers), so progress changing several
 * times a second moves nothing, in the panel or in the editors beneath it.
 */
export function TaskCenter() {
    const open = useTasks((state) => state.open);
    const tasks = useTasks((state) => state.tasks);
    const order = useTasks((state) => state.order);
    const running = useTasks((state) => activeTasks(state).length);
    const list = [...order]
        .reverse()
        .map((id) => tasks[id]!)
        .filter(Boolean);

    return (
        <Popover
            opened={open}
            onClose={() => setTaskCenterOpen(false)}
            position="bottom-end"
            width={440}
        >
            <Popover.Target>
                <Tooltip label="Background tasks">
                    <ActionIcon
                        size="md"
                        variant="subtle"
                        aria-label={`Background tasks${running ? `, ${running} running` : ''}`}
                        onClick={() => setTaskCenterOpen(!open)}
                        className="relative mx-1 my-auto flex-none"
                    >
                        <IconListCheck size={16} />
                        {running > 0 && (
                            <span className="absolute -top-0.5 -right-0.5 grid min-w-3.5 place-items-center rounded-full bg-primary px-1 text-[9px] leading-3.5 font-semibold text-white">
                                {running}
                            </span>
                        )}
                    </ActionIcon>
                </Tooltip>
            </Popover.Target>
            <Popover.Dropdown className="max-h-[min(560px,70vh)] overflow-y-auto p-0">
                <div role="region" aria-label="Background tasks">
                    <div className="flex h-9 items-center border-b border-line px-3">
                        <Text size="sm" className="font-semibold">
                            Tasks
                        </Text>
                        <span className="ml-auto" />
                        {list.some(isFinalTask) && (
                            <Button
                                size="compact-xs"
                                variant="subtle"
                                onClick={() =>
                                    list.filter(isFinalTask).forEach((t) => forgetTask(t.id))
                                }
                            >
                                Clear finished
                            </Button>
                        )}
                    </div>
                    {list.length === 0 && (
                        <Text size="sm" className="p-4 text-dimmed">
                            No tasks. Exports, imports and script runs appear here and keep going
                            while you work.
                        </Text>
                    )}
                    {list.map((task) => (
                        <TaskRow key={task.id} task={task} />
                    ))}
                </div>
            </Popover.Dropdown>
        </Popover>
    );
}

function TaskRow({ task }: { task: DbTaskSnapshot }) {
    const manager = useDbManager();
    const [issues, setIssues] = useState(false);
    const final = isFinalTask(task);
    const { db } = manager;
    const act = (action: 'cancel' | 'pause' | 'resume' | 'remove') =>
        void db?.taskAction(action, task.id).then(() => action === 'remove' && forgetTask(task.id));

    const stored = taskRequestOf(task.id);
    const canResume =
        (task.state === 'FAILED' || task.state === 'CANCELLED') &&
        task.type === 'import' &&
        !!task.checkpoint &&
        stored?.op === 'import';
    const resume = async () => {
        if (!db || !stored) return;
        const id = newTaskId();
        const request: DbImportRequest = {
            ...(stored.request as DbImportRequest),
            taskId: id,
            resume: task.checkpoint,
            // Appending after the checkpoint: truncating again would delete what was imported.
            mode: 'append',
        };
        rememberTaskRequest(id, 'import', request);
        await db.startImport(request);
    };

    const known = task.percent !== null;
    return (
        <div className="border-b border-line/60 px-3 py-2" data-task-state={task.state}>
            <div className="flex items-baseline gap-2">
                <span className="min-w-0 flex-1 truncate text-sm font-medium" title={task.name}>
                    {task.name}
                </span>
                <span className={cx('flex-none text-xs', STATE_COLOR[task.state])}>
                    {STATE_TEXT[task.state]}
                </span>
            </div>
            <div className="truncate text-[11px] text-dimmed">
                {[
                    task.type,
                    task.source && `from ${task.source}`,
                    task.destination && `to ${task.destination}`,
                    task.database,
                ]
                    .filter(Boolean)
                    .join(' · ')}
            </div>
            <Progress
                value={task.state === 'COMPLETED' ? 100 : (task.percent ?? 0)}
                className="my-1.5"
                aria-label={`${task.name} progress`}
            />
            <div className="flex h-4 items-center gap-2 text-[11px] text-dimmed tabular-nums">
                <span className="w-9 flex-none">{known ? `${task.percent}%` : '…'}</span>
                <span className="min-w-0 flex-1 truncate">
                    {task.stage}
                    {task.rowsProcessed > 0 && ` · ${COUNT.format(task.rowsProcessed)} rows`}
                    {task.bytesProcessed > 0 &&
                        ` · ${formatSize(task.bytesProcessed)}${task.totalBytes ? ` of ${formatSize(task.totalBytes)}` : ''}`}
                </span>
                <span className="flex-none">{formatDuration(task.elapsedMs)}</span>
            </div>
            {(task.message || task.error) && (
                <Text
                    size="xs"
                    className={cx(
                        'mt-1 break-words',
                        task.state === 'FAILED' ? 'text-danger-text' : 'text-dimmed',
                    )}
                >
                    {task.error?.message ?? task.message}
                </Text>
            )}
            <div className="mt-1 flex items-center gap-1">
                {task.errorCount > 0 && (
                    <Button size="compact-xs" variant="subtle" onClick={() => setIssues((v) => !v)}>
                        {COUNT.format(task.errorCount)} problem{task.errorCount === 1 ? '' : 's'}
                    </Button>
                )}
                <span className="ml-auto" />
                {task.state === 'RUNNING' && (
                    <Button size="compact-xs" variant="subtle" onClick={() => act('pause')}>
                        Pause
                    </Button>
                )}
                {task.state === 'PAUSED' && (
                    <Button size="compact-xs" variant="subtle" onClick={() => act('resume')}>
                        Resume
                    </Button>
                )}
                {canResume && (
                    <Button size="compact-xs" variant="light" onClick={() => void resume()}>
                        Resume import
                    </Button>
                )}
                {!final && task.state !== 'CANCELLING' && (
                    <Button
                        size="compact-xs"
                        variant="subtle"
                        color="red"
                        onClick={() => act('cancel')}
                    >
                        Cancel
                    </Button>
                )}
                {final && (
                    <Button
                        size="compact-xs"
                        variant="subtle"
                        onClick={() =>
                            task.state === 'FAILED' && !db ? forgetTask(task.id) : act('remove')
                        }
                    >
                        Remove
                    </Button>
                )}
            </div>
            {issues && (
                <ul className="m-0 mt-1 max-h-40 list-none overflow-auto rounded-sm border border-line p-1 text-[11px]">
                    {task.issues.map((issue, index) => (
                        <li key={index} className="py-0.5">
                            <span className="text-dimmed">
                                {issue.record !== undefined &&
                                    `Record ${COUNT.format(issue.record)} `}
                                {issue.statement !== undefined &&
                                    `Statement ${COUNT.format(issue.statement)} `}
                                {issue.line !== undefined && `(line ${COUNT.format(issue.line)}) `}
                            </span>
                            {issue.message}
                        </li>
                    ))}
                    {task.errorCount > task.issues.length && (
                        <li className="py-0.5 text-dimmed">
                            …and {COUNT.format(task.errorCount - task.issues.length)} more.
                        </li>
                    )}
                </ul>
            )}
        </div>
    );
}
