/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */
import { useMemo } from 'react';
import { useConnectionsStore } from '../connections';
import type { TabItem } from '../RequestTabs';
import { useWorkbenchStore } from '../store';

/**
 * The strip's tabs and which one is active, derived from the workspace.
 *
 * Only saved, structural data is read here, so the app shell does not re-render on every
 * keystroke or socket message: unsaved edits and live socket state are applied by `WorkbenchTabs`.
 */
export function useWorkbenchTabs() {
    const requests = useWorkbenchStore((state) => state.workspace.requests);
    const socketRequests = useWorkbenchStore((state) => state.workspace.websocketRequests);
    const openIds = useWorkbenchStore((state) => state.workspace.openRequestIds);
    const openSshIds = useWorkbenchStore((state) => state.openSshSessionIds);
    const activeSshId = useWorkbenchStore((state) => state.activeSshSessionId);
    const openEnvironmentTabIds = useWorkbenchStore((state) => state.openEnvironmentTabIds);
    const activeEnvironmentTabId = useWorkbenchStore((state) => state.activeEnvironmentTabId);
    const environments = useWorkbenchStore((state) => state.workspace.environments);
    const activeId = useWorkbenchStore((state) => state.activeRequestId);
    const sshSessions = useConnectionsStore((state) => state.sessions);

    /*
     * The tab strip holds four kinds of tab, in three groups. Request tabs (HTTP and WebSocket) are
     * ordered by the workspace's `openRequestIds` and persist; environment editors and then SSH
     * terminals are ephemeral and follow them.
     *
     * Only saved, structural data is read here. Unsaved edits and live socket state are applied by
     * `WorkbenchTabs` itself: the shell must not re-render on every keystroke or socket message.
     */
    const requestTabs = useMemo<TabItem[]>(() => {
        const http = new Map(requests.map((request) => [request.id, request]));
        const sockets = new Map(socketRequests.map((request) => [request.id, request]));
        return openIds.flatMap((id): TabItem[] => {
            const saved = http.get(id);
            if (saved) {
                return [
                    {
                        id,
                        kind: 'request',
                        name: saved.name,
                        method: saved.method,
                        ...(saved.protocol ? { protocol: saved.protocol } : {}),
                        url: saved.url,
                    },
                ];
            }
            const socket = sockets.get(id);
            return socket ? [{ id, kind: 'websocket', name: socket.name, url: socket.url }] : [];
        });
    }, [requests, socketRequests, openIds]);

    const sshTabs = useMemo<TabItem[]>(
        () =>
            openSshIds.flatMap((sessionId): TabItem[] => {
                const session = sshSessions[sessionId];
                return session
                    ? [
                          {
                              id: sessionId,
                              kind: 'ssh',
                              name: session.name,
                              status: session.status,
                          },
                      ]
                    : [];
            }),
        [openSshIds, sshSessions],
    );

    const environmentTabs = useMemo<TabItem[]>(() => {
        const byId = new Map(environments.map((environment) => [environment.id, environment]));
        return openEnvironmentTabIds.flatMap((id): TabItem[] => {
            const environment = byId.get(id);
            return environment ? [{ id, kind: 'environment', name: environment.name }] : [];
        });
    }, [environments, openEnvironmentTabIds]);

    const tabs = useMemo(
        () => [...requestTabs, ...environmentTabs, ...sshTabs],
        [requestTabs, environmentTabs, sshTabs],
    );
    const activeTabId = activeSshId ?? activeEnvironmentTabId ?? activeId ?? '';
    const activeTab = tabs.find((tab) => tab.id === activeTabId);
    const activeName = activeTab?.name;
    const activeKind = activeTab?.kind;

    return { tabs, sshTabs, activeTabId, activeName, activeKind };
}
