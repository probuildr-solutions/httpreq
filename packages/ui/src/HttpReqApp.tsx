/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    BrowserWebSocketRuntime,
    buildRequest,
    createVariableResolver,
    ElectronMqttRuntime,
    ElectronWebSocketRuntime,
    getAuthProvider,
    requestOAuthTokens,
    toCurl,
    UnavailableMqttRuntime,
} from '@httpreq/api-client';
import {
    detectCapabilities,
    DOCUMENTATION_URL,
    protocolOf,
    type BuildInfo,
    type DesktopBridge,
    type HistoryRepository,
    type HttpReqBridge,
    type HttpRequest,
    type HttpRuntime,
    type MenuCommand,
    type OAuth2Auth,
    type WorkspaceRepository,
} from '@httpreq/shared';
import { getAncestors } from '@httpreq/workspace';
import { APP_MENUS } from './app/menus';
import { buildCommands, type AppDialog } from './app/buildCommands';
import { EmptyWorkspace } from './app/EmptyWorkspace';
import { pipelineContext } from './app/pipelineContext';
import { useAppUpdates } from './app/useAppUpdates';
import { useEditorCatalog } from './app/useEditorCatalog';
import { useSendRequest } from './app/useSendRequest';
import { useWindowZoom } from './app/useWindowZoom';
import { useWorkbenchTabs } from './app/useWorkbenchTabs';
import { AppShell } from './AppShell';
import { AuthServicesContext, type AuthServices } from './auth/authServices';
import { CapabilitiesContext } from './capabilities';
import { closeTabs as closeRequestTabs } from './closeTabs';
import { useShortcutManager, type CommandMap } from './commands';
import { ConfirmDialog } from './ConfirmDialog';
import { browserConnectivityProbe, useConnectivityMonitor } from './connectivity';
import { resetConnections } from './connections';
import { AboutDialog, SettingsDialog, ShortcutsDialog } from './Dialogs';
import { preloadEditor } from './editor/preloadEditor';
import { RequestEditor } from './editor/RequestEditor';
import { EnvironmentEditor } from './environment/EnvironmentEditor';
import { EnvironmentSelect } from './EnvironmentSelect';
import { ExportDialog } from './export/ExportDialog';
import { SaveAsDialog } from './explorer/SaveAsDialog';
import { openSaveAsDialog } from './explorer/saveAsDialogStore';
import { Sidebar } from './explorer/Sidebar';
import { ImportDialog } from './import/ImportDialog';
import { notifications } from './kit';
import { LayoutToggle } from './LayoutToggle';
import { REQUEST_PANEL_ID, requestTabId } from './methods';
import { usePreferences } from './preferences';
import { ResponsePanel } from './ResponsePanel';
import { SecondaryBar } from './SecondaryBar';
import { formatChord } from './shortcuts';
import { HostKeyDialog } from './ssh/HostKeyDialog';
import { SshTerminal } from './ssh/SshTerminal';
import { SshContext, useSshManager } from './ssh/useSsh';
import { StatusBar } from './StatusBar';
import { activeEnvironment, editableRequest, requestKind, useWorkbenchStore } from './store';
import { TitleBar } from './TitleBar';
import { StudioWorkspace } from './dbstudio/StudioWorkspace';
import { useStudioStore } from './dbstudio/studioStore';
import { DbManagerContext, useDbManagerState } from './dbstudio/db/useDbManager';
import { isQueryTabId } from './dbstudio/db/queryStore';
import { DbStudioContext, useDbStudioManager } from './dbstudio/useDbStudio';
import { TunnelContext, useTunnelManager } from './tunnels/useTunnels';
import { usePersistence } from './usePersistence';
import { useRequestExecution } from './useRequestExecution';
import { VariableContext, type VariableScope } from './variableContext';
import { MqttContext, useMqttManager } from './mqtt/useMqtt';
import { ProtocolServicesContext, createProtocolServices } from './protocols/services';
import { WebSocketContext, useWebSocketManager } from './websocket/useWebSockets';
import { WebSocketEditor } from './websocket/WebSocketEditor';
import { WorkbenchSplit } from './WorkbenchSplit';
import { WorkbenchTabs } from './WorkbenchTabs';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';

/** Must match the Electron window-controls overlay height (`TITLE_BAR_HEIGHT` in desktop). */
const TITLE_BAR_HEIGHT = 36;
/** The workspace row under the title bar. */
const SECONDARY_BAR_HEIGHT = 32;
const STATUS_BAR_HEIGHT = 24;

interface Props {
    runtime: HttpRuntime;
    repository: WorkspaceRepository;
    history: HistoryRepository;
    /** Desktop shell bridge; absent in the browser. */
    desktop?: DesktopBridge;
    /**
     * The whole preload bridge, which also carries the WebSocket, SSH and tunnel surfaces. What it
     * actually exposes decides the platform capabilities, so a desktop build missing one of them is
     * reported honestly rather than assumed.
     */
    bridge?: HttpReqBridge;
    /** Version only, for hosts that do not know their build; prefer {@link build}. */
    version?: string;
    /** Version, commit and build time of the running bundle. */
    build?: BuildInfo;
    /**
     * Whether to look for newer versions: GitHub releases on the desktop, a newer deployment in
     * the browser. Off for development builds.
     */
    checkForUpdates?: boolean;
}

/** The active request's response, read here so a new response re-renders only this pane. */
function ActiveResponse({
    requestId,
    loading,
    onStop,
}: {
    requestId: string;
    loading: boolean;
    onStop: () => void;
}) {
    const response = useWorkbenchStore((state) => state.responses[requestId]);
    const stream = useWorkbenchStore((state) => state.streams[requestId]);
    const report = useWorkbenchStore((state) => state.scriptReports[requestId]);
    return (
        <ResponsePanel
            response={response}
            stream={stream}
            loading={loading}
            onStop={onStop}
            report={report}
        />
    );
}

export function HttpReqApp({
    runtime,
    repository,
    history,
    desktop,
    bridge,
    version: versionProp,
    build,
    checkForUpdates = false,
}: Props) {
    const version = build?.version ?? versionProp;
    const [opened, setOpened] = useState(false);
    const toggle = useCallback(() => setOpened((current) => !current), []);
    const closeNav = useCallback(() => setOpened(false), []);
    const [dialog, setDialog] = useState<AppDialog | null>(null);
    const { loaded, saveRequest, recordHistory, clearHistory, removeHistory, workspaceActions } =
        usePersistence(repository, history);

    // Once the workspace is on screen, load Monaco in the background for the first editor.
    useEffect(() => {
        if (loaded) preloadEditor();
    }, [loaded]);

    const capabilities = useMemo(() => detectCapabilities(bridge), [bridge]);
    const webSocketRuntime = useMemo(
        () => (bridge?.webSocket ? new ElectronWebSocketRuntime() : new BrowserWebSocketRuntime()),
        [bridge],
    );
    const sockets = useWebSocketManager(webSocketRuntime, pipelineContext);
    const mqttRuntime = useMemo(
        () => (bridge?.mqtt ? new ElectronMqttRuntime() : new UnavailableMqttRuntime()),
        [bridge],
    );
    const mqtt = useMqttManager(mqttRuntime, pipelineContext);
    const protocolServices = useMemo(() => createProtocolServices(runtime), [runtime]);
    const ssh = useSshManager(capabilities.ssh ? bridge?.ssh : undefined);
    const tunnels = useTunnelManager(capabilities.tunneling ? bridge?.tunnels : undefined);
    const dbStudioBridge = capabilities.databaseStudio ? bridge?.dbStudio : undefined;
    const dbStudio = useDbStudioManager(dbStudioBridge);
    const dbManager = useDbManagerState(dbStudioBridge);

    const workspaceName = useWorkbenchStore((state) => state.workspace.name);
    const activeSshId = useWorkbenchStore((state) => state.activeSshSessionId);
    // Database Studio takes over the main area while its sidebar view is open. The request area
    // below is hidden, not unmounted, so terminals and sockets keep running.
    const studioActive =
        useWorkbenchStore((state) => state.sidebarView) === 'dbstudio' &&
        capabilities.databaseStudio;
    const activeEnvironmentTabId = useWorkbenchStore((state) => state.activeEnvironmentTabId);
    const setActiveEnvironmentTab = useWorkbenchStore((state) => state.setActiveEnvironmentTab);
    const moveEnvironmentTab = useWorkbenchStore((state) => state.moveEnvironmentTab);
    const environments = useWorkbenchStore((state) => state.workspace.environments);
    const requests = useWorkbenchStore((state) => state.workspace.requests);
    const activeEnvironmentId = useWorkbenchStore((state) => state.workspace.activeEnvironmentId);
    const activeId = useWorkbenchStore((state) => state.activeRequestId);
    const activeProtocol = useWorkbenchStore((state) => {
        const request = state.activeRequestId
            ? editableRequest(state, state.activeRequestId)
            : undefined;
        return request ? protocolOf(request) : 'http';
    });
    const setActiveRequest = useWorkbenchStore((state) => state.setActiveRequest);
    const cycleRequest = useWorkbenchStore((state) => state.cycleRequest);
    const moveTab = useWorkbenchStore((state) => state.moveTab);
    const createRequest = useWorkbenchStore((state) => state.createRequest);
    const createWebSocket = useWorkbenchStore((state) => state.createWebSocketRequest);
    const createCollection = useWorkbenchStore((state) => state.createCollection);
    const setActiveSshSession = useWorkbenchStore((state) => state.setActiveSshSession);
    const moveSshTab = useWorkbenchStore((state) => state.moveSshTab);
    const duplicateNode = useWorkbenchStore((state) => state.duplicateNode);

    const responsePosition = usePreferences((state) => state.responsePosition);
    const sidebarVisible = usePreferences((state) => state.sidebarVisible);
    const sidebarWidth = usePreferences((state) => state.sidebarWidth);
    const statusBarVisible = usePreferences((state) => state.statusBarVisible);
    const setResponsePosition = usePreferences((state) => state.setResponsePosition);
    const toggleSidebar = usePreferences((state) => state.toggleSidebar);
    const toggleStatusBar = usePreferences((state) => state.toggleStatusBar);

    const { zoomed, resetZoom } = useWindowZoom(desktop);

    const execution = useRequestExecution();
    const { send: runExecution, cancel: cancelRequest } = execution;
    const responseRef = useRef<HTMLElement>(null);
    const urlRef = useRef<HTMLInputElement>(null);
    const mac = useMemo(
        () =>
            desktop
                ? desktop.platform === 'darwin'
                : typeof navigator !== 'undefined' &&
                  /Mac|iPhone|iPad|iPod/.test(navigator.userAgent),
        [desktop],
    );

    const probe = useMemo(
        () => (desktop ? () => desktop.checkConnectivity() : browserConnectivityProbe),
        [desktop],
    );
    useConnectivityMonitor(probe);

    const { tabs, sshTabs, activeTabId, activeName, activeKind } = useWorkbenchTabs();

    /* Variables of the active environment, for highlighting, tooltips and completion. */
    const variableScope = useMemo<VariableScope>(() => {
        const environment = environments.find((item) => item.id === activeEnvironmentId) ?? null;
        return {
            resolver: createVariableResolver(environment),
            environmentName: environment?.name ?? null,
        };
    }, [environments, activeEnvironmentId]);
    // The editors suggest from the same variables, and from the keys other requests use.
    useEditorCatalog(variableScope.resolver, requests);

    const authServices = useMemo<AuthServices>(
        () => ({
            requestTokens: (config: OAuth2Auth, options) => {
                const resolver = createVariableResolver(
                    activeEnvironment(useWorkbenchStore.getState().workspace),
                );
                const resolved = getAuthProvider(config).resolve(config, {
                    resolve: resolver.resolve,
                    now: Date.now,
                });
                return requestOAuthTokens(
                    resolved,
                    (prepared) => runtime.execute(prepared),
                    options,
                );
            },
            setVariable: (key, value) =>
                useWorkbenchStore.getState().setEnvironmentVariable(key, value, true),
            openUrl: (url) => {
                if (desktop) desktop.openAuthorizationUrl(url);
                else window.open(url, '_blank', 'noopener,noreferrer');
            },
            resolve: (text) => variableScope.resolver.resolve(text),
        }),
        [runtime, desktop, variableScope],
    );

    const buildCurl = useCallback(async (request: HttpRequest) => {
        const built = await buildRequest(request, {
            ...pipelineContext(),
            // cURL references files by name, so their bytes are not needed.
            readFile: async () => new Uint8Array(),
            resolverOptions: { keepSecrets: true },
        });
        return toCurl(built.prepared, request.body.binary?.name);
    }, []);

    const send = useSendRequest({ runtime, runExecution, recordHistory, responseRef });

    const reportSaveFailure = useCallback(
        () =>
            notifications.show({
                color: 'red',
                title: 'Save failed',
                message:
                    'The request could not be written to local storage. Your changes are kept; try again.',
            }),
        [],
    );

    /** Opens "Save as" for the active HTTP or WebSocket request. */
    const saveActiveAs = useCallback(() => {
        const state = useWorkbenchStore.getState();
        const id = state.activeRequestId;
        if (id && requestKind(state.workspace, id)) openSaveAsDialog({ mode: 'save-as', id });
    }, []);

    const saveActive = useCallback(async () => {
        const state = useWorkbenchStore.getState();
        const id = state.activeRequestId;
        if (!id) return true;
        // WebSocket edits are committed as they are made, so saving a socket that is in no
        // collection yet means choosing where to file it.
        const socket = state.workspace.websocketRequests.find((request) => request.id === id);
        if (socket && socket.parentId === null) {
            openSaveAsDialog({ mode: 'save-as', id });
            return true;
        }
        const ok = await saveRequest(id);
        if (!ok) reportSaveFailure();
        return ok;
    }, [saveRequest, reportSaveFailure]);

    /** Completes "Save as": files the request (or a copy) and writes the workspace at once. */
    const saveAs = useCallback(
        async (id: string, parentId: string, name: string) => {
            const state = useWorkbenchStore.getState();
            const kind = requestKind(state.workspace, id);
            const savedId = state.saveRequestAs(id, parentId, name);
            if (!savedId) return;
            // A copy took over the original's tab; a socket must not stay connected behind it.
            if (savedId !== id && kind === 'websocket') sockets.forget(id);
            if (savedId !== id && kind === 'request') mqtt.forget(id);
            if (await saveRequest(savedId)) {
                const saved = useWorkbenchStore.getState();
                const path = getAncestors(saved.workspace, savedId)
                    .map((item) => item.node.name)
                    .join(' / ');
                notifications.show({ color: 'teal', message: `Saved to ${path}.` });
            } else reportSaveFailure();
        },
        [saveRequest, sockets, mqtt, reportSaveFailure],
    );

    /** Activating any tab: at most one of a terminal, an environment or a request is active. */
    const activateTab = useCallback(
        (id: string) => {
            const state = useWorkbenchStore.getState();
            if (state.openSshSessionIds.includes(id)) setActiveSshSession(id);
            else if (state.openEnvironmentTabIds.includes(id)) setActiveEnvironmentTab(id);
            else {
                setActiveSshSession(null);
                setActiveRequest(id);
            }
        },
        [setActiveRequest, setActiveSshSession, setActiveEnvironmentTab],
    );

    const moveTabAnyKind = useCallback(
        (id: string, toIndex: number) => {
            const state = useWorkbenchStore.getState();
            // Environment tabs follow the request tabs and SSH tabs follow both, so a target index is
            // relative to the tab's own group.
            const requestCount = state.workspace.openRequestIds.length;
            if (state.openSshSessionIds.includes(id)) {
                moveSshTab(id, toIndex - requestCount - state.openEnvironmentTabIds.length);
            } else if (state.openEnvironmentTabIds.includes(id)) {
                moveEnvironmentTab(id, toIndex - requestCount);
            } else {
                moveTab(id, toIndex);
            }
        },
        [moveSshTab, moveEnvironmentTab, moveTab],
    );

    const closeTabs = useCallback(
        async (ids: Iterable<string>) => {
            const state = useWorkbenchStore.getState();
            const wanted = [...ids];
            const sshIds = wanted.filter((id) => state.openSshSessionIds.includes(id));
            const environmentIds = wanted.filter((id) => state.openEnvironmentTabIds.includes(id));
            const requestIds = wanted.filter(
                (id) =>
                    !state.openSshSessionIds.includes(id) &&
                    !state.openEnvironmentTabIds.includes(id),
            );
            // Environment edits are committed as they are made, so their tabs close without a prompt.
            if (environmentIds.length) state.closeEnvironmentTabs(environmentIds);
            // A closed WebSocket tab must not leave its socket open, nor its message log behind for
            // the next time the same request is opened.
            for (const id of requestIds) {
                if (requestKind(state.workspace, id) === 'websocket') sockets.forget(id);
                // A closed MQTT tab disconnects from its broker; other requests have nothing to forget.
                mqtt.forget(id);
            }
            if (requestIds.length) {
                await closeRequestTabs(requestIds, { saveRequest, cancelRequest });
            }
            for (const id of sshIds) await ssh.close(id);
        },
        [cancelRequest, saveRequest, sockets, mqtt, ssh],
    );

    const closeTab = useCallback((id: string) => closeTabs([id]), [closeTabs]);
    const onCloseTab = useCallback((id: string) => void closeTab(id), [closeTab]);
    const onCloseTabs = useCallback((ids: string[]) => void closeTabs(ids), [closeTabs]);
    const tabActions = useMemo(
        () => (
            <>
                <EnvironmentSelect />
                <LayoutToggle />
            </>
        ),
        [],
    );

    /** Releases every live resource this workspace owns, before it is replaced or the app exits. */
    const releaseConnections = useCallback(async () => {
        sockets.closeAll();
        mqtt.closeAll();
        await ssh.closeAll();
        await tunnels.stopAll();
        resetConnections();
    }, [sockets, mqtt, ssh, tunnels]);

    const newRequest = useCallback(() => {
        setActiveSshSession(null);
        createRequest(null);
        requestAnimationFrame(() => urlRef.current?.focus());
    }, [createRequest, setActiveSshSession]);

    const newWebSocket = useCallback(() => {
        setActiveSshSession(null);
        createWebSocket(null);
    }, [createWebSocket, setActiveSshSession]);

    const openDocumentation = useCallback(() => {
        if (desktop) desktop.openExternal(DOCUMENTATION_URL);
        else window.open(DOCUMENTATION_URL, '_blank', 'noopener,noreferrer');
    }, [desktop]);

    const { updateCheck, applyUpdate, checkUpdatesNow } = useAppUpdates({
        checkForUpdates,
        build,
        desktop,
        version,
    });

    const tabCount = tabs.length;
    const httpTabActive = activeKind === 'request';
    const requestTabActive = activeKind === 'request' || activeKind === 'websocket';
    const studioHasTab = useStudioStore((state) => state.activeId !== null);
    const studioCommands = useMemo(() => {
        const withActive = (run: (id: string) => unknown) => () => {
            const id = useStudioStore.getState().activeId;
            if (id) void run(id);
        };
        return {
            hasTab: studioHasTab,
            save: withActive(dbStudio.save),
            saveAs: withActive(dbStudio.saveAs),
            close: withActive((id) =>
                isQueryTabId(id) ? dbManager.closeQuery(id) : dbStudio.closeTab(id),
            ),
        };
    }, [studioHasTab, dbStudio, dbManager]);
    const commands = useMemo<CommandMap>(
        () =>
            buildCommands({
                desktop,
                mac,
                urlRef,
                tabCount,
                // The request area is hidden while Database Studio is in front.
                httpTabActive: httpTabActive && !studioActive,
                requestTabActive: requestTabActive && !studioActive,
                responsePosition,
                sidebarVisible,
                statusBarVisible,
                updateCheck: !!updateCheck,
                newRequest,
                newWebSocket,
                createCollection,
                saveActive,
                saveActiveAs,
                closeTab,
                send,
                duplicateNode,
                cycleRequest,
                activateTab,
                setResponsePosition,
                toggleSidebar,
                toggleStatusBar,
                openDocumentation,
                checkUpdatesNow,
                openDialog: setDialog,
                studio: studioActive ? studioCommands : undefined,
            }),
        [
            desktop,
            mac,
            tabCount,
            httpTabActive,
            requestTabActive,
            responsePosition,
            sidebarVisible,
            statusBarVisible,
            updateCheck,
            newRequest,
            newWebSocket,
            createCollection,
            saveActive,
            saveActiveAs,
            closeTab,
            send,
            duplicateNode,
            cycleRequest,
            activateTab,
            setResponsePosition,
            toggleSidebar,
            toggleStatusBar,
            openDocumentation,
            checkUpdatesNow,
            studioActive,
            studioCommands,
        ],
    );

    useShortcutManager(commands, mac);

    // The macOS native menu forwards its clicks here, so both menus share one command set.
    useEffect(
        () => desktop?.onMenuCommand((command: MenuCommand) => commands[command]?.run()),
        [desktop, commands],
    );

    /*
     * Tunnels marked "start with the workspace" come up once the workspace is in place, and again
     * after a switch. A failure is reported but never retried in a loop: a port conflict would
     * otherwise produce an endless stream of notifications.
     */
    const workspaceId = useWorkbenchStore((state) => state.workspace.id);
    useEffect(() => {
        if (!loaded || !tunnels.available) return;
        let cancelled = false;
        void (async () => {
            const pending = useWorkbenchStore
                .getState()
                .workspace.tunnelProfiles.filter(
                    (tunnel) => tunnel.autoStart && tunnel.sshProfileId,
                );
            for (const tunnel of pending) {
                if (cancelled) return;
                const error = await tunnels.start(tunnel);
                if (error && !cancelled) {
                    notifications.show({
                        color: 'red',
                        title: `Tunnel “${tunnel.name}” did not start`,
                        message: error.message,
                    });
                }
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [loaded, tunnels, workspaceId]);

    const shortcutLabel = (id: string) => {
        const chord = commands[id]?.shortcut?.[0];
        return chord ? formatChord(chord, mac) : undefined;
    };

    if (!loaded) return null;
    const sending = activeId ? execution.isSending(activeId) : false;

    const requestEditor = activeId ? (
        <RequestEditor
            key={activeId}
            requestId={activeId}
            desktop={!!desktop}
            sending={sending}
            onSend={() => void send()}
            onCancel={() => execution.cancel(activeId)}
            onSave={() => void saveActive()}
            onSaveAs={saveActiveAs}
            urlRef={urlRef}
            buildCurl={buildCurl}
            shortcuts={{
                send: shortcutLabel('request.send'),
                save: shortcutLabel('request.save'),
                saveAs: shortcutLabel('request.save-as'),
                focusUrl: shortcutLabel('request.focus-url'),
            }}
        />
    ) : null;

    return (
        <CapabilitiesContext.Provider value={capabilities}>
            <VariableContext.Provider value={variableScope}>
                <AuthServicesContext.Provider value={authServices}>
                    <ProtocolServicesContext.Provider value={protocolServices}>
                        <MqttContext.Provider value={mqtt}>
                            <WebSocketContext.Provider value={sockets}>
                                <SshContext.Provider value={ssh}>
                                    <TunnelContext.Provider value={tunnels}>
                                        <DbStudioContext.Provider value={dbStudio}>
                                            <DbManagerContext.Provider value={dbManager}>
                                                <AppShell
                                                    headerHeight={
                                                        TITLE_BAR_HEIGHT + SECONDARY_BAR_HEIGHT
                                                    }
                                                    navbarWidth={sidebarWidth}
                                                    navbarVisible={sidebarVisible}
                                                    navbarOpen={opened}
                                                    footerHeight={STATUS_BAR_HEIGHT}
                                                    header={
                                                        <>
                                                            <div
                                                                style={{ height: TITLE_BAR_HEIGHT }}
                                                            >
                                                                <TitleBar
                                                                    // The workspace menu lives in the row below, so the title bar's own text
                                                                    // is just whatever tab is open.
                                                                    title={activeName ?? ''}
                                                                    menus={APP_MENUS}
                                                                    commands={commands}
                                                                    mac={mac}
                                                                    desktop={desktop}
                                                                    mobileNavOpened={opened}
                                                                    onToggleMobileNav={toggle}
                                                                />
                                                            </div>
                                                            <div
                                                                style={{
                                                                    height: SECONDARY_BAR_HEIGHT,
                                                                }}
                                                            >
                                                                <SecondaryBar
                                                                    toggleSidebar={
                                                                        commands[
                                                                            'view.toggle-sidebar'
                                                                        ]
                                                                    }
                                                                    sidebarVisible={sidebarVisible}
                                                                >
                                                                    <WorkspaceSwitcher
                                                                        actions={workspaceActions}
                                                                        releaseConnections={
                                                                            releaseConnections
                                                                        }
                                                                    />
                                                                </SecondaryBar>
                                                            </div>
                                                        </>
                                                    }
                                                    navbar={
                                                        <Sidebar
                                                            onClearHistory={clearHistory}
                                                            onRemoveHistory={removeHistory}
                                                            onNavigate={closeNav}
                                                        />
                                                    }
                                                    footer={
                                                        statusBarVisible ? (
                                                            <StatusBar
                                                                workspaceName={workspaceName}
                                                                runtimeLabel={
                                                                    desktop ? 'Desktop' : 'Browser'
                                                                }
                                                                version={version}
                                                                sending={sending}
                                                                onResetZoom={resetZoom}
                                                                zoomed={zoomed}
                                                                onApplyUpdate={applyUpdate}
                                                            />
                                                        ) : undefined
                                                    }
                                                >
                                                    {studioActive && <StudioWorkspace />}
                                                    <div
                                                        hidden={studioActive}
                                                        className="flex min-h-0 min-w-0 flex-1 flex-col [&[hidden]]:hidden"
                                                    >
                                                        <WorkbenchTabs
                                                            tabs={tabs}
                                                            activeId={activeTabId}
                                                            onActivate={activateTab}
                                                            onClose={onCloseTab}
                                                            onCloseMany={onCloseTabs}
                                                            onNew={newRequest}
                                                            onMove={moveTabAnyKind}
                                                            newShortcut={shortcutLabel(
                                                                'request.new',
                                                            )}
                                                            closeShortcut={shortcutLabel(
                                                                'request.close',
                                                            )}
                                                            actions={tabActions}
                                                        />

                                                        {/*
                                                         * Every open terminal stays mounted and is merely hidden when its tab is not
                                                         * the active one. A terminal is a live screen, not a view of stored data:
                                                         * unmounting it would dispose the xterm instance and destroy the scrollback,
                                                         * the prompt and whatever full-screen program is running, so coming back to a
                                                         * still-connected session would show an empty pane.
                                                         */}
                                                        {sshTabs.map((tab) => {
                                                            const active = tab.id === activeSshId;
                                                            return (
                                                                <div
                                                                    key={tab.id}
                                                                    role="tabpanel"
                                                                    id={
                                                                        active
                                                                            ? REQUEST_PANEL_ID
                                                                            : undefined
                                                                    }
                                                                    aria-labelledby={requestTabId(
                                                                        tab.id,
                                                                    )}
                                                                    className="flex min-h-0 min-w-0 flex-1 [&[hidden]]:hidden"
                                                                    hidden={!active}
                                                                >
                                                                    <SshTerminal
                                                                        sessionId={tab.id}
                                                                    />
                                                                </div>
                                                            );
                                                        })}

                                                        {activeSshId &&
                                                        sshTabs.some(
                                                            (tab) => tab.id === activeSshId,
                                                        ) ? null : activeKind === 'environment' &&
                                                          activeEnvironmentTabId ? (
                                                            <div
                                                                role="tabpanel"
                                                                id={REQUEST_PANEL_ID}
                                                                aria-labelledby={requestTabId(
                                                                    activeEnvironmentTabId,
                                                                )}
                                                                className="flex min-h-0 min-w-0 flex-1 [&[hidden]]:hidden"
                                                            >
                                                                <EnvironmentEditor
                                                                    key={activeEnvironmentTabId}
                                                                    environmentId={
                                                                        activeEnvironmentTabId
                                                                    }
                                                                />
                                                            </div>
                                                        ) : activeKind === 'websocket' &&
                                                          activeId ? (
                                                            <div
                                                                role="tabpanel"
                                                                id={REQUEST_PANEL_ID}
                                                                aria-labelledby={requestTabId(
                                                                    activeId,
                                                                )}
                                                                className="flex min-h-0 min-w-0 flex-1 [&[hidden]]:hidden"
                                                            >
                                                                <WebSocketEditor
                                                                    key={activeId}
                                                                    requestId={activeId}
                                                                    onSave={() => void saveActive()}
                                                                    onSaveAs={saveActiveAs}
                                                                    shortcuts={{
                                                                        save: shortcutLabel(
                                                                            'request.save',
                                                                        ),
                                                                        saveAs: shortcutLabel(
                                                                            'request.save-as',
                                                                        ),
                                                                    }}
                                                                />
                                                            </div>
                                                        ) : activeId &&
                                                          tabs.some(
                                                              (tab) => tab.id === activeId,
                                                          ) ? (
                                                            <div
                                                                role="tabpanel"
                                                                id={REQUEST_PANEL_ID}
                                                                aria-labelledby={requestTabId(
                                                                    activeId,
                                                                )}
                                                                className="flex min-h-0 min-w-0 flex-1 [&[hidden]]:hidden"
                                                            >
                                                                {activeProtocol === 'mqtt' ? (
                                                                    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                                                                        {requestEditor}
                                                                    </div>
                                                                ) : (
                                                                    <WorkbenchSplit
                                                                        ref={responseRef}
                                                                        requestId="request-editor"
                                                                        labels={{
                                                                            request: 'Request',
                                                                            response: 'Response',
                                                                        }}
                                                                        splitterLabel="Resize request and response panels"
                                                                        busy={sending}
                                                                        request={requestEditor}
                                                                        response={
                                                                            <ActiveResponse
                                                                                requestId={activeId}
                                                                                loading={sending}
                                                                                onStop={() =>
                                                                                    execution.cancel(
                                                                                        activeId,
                                                                                    )
                                                                                }
                                                                            />
                                                                        }
                                                                    />
                                                                )}
                                                            </div>
                                                        ) : (
                                                            <EmptyWorkspace
                                                                onNewRequest={newRequest}
                                                                onNewWebSocket={newWebSocket}
                                                                onNewCollection={() =>
                                                                    createCollection()
                                                                }
                                                            />
                                                        )}
                                                    </div>
                                                </AppShell>

                                                <SettingsDialog
                                                    opened={dialog === 'settings'}
                                                    onClose={() => setDialog(null)}
                                                />
                                                <ShortcutsDialog
                                                    opened={dialog === 'shortcuts'}
                                                    onClose={() => setDialog(null)}
                                                    commands={commands}
                                                    mac={mac}
                                                    web={!desktop}
                                                />
                                                <AboutDialog
                                                    opened={dialog === 'about'}
                                                    onClose={() => setDialog(null)}
                                                    version={version}
                                                    build={build}
                                                    desktop={desktop}
                                                    onOpenDocumentation={openDocumentation}
                                                    onCheckForUpdates={
                                                        updateCheck ? checkUpdatesNow : undefined
                                                    }
                                                    onApplyUpdate={applyUpdate}
                                                />
                                                <ImportDialog />
                                                <ExportDialog />
                                                <SaveAsDialog onSaveAs={saveAs} />
                                                <ConfirmDialog />
                                                <HostKeyDialog />
                                            </DbManagerContext.Provider>
                                        </DbStudioContext.Provider>
                                    </TunnelContext.Provider>
                                </SshContext.Provider>
                            </WebSocketContext.Provider>
                        </MqttContext.Provider>
                    </ProtocolServicesContext.Provider>
                </AuthServicesContext.Provider>
            </VariableContext.Provider>
        </CapabilitiesContext.Provider>
    );
}
