/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { IconDatabase, IconFileText, IconPlus, IconX } from '@tabler/icons-react';
import { formatSize } from '../format';
import { Button, Text, Tooltip, UnstyledButton, cx } from '../kit';
import { QueryTab } from './db/QueryTab';
import { isQueryTabId, useQueries } from './db/queryStore';
import { useDbManager } from './db/useDbManager';
import { FileEditorTab } from './FileEditorTab';
import { activeTab, isDirty, useStudioStore } from './studioStore';
import { useDbStudio } from './useDbStudio';

/**
 * The main area while Database Studio is open: its own tab strip (one tab per open file for now,
 * query and collection tabs later) and the active tab's editor. It takes the place of the request
 * area without touching it, so the HTTP tabs, terminals and sockets keep running underneath.
 */
export function StudioWorkspace() {
    const api = useDbStudio();
    const order = useStudioStore((state) => state.order);
    const tabs = useStudioStore((state) => state.tabs);
    const active = useStudioStore(activeTab);
    const opening = useStudioStore((state) => state.opening);
    const manager = useDbManager();
    const queries = useQueries((state) => state.tabs);
    const activeId = useStudioStore((state) => state.activeId);
    const activeQuery = activeId && isQueryTabId(activeId) ? queries[activeId] : undefined;

    return (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="studio-workspace">
            <div
                role="tablist"
                aria-label="Open tabs"
                className="flex h-[var(--hr-strip-height)] flex-none items-stretch overflow-x-auto border-b border-line bg-chrome"
            >
                {order.map((id) => {
                    const query = queries[id];
                    if (query) {
                        const selectedQuery = id === activeId;
                        return (
                            <div
                                key={id}
                                className={cx(
                                    'group flex max-w-[16rem] flex-none items-center gap-1.5 border-r border-line pl-3 pr-1',
                                    selectedQuery ? 'bg-surface' : 'hover:bg-hover',
                                )}
                            >
                                <UnstyledButton
                                    role="tab"
                                    aria-selected={selectedQuery}
                                    className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-sm"
                                    onClick={() => api.activateTab(id)}
                                >
                                    <IconDatabase size={14} className="flex-none text-dimmed" />
                                    <span className="truncate">{query.title}</span>
                                    {query.running && (
                                        <span
                                            aria-label="Running"
                                            className="size-1.5 flex-none animate-pulse rounded-full bg-primary"
                                        />
                                    )}
                                </UnstyledButton>
                                <Tooltip label="Close">
                                    <UnstyledButton
                                        aria-label={`Close ${query.title}`}
                                        className="grid size-5 flex-none place-items-center rounded-sm text-dimmed hover:bg-chrome-hover hover:text-fg"
                                        onClick={() => void manager.closeQuery(id)}
                                    >
                                        <IconX size={13} />
                                    </UnstyledButton>
                                </Tooltip>
                            </div>
                        );
                    }
                    const tab = tabs[id];
                    if (!tab) return null;
                    const selected = id === active?.id;
                    return (
                        <div
                            key={id}
                            className={cx(
                                'group flex max-w-[16rem] flex-none items-center gap-1.5 border-r border-line pl-3 pr-1',
                                selected ? 'bg-surface' : 'hover:bg-hover',
                            )}
                        >
                            <UnstyledButton
                                role="tab"
                                aria-selected={selected}
                                className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-sm"
                                onClick={() => api.activateTab(id)}
                                title={`${tab.file.name} · ${formatSize(tab.file.size)}`}
                            >
                                <IconFileText size={14} className="flex-none text-dimmed" />
                                <span className="truncate">{tab.file.name}</span>
                                {isDirty(tab) && (
                                    <span
                                        aria-label="Unsaved changes"
                                        className="size-1.5 flex-none rounded-full bg-primary"
                                    />
                                )}
                            </UnstyledButton>
                            <Tooltip label="Close">
                                <UnstyledButton
                                    aria-label={`Close ${tab.file.name}`}
                                    className="grid size-5 flex-none place-items-center rounded-sm text-dimmed hover:bg-chrome-hover hover:text-fg"
                                    onClick={() => void api.closeTab(id)}
                                >
                                    <IconX size={13} />
                                </UnstyledButton>
                            </Tooltip>
                        </div>
                    );
                })}
                {manager.available && (
                    <Tooltip label="New query">
                        <UnstyledButton
                            aria-label="New query"
                            className="grid w-8 flex-none place-items-center text-dimmed hover:bg-chrome-hover hover:text-fg"
                            onClick={() => manager.newQuery(null)}
                        >
                            <IconDatabase size={15} />
                        </UnstyledButton>
                    </Tooltip>
                )}
                <Tooltip label="Open a file">
                    <UnstyledButton
                        aria-label="Open a file"
                        className="grid w-8 flex-none place-items-center text-dimmed hover:bg-chrome-hover hover:text-fg"
                        onClick={() => void api.openFile()}
                        disabled={opening}
                    >
                        <IconPlus size={15} />
                    </UnstyledButton>
                </Tooltip>
            </div>

            {activeQuery ? (
                <QueryTab key={activeQuery.id} id={activeQuery.id} />
            ) : active ? (
                <FileEditorTab key={active.id} tab={active} />
            ) : (
                <div className="grid flex-1 place-items-center p-8 text-center">
                    <div>
                        <Text size="sm" className="mb-3 text-dimmed">
                            Open a file to start.
                        </Text>
                        <Button
                            size="xs"
                            variant="light"
                            onClick={() => void api.openFile()}
                            loading={opening}
                        >
                            Open file…
                        </Button>
                    </div>
                </div>
            )}
        </div>
    );
}
