/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { Button, Text } from '../kit';
import { AdminTabView } from './admin/AdminTabView';
import { isAdminTabId } from './admin/adminStore';
import { QueryTab } from './db/QueryTab';
import { isQueryTabId, useQueries } from './db/queryStore';
import { FileEditorTab } from './FileEditorTab';
import { TabStrip } from './tabs/TabStrip';
import { activeTab, useStudioStore } from './studioStore';
import { useDbStudio } from './useDbStudio';

/**
 * The main area while Database Studio is open: one tab strip for every kind of tab (query tabs,
 * opened files, table and collection editors, designers, diagrams) and the active tab's content. It
 * takes the place of the request area without touching it, so the HTTP tabs, terminals and sockets
 * keep running underneath.
 */
export function StudioWorkspace() {
    const api = useDbStudio();
    const active = useStudioStore(activeTab);
    const opening = useStudioStore((state) => state.opening);
    const activeId = useStudioStore((state) => state.activeId);
    const queries = useQueries((state) => state.tabs);
    const activeQuery = activeId && isQueryTabId(activeId) ? queries[activeId] : undefined;

    return (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="studio-workspace">
            <TabStrip />

            {activeQuery ? (
                <QueryTab key={activeQuery.id} id={activeQuery.id} />
            ) : activeId && isAdminTabId(activeId) ? (
                <AdminTabView key={activeId} id={activeId} />
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
