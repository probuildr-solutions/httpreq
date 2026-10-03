/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { IconDatabase, IconFileText, IconX } from '@tabler/icons-react';
import { PanelHeader } from '../explorer/PanelHeader';
import { formatSize } from '../format';
import { Alert, Button, Text, UnstyledButton, cx } from '../kit';
import { PANEL } from '../ssh/styles';
import { ConnectionDialog } from './db/ConnectionDialog';
import { ConnectionsSection } from './db/ConnectionsSection';
import { useDbManager } from './db/useDbManager';
import { isDirty, useStudioStore } from './studioStore';
import { useDbStudio } from './useDbStudio';

/**
 * The Database Studio sidebar view: the files that are open, and a way to open another. The files
 * themselves are edited in the main area (`StudioWorkspace`); connections to databases will join
 * this list in their own section.
 */
export function DbStudioPanel() {
    const api = useDbStudio();
    const order = useStudioStore((state) => state.order);
    const tabs = useStudioStore((state) => state.tabs);
    const activeId = useStudioStore((state) => state.activeId);
    const error = useStudioStore((state) => state.error);
    const opening = useStudioStore((state) => state.opening);
    const host = useStudioStore((state) => state.host);
    const manager = useDbManager();

    return (
        <div className={PANEL}>
            <PanelHeader title="Database Studio" />

            <div className="min-h-0 flex-1 overflow-auto p-3">
                {!api.available ? (
                    <Text size="sm" className="text-dimmed">
                        Database Studio is part of the desktop app.
                    </Text>
                ) : (
                    <>
                        {manager.available && (
                            <>
                                <ConnectionsSection />
                                <ConnectionDialog />
                            </>
                        )}
                        <div className="mb-3 text-center">
                            {order.length === 0 && (
                                <>
                                    <IconDatabase
                                        size={28}
                                        stroke={1.4}
                                        className="mx-auto mb-2 text-dimmed"
                                    />
                                    <Text size="sm" className="mb-3 text-dimmed">
                                        Open an SQL, JSON, JSON Lines or CSV file of any size. It is
                                        indexed in the background and never loaded into memory
                                        whole.
                                    </Text>
                                </>
                            )}
                            <Button
                                size="xs"
                                variant="light"
                                leftSection={<IconFileText size={14} />}
                                loading={opening}
                                onClick={() => void api.openFile()}
                            >
                                Open file…
                            </Button>
                        </div>

                        {error && (
                            <Alert color="red" className="mb-3" icon={<IconX size={14} />}>
                                {error}
                            </Alert>
                        )}
                        {host.state === 'failed' && (
                            <Alert color="yellow" className="mb-3">
                                The file reader keeps stopping, so it was not restarted. Restart
                                HttpReq to try again.
                            </Alert>
                        )}

                        {order.length > 0 && (
                            <ul aria-label="Open files" className="m-0 list-none p-0">
                                {order.map((id) => {
                                    const tab = tabs[id];
                                    if (!tab) return null;
                                    return (
                                        <li key={id}>
                                            <UnstyledButton
                                                className={cx(
                                                    'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-hover',
                                                    id === activeId && 'bg-primary-soft',
                                                )}
                                                onClick={() => api.activateTab(id)}
                                            >
                                                <IconFileText
                                                    size={15}
                                                    className="flex-none text-dimmed"
                                                />
                                                <span className="min-w-0 flex-1">
                                                    <span className="block truncate">
                                                        {tab.file.name}
                                                        {isDirty(tab) && ' •'}
                                                    </span>
                                                    <span className="block text-[11px] text-dimmed">
                                                        {formatSize(tab.file.size)}
                                                        {tab.progress?.state === 'indexing' &&
                                                            ' · indexing…'}
                                                    </span>
                                                </span>
                                            </UnstyledButton>
                                        </li>
                                    );
                                })}
                            </ul>
                        )}
                    </>
                )}
            </div>
        </div>
    );
}
