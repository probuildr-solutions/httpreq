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
import { canRetryTask, retryTask } from './taskRetry';
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

const TYPE_TEXT: Record<DbTaskSnapshot['type'], string> = {
    export: 'Export',
    import: 'Import',
    script: 'Script',
    backup: 'Backup',
    restore: 'Restore',
    'bulk-update': 'Bulk update',
    index: 'Index',
    query: 'Query',
    parse: 'Parse',
};

const CLOCK = new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
});

/**
 * The button in the tab strip and the popover anchored to it: every background task with its
 * type, state, progress, times and actions. Closing the popover does not touch a task; they run in
 * the database host. Each row has a fixed layout (a one-line title, a slim bar, one line of numbers
 * and one of times), so progress changing several times a second moves nothing around it.
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
    const finished = list.filter(isFinalTask);

    return (
        <Popover
            opened={open}
            onClose={() => setTaskCenterOpen(false)}
            position="bottom-end"
            width={420}
            closeOnClickOutside
        >
            {/* The tooltip wraps the target, not the other way round: the popover's anchor has to
                be the button itself, or the panel is positioned from the corner of the window. */}
            <Tooltip label="Background tasks">
                <Popover.Target>
                    <ActionIcon
                        size={24}
                        variant="subtle"
                        aria-label={`Background tasks${running ? `, ${running} running` : ''}`}
                        aria-expanded={open}
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
                </Popover.Target>
            </Tooltip>
            <Popover.Dropdown className="flex max-h-[min(560px,70vh)] flex-col overflow-hidden p-0">
                <section aria-label="Background tasks" className="flex min-h-0 flex-col">
                    <header className="flex h-9 flex-none items-center gap-2 border-b border-line px-3">
                        <Text size="sm" className="font-semibold">
                            Background Tasks
                        </Text>
                        {list.length > 0 && (
                            <span className="rounded-full bg-neutral-soft px-1.5 text-[11px] leading-4 text-dimmed tabular-nums">
                                {list.length}
                            </span>
                        )}
                        <span className="ml-auto" />
                        <Button
                            size="compact-xs"
                            variant="subtle"
                            disabled={finished.length === 0}
                            onClick={() => finished.forEach((t) => forgetTask(t.id))}
                        >
                            Clear completed
                        </Button>
                    </header>
                    <div className="min-h-0 flex-1 overflow-y-auto">
                        {list.length === 0 ? (
                            <div className="flex flex-col items-center gap-1 px-6 py-8 text-center">
                                <IconListCheck size={22} className="text-dimmed" aria-hidden />
                                <Text size="sm" className="font-medium">
                                    No active tasks
                                </Text>
                                <Text size="xs" className="text-dimmed">
                                    Imports, exports, backups, restores and scripts running in the
                                    background will appear here.
                                </Text>
                            </div>
                        ) : (
                            list.map((task) => <TaskRow key={task.id} task={task} />)
                        )}
                    </div>
                </section>
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
    const retryable = canRetryTask(task);
    const failure = task.error?.message ?? (task.state === 'FAILED' ? task.message : undefined);
    return (
        <div className="border-b border-line/60 px-3 py-2" data-task-state={task.state}>
            <div className="flex items-center gap-2">
                <span className="flex-none rounded-xs bg-neutral-soft px-1.5 text-[10px] leading-4 font-medium text-dimmed uppercase">
                    {TYPE_TEXT[task.type] ?? task.type}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm font-medium" title={task.name}>
                    {task.name}
                </span>
                <span className={cx('flex-none text-xs', STATE_COLOR[task.state])}>
                    {STATE_TEXT[task.state]}
                </span>
            </div>
            <div className="mt-0.5 truncate text-[11px] text-dimmed">
                {[
                    task.source && `from ${task.source}`,
                    task.destination && `to ${task.destination}`,
                    task.database,
                ]
                    .filter(Boolean)
                    .join(' · ') || ' '}
            </div>
            <Progress
                value={task.state === 'COMPLETED' ? 100 : (task.percent ?? 0)}
                className="my-1.5"
                aria-label={`${task.name} progress`}
            />
            <div className="flex h-4 items-center gap-2 text-[11px] text-dimmed tabular-nums">
                <span className="w-9 flex-none">
                    {task.state === 'COMPLETED' ? '100%' : known ? `${task.percent}%` : '…'}
                </span>
                <span className="min-w-0 flex-1 truncate">
                    {task.stage}
                    {task.rowsProcessed > 0 && ` · ${COUNT.format(task.rowsProcessed)} rows`}
                    {task.bytesProcessed > 0 &&
                        ` · ${formatSize(task.bytesProcessed)}${task.totalBytes ? ` of ${formatSize(task.totalBytes)}` : ''}`}
                </span>
            </div>
            <div className="flex h-4 items-center gap-2 text-[11px] text-dimmed tabular-nums">
                <span className="min-w-0 flex-1 truncate">
                    {task.startedAt ? `Started ${CLOCK.format(task.startedAt)}` : 'Not started'}
                </span>
                <span className="flex-none">
                    {final ? 'Took' : 'Elapsed'} {formatDuration(task.elapsedMs)}
                </span>
            </div>
            {failure && (
                <div
                    role="alert"
                    className="mt-1 rounded-xs border border-danger/40 bg-danger-soft px-2 py-1 text-xs break-words text-danger-text"
                >
                    {failure}
                </div>
            )}
            {!failure && task.message && (
                <Text size="xs" className="mt-1 break-words text-dimmed">
                    {task.message}
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
                {retryable && (
                    <Button
                        size="compact-xs"
                        variant="light"
                        onClick={() => db && void retryTask(db, task)}
                    >
                        Retry
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
                        {task.state === 'COMPLETED' ? 'Clear' : 'Remove'}
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
