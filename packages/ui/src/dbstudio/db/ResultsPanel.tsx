/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { IconAlertTriangle, IconCheck, IconPlayerStop, IconX } from '@tabler/icons-react';
import { useState } from 'react';
import { Button, Loader, TabBar, Text, Tooltip, UnstyledButton, cx } from '../../kit';
import { CloseTabsMenu } from '../tabs/CloseTabsMenu';
import { ResultGrid } from './ResultGrid';
import type { QueryTab } from './queryStore';
import {
    activeRunOf,
    isPartial,
    resultOfRun,
    returnsRows,
    runState,
    runSummary,
    runTitle,
    type RunState,
    type StatementRun,
} from './resultSession';
import { useDbManager } from './useDbManager';

const NOUN = { one: 'Result', many: 'Results' } as const;

function StateIcon({ state }: { state: RunState }) {
    if (state === 'running') return <Loader size={11} />;
    if (state === 'error')
        return <IconAlertTriangle size={12} className="text-danger-text" aria-label="Failed" />;
    if (state === 'stopped')
        return <IconPlayerStop size={12} className="text-warning-text" aria-label="Stopped" />;
    return <IconCheck size={12} className="text-success-text" aria-label="Succeeded" />;
}

/**
 * The results of the last execution: one tab per statement, in order, each independent of the
 * others. Switching tabs shows a result that is already there (nothing runs again); closing one
 * releases only its own host query. A single statement has no strip, only its header.
 */
export function ResultsPanel({ tab }: { tab: QueryTab }) {
    const manager = useDbManager();
    const run = activeRunOf(tab.runs, tab.activeRun);
    const [menu, setMenu] = useState<{ id: number; x: number; y: number } | null>(null);

    if (!run) {
        return (
            <Text size="sm" className="p-3 text-dimmed">
                {tab.running ? 'Running…' : 'Run a statement to see its result here.'}
            </Text>
        );
    }
    const many = tab.runs.length > 1;

    return (
        <div className="flex h-full min-h-0 flex-col">
            {many && (
                <TabBar
                    label="Results"
                    noun="results"
                    className="h-8"
                    activeId={String(run.index)}
                    onSelect={(id) => manager.setResult(tab.id, Number(id))}
                    items={tab.runs.map((item) => ({
                        id: String(item.index),
                        title: `${runTitle(item)} — ${item.sql}`,
                        subtitle: runSummary(item),
                    }))}
                >
                    {tab.runs.map((item) => (
                        <ResultTab
                            key={item.runId}
                            run={item}
                            selected={item.index === run.index}
                            onSelect={() => manager.setResult(tab.id, item.index)}
                            onClose={() => void manager.closeResults(tab.id, 'self', item.index)}
                            onContextMenu={(x, y) => {
                                manager.setResult(tab.id, item.index);
                                setMenu({ id: item.index, x, y });
                            }}
                        />
                    ))}
                </TabBar>
            )}
            <ResultHeader run={run} />
            <div className="min-h-0 flex-1">
                <ResultPane tab={tab} run={run} />
            </div>
            <CloseTabsMenu
                point={menu}
                targetId={menu ? String(menu.id) : null}
                tabs={tab.runs.map((item) => ({ id: String(item.index), pinned: false }))}
                noun={NOUN}
                ariaLabel="Result actions"
                onClose={() => setMenu(null)}
                onCloseTabs={(_ids, mode) => {
                    if (menu) void manager.closeResults(tab.id, mode, menu.id);
                }}
            />
        </div>
    );
}

function ResultTab({
    run,
    selected,
    onSelect,
    onClose,
    onContextMenu,
}: {
    run: StatementRun;
    selected: boolean;
    onSelect: () => void;
    onClose: () => void;
    onContextMenu: (x: number, y: number) => void;
}) {
    const state = runState(run);
    return (
        <div
            role="presentation"
            onContextMenu={(event) => {
                event.preventDefault();
                onContextMenu(event.clientX, event.clientY);
            }}
            className={cx(
                'group flex max-w-[16rem] flex-none items-center gap-1.5 border-r border-line pr-1 pl-2.5',
                selected ? 'bg-surface' : 'hover:bg-hover',
            )}
        >
            <Tooltip label={`${runTitle(run)} — ${run.sql} · ${runSummary(run)}`}>
                <UnstyledButton
                    role="tab"
                    aria-selected={selected}
                    tabIndex={selected ? 0 : -1}
                    className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-xs"
                    onClick={onSelect}
                    onAuxClick={(event) => event.button === 1 && onClose()}
                >
                    <StateIcon state={state} />
                    <span className="flex-none font-medium">{runTitle(run)}</span>
                    <span className="truncate text-[11px] text-dimmed">{run.kind}</span>
                </UnstyledButton>
            </Tooltip>
            <Tooltip label="Close result">
                <UnstyledButton
                    aria-label={`Close ${runTitle(run)}`}
                    className="grid size-4 flex-none place-items-center rounded-sm text-dimmed hover:bg-chrome-hover hover:text-fg"
                    onClick={onClose}
                >
                    <IconX size={11} />
                </UnstyledButton>
            </Tooltip>
        </div>
    );
}

/** `Result 2 — SELECT * FROM roles` and `18 rows · 13 ms`: what the shown statement is and did. */
function ResultHeader({ run }: { run: StatementRun }) {
    const state = runState(run);
    return (
        <div className="flex h-7 flex-none items-center gap-2 border-b border-line/60 px-3 text-xs">
            <StateIcon state={state} />
            <span className="flex-none font-medium">{runTitle(run)}</span>
            <span className="min-w-0 flex-1 truncate font-mono text-dimmed" title={run.sql}>
                {run.sql}
            </span>
            <span
                className={cx(
                    'flex-none tabular-nums',
                    state === 'error' ? 'text-danger-text' : 'text-dimmed',
                )}
            >
                {runSummary(run)}
            </span>
        </div>
    );
}

function ResultPane({ tab, run }: { tab: QueryTab; run: StatementRun }) {
    const manager = useDbManager();
    const snapshot = run.snapshot;
    const result = resultOfRun(run);

    if (!snapshot) {
        return (
            <Text size="sm" className="p-3 text-dimmed">
                Running…
            </Text>
        );
    }
    if (snapshot.state === 'failed') {
        return (
            <div role="alert" className="m-3 rounded-sm border border-danger/40 bg-danger-soft p-3">
                <Text size="sm" className="font-medium text-danger-text">
                    {snapshot.error?.message ?? 'The statement failed.'}
                </Text>
                {snapshot.error?.code && (
                    <Text size="xs" className="mt-1 text-dimmed">
                        {snapshot.error.code}
                    </Text>
                )}
            </div>
        );
    }
    if (!result) {
        return (
            <Text size="sm" className="p-3 text-dimmed">
                {snapshot.state === 'running' ? 'Running…' : 'The statement returned nothing.'}
            </Text>
        );
    }
    if (!returnsRows(run) || result.columns.length === 0) {
        return (
            <div className="p-3">
                <Text size="sm">
                    <span className="font-medium">{run.kind}</span>
                    {' · '}
                    {result.affectedRows !== undefined
                        ? `${result.affectedRows.toLocaleString('en-US')} row${result.affectedRows === 1 ? '' : 's'} affected`
                        : 'The statement ran and returned no rows'}
                </Text>
                {result.info && (
                    <Text size="xs" className="mt-1 text-dimmed">
                        {result.info}
                    </Text>
                )}
                {result.insertId && (
                    <Text size="xs" className="mt-1 text-dimmed">
                        Last insert id {result.insertId}
                    </Text>
                )}
                {!!result.warnings && (
                    <Text size="xs" className="mt-1 text-warning-text">
                        {result.warnings} warning{result.warnings === 1 ? '' : 's'}
                    </Text>
                )}
            </div>
        );
    }

    return (
        <div className="flex h-full flex-col">
            {snapshot.results.length > 1 && (
                <div className="flex flex-none gap-1 border-b border-line px-2 py-1">
                    {snapshot.results.map((item, index) => (
                        <UnstyledButton
                            key={item.index}
                            className={cx(
                                'rounded-sm px-2 py-0.5 text-xs',
                                index === run.resultIndex ? 'bg-primary-soft' : 'hover:bg-hover',
                            )}
                            onClick={() => manager.setResult(tab.id, run.index, index)}
                        >
                            Set {index + 1}
                        </UnstyledButton>
                    ))}
                </div>
            )}
            <div className="min-h-0 flex-1">
                {manager.db && (
                    <ResultGrid
                        // One grid per statement and result set: its own pages, scroll and selection.
                        key={`${run.runId}:${result.index}`}
                        api={manager.db}
                        runId={run.runId}
                        result={result}
                        view={run.view}
                        onView={(view) => manager.setResultView(tab.id, run.index, view)}
                        onDemand={(rows) => manager.demand(tab.id, run.index, rows)}
                    />
                )}
            </div>
            {snapshot.paused && !result.complete && (
                <div className="flex flex-none items-center gap-2 border-t border-line px-3 py-1 text-xs text-dimmed">
                    The server has more rows; they are read as you scroll.
                    <Button
                        size="compact-xs"
                        variant="subtle"
                        onClick={() => manager.fetchAll(tab.id, run.index)}
                    >
                        Load all
                    </Button>
                </div>
            )}
            {isPartial(run) && run.truncated && (
                <div className="flex-none border-t border-line px-3 py-1 text-xs text-dimmed">
                    Only the first {result.rowCount.toLocaleString('en-US')} rows were read before
                    the next statement ran. Run this statement alone to page through all of it.
                </div>
            )}
        </div>
    );
}
