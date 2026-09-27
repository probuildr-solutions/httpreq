import {
  AppShell,
  Button,
  Center,
  Group,
  Stack,
  Text,
  ThemeIcon,
  useMantineColorScheme,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useDisclosure } from '@mantine/hooks';
import { IconBolt, IconBox, IconPlus, IconSend } from '@tabler/icons-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  buildRequest,
  BrowserWebSocketRuntime,
  createVariableResolver,
  ElectronWebSocketRuntime,
  executeRequest,
  getAuthProvider,
  requestOAuthTokens,
  toCurl,
  type PipelineContext,
} from '@httpreq/api-client';
import {
  createId,
  detectCapabilities,
  DOCUMENTATION_URL,
  type BuildInfo,
  type DesktopBridge,
  type HistoryEntry,
  type HistoryRepository,
  type HttpReqBridge,
  type HttpRequest,
  type HttpRuntime,
  type MenuCommand,
  type OAuth2Auth,
  type WorkspaceRepository,
} from '@httpreq/shared';
import { getAncestors } from '@httpreq/workspace';
import './app.css';
import { readAttachment } from './attachments';
import { AuthServicesContext, type AuthServices } from './auth/authServices';
import { CapabilitiesContext } from './capabilities';
import { resetConnections, useConnectionsStore } from './connections';
import type { CommandMap } from './commands';
import { useShortcutManager } from './commands';
import { closeTabs as closeRequestTabs } from './closeTabs';
import { ConfirmDialog } from './ConfirmDialog';
import { preloadEditor } from './editor/preloadEditor';
import { ExportDialog } from './export/ExportDialog';
import { openExportDialog } from './export/exportDialogStore';
import { ImportDialog } from './import/ImportDialog';
import { openImportDialog } from './import/importDialogStore';
import {
  browserConnectivityProbe,
  reportRequestConnectivity,
  useConnectivityMonitor,
} from './connectivity';
import { AboutDialog, SettingsDialog, ShortcutsDialog } from './Dialogs';
import { RequestEditor } from './editor/RequestEditor';
import { EnvironmentSelect } from './EnvironmentSelect';
import { EnvironmentEditor } from './environment/EnvironmentEditor';
import { SaveAsDialog } from './explorer/SaveAsDialog';
import { openSaveAsDialog } from './explorer/saveAsDialogStore';
import { Sidebar } from './explorer/Sidebar';
import { LayoutToggle } from './LayoutToggle';
import type { MenuDefinition } from './MenuBar';
import { REQUEST_PANEL_ID, requestTabId } from './methods';
import { usePreferences } from './preferences';
import type { TabItem } from './RequestTabs';
import { ResponsePanel } from './ResponsePanel';
import { formatChord } from './shortcuts';
import { StatusBar } from './StatusBar';
import { HostKeyDialog } from './ssh/HostKeyDialog';
import { SshContext, useSshManager } from './ssh/useSsh';
import { SshTerminal } from './ssh/SshTerminal';
import { activeEnvironment, editableRequest, requestKind, useWorkbenchStore } from './store';
import { TunnelContext, useTunnelManager } from './tunnels/useTunnels';
import { WebSocketContext, useWebSocketManager } from './websocket/useWebSockets';
import { WebSocketEditor } from './websocket/WebSocketEditor';
import { WorkbenchSplit } from './WorkbenchSplit';
import { WorkbenchTabs } from './WorkbenchTabs';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';
import { Z_LAYERS } from './zLayers';
import { TitleBar } from './TitleBar';
import { usePersistence } from './usePersistence';
import { useRequestExecution } from './useRequestExecution';
import {
  checkForUpdates as runUpdateCheck,
  deploymentCheck,
  githubReleaseCheck,
  useUpdates,
  useUpdateService,
  type UpdateInfo,
} from './updates';
import { VariableContext, type VariableScope } from './variableContext';
import classes from './HttpReqApp.module.css';

/** Must match the Electron window-controls overlay height (`TITLE_BAR_HEIGHT` in desktop). */
const TITLE_BAR_HEIGHT = 36;
const STATUS_BAR_HEIGHT = 24;
const NETWORK_ERRORS = new Set(['NETWORK_ERROR', 'DNS_ERROR', 'CONNECTION_TIMEOUT']);

type Dialog = 'settings' | 'shortcuts' | 'about';

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

const menus: MenuDefinition[] = [
  {
    label: 'File',
    mnemonic: 'f',
    entries: [
      { command: 'request.new' },
      { command: 'websocket.new' },
      { command: 'collection.new' },
      { separator: true },
      { command: 'file.import' },
      { command: 'file.export' },
      { separator: true },
      { command: 'request.save' },
      { command: 'request.save-as' },
      { separator: true },
      { command: 'request.close' },
      { separator: true },
      { command: 'app.exit' },
    ],
  },
  {
    label: 'Edit',
    mnemonic: 'e',
    entries: [
      { command: 'edit.undo' },
      { command: 'edit.redo' },
      { separator: true },
      { command: 'edit.cut' },
      { command: 'edit.copy' },
      { command: 'edit.paste' },
      { separator: true },
      { command: 'edit.select-all' },
    ],
  },
  {
    label: 'View',
    mnemonic: 'v',
    entries: [
      { command: 'view.response-right', role: 'radio' },
      { command: 'view.response-bottom', role: 'radio' },
      { separator: true },
      { command: 'view.toggle-sidebar', role: 'checkbox' },
      { command: 'view.toggle-status-bar', role: 'checkbox' },
      { command: 'view.toggle-theme' },
      { separator: true },
      { command: 'view.zoom-in' },
      { command: 'view.zoom-out' },
      { command: 'view.zoom-reset' },
      { separator: true },
      { command: 'view.fullscreen' },
    ],
  },
  {
    label: 'Request',
    mnemonic: 'r',
    entries: [
      { command: 'request.send' },
      { command: 'request.send-focus' },
      { command: 'request.focus-url' },
      { separator: true },
      { command: 'request.save' },
      { command: 'request.save-as' },
      { command: 'request.duplicate' },
      { separator: true },
      { command: 'request.next' },
      { command: 'request.previous' },
      { separator: true },
      { command: 'request.close' },
    ],
  },
  { label: 'Tools', mnemonic: 't', entries: [{ command: 'tools.settings' }] },
  {
    label: 'Help',
    mnemonic: 'h',
    entries: [
      { command: 'help.documentation' },
      { command: 'help.shortcuts' },
      { separator: true },
      { command: 'help.devtools' },
      { separator: true },
      { command: 'help.check-updates' },
      { command: 'help.about' },
    ],
  },
];

const pipelineContext = (): PipelineContext => {
  const { workspace } = useWorkbenchStore.getState();
  return { workspace, environment: activeEnvironment(workspace), readFile: readAttachment };
};

/** The active request's response, read here so a new response re-renders only this pane. */
function ActiveResponse({ requestId, loading }: { requestId: string; loading: boolean }) {
  const response = useWorkbenchStore((state) => state.responses[requestId]);
  return <ResponsePanel response={response} loading={loading} />;
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
  const [opened, { toggle, close: closeNav }] = useDisclosure();
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const { toggleColorScheme } = useMantineColorScheme();
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
  const ssh = useSshManager(capabilities.ssh ? bridge?.ssh : undefined);
  const tunnels = useTunnelManager(capabilities.tunneling ? bridge?.tunnels : undefined);

  const workspaceName = useWorkbenchStore((state) => state.workspace.name);
  const requests = useWorkbenchStore((state) => state.workspace.requests);
  const socketRequests = useWorkbenchStore((state) => state.workspace.websocketRequests);
  const openIds = useWorkbenchStore((state) => state.workspace.openRequestIds);
  const openSshIds = useWorkbenchStore((state) => state.openSshSessionIds);
  const activeSshId = useWorkbenchStore((state) => state.activeSshSessionId);
  const openEnvironmentTabIds = useWorkbenchStore((state) => state.openEnvironmentTabIds);
  const activeEnvironmentTabId = useWorkbenchStore((state) => state.activeEnvironmentTabId);
  const setActiveEnvironmentTab = useWorkbenchStore((state) => state.setActiveEnvironmentTab);
  const moveEnvironmentTab = useWorkbenchStore((state) => state.moveEnvironmentTab);
  const sshSessions = useConnectionsStore((state) => state.sessions);
  const environments = useWorkbenchStore((state) => state.workspace.environments);
  const activeEnvironmentId = useWorkbenchStore((state) => state.workspace.activeEnvironmentId);
  const activeId = useWorkbenchStore((state) => state.activeRequestId);
  const setActiveRequest = useWorkbenchStore((state) => state.setActiveRequest);
  const cycleRequest = useWorkbenchStore((state) => state.cycleRequest);
  const moveTab = useWorkbenchStore((state) => state.moveTab);
  const createRequest = useWorkbenchStore((state) => state.createRequest);
  const createWebSocket = useWorkbenchStore((state) => state.createWebSocketRequest);
  const createCollection = useWorkbenchStore((state) => state.createCollection);
  const setActiveSshSession = useWorkbenchStore((state) => state.setActiveSshSession);
  const moveSshTab = useWorkbenchStore((state) => state.moveSshTab);
  const duplicateNode = useWorkbenchStore((state) => state.duplicateNode);
  const setResponse = useWorkbenchStore((state) => state.setResponse);

  const responsePosition = usePreferences((state) => state.responsePosition);
  const sidebarVisible = usePreferences((state) => state.sidebarVisible);
  const sidebarWidth = usePreferences((state) => state.sidebarWidth);
  const statusBarVisible = usePreferences((state) => state.statusBarVisible);
  const setResponsePosition = usePreferences((state) => state.setResponsePosition);
  const toggleSidebar = usePreferences((state) => state.toggleSidebar);
  const toggleStatusBar = usePreferences((state) => state.toggleStatusBar);

  const execution = useRequestExecution();
  const { send: runExecution, cancel: cancelRequest } = execution;
  const responseRef = useRef<HTMLElement>(null);
  const urlRef = useRef<HTMLInputElement>(null);
  const mac = useMemo(
    () =>
      desktop
        ? desktop.platform === 'darwin'
        : typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.userAgent),
    [desktop],
  );

  const probe = useMemo(
    () => (desktop ? () => desktop.checkConnectivity() : browserConnectivityProbe),
    [desktop],
  );
  useConnectivityMonitor(probe);

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
        return [{ id, kind: 'request', name: saved.name, method: saved.method, url: saved.url }];
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

  /* Variables of the active environment, for highlighting, tooltips and completion. */
  const variableScope = useMemo<VariableScope>(() => {
    const environment = environments.find((item) => item.id === activeEnvironmentId) ?? null;
    return {
      resolver: createVariableResolver(environment),
      environmentName: environment?.name ?? null,
    };
  }, [environments, activeEnvironmentId]);

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
        return requestOAuthTokens(resolved, (prepared) => runtime.execute(prepared), options);
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

  const send = useCallback(
    async (focusResponse = false) => {
      const state = useWorkbenchStore.getState();
      const request = editableRequest(state, state.activeRequestId);
      if (!request) return;
      if (focusResponse) responseRef.current?.focus();
      const context = pipelineContext();
      const outcome = await runExecution(request.id, (signal) =>
        executeRequest(request, context, runtime, signal),
      );
      const entry: HistoryEntry = {
        id: createId(),
        requestId: request.id,
        name: request.name,
        method: request.method,
        // The unresolved template, so resolved secrets never reach history.
        url: request.url,
        status: null,
        statusText: '',
        durationMs: null,
        sizeBytes: null,
        timestamp: new Date().toISOString(),
      };
      if (outcome.kind === 'success') {
        const { response, built } = outcome.value;
        setResponse(request.id, response);
        reportRequestConnectivity('success');
        recordHistory({
          ...entry,
          status: response.status,
          statusText: response.statusText,
          durationMs: response.durationMs,
          sizeBytes: response.sizeBytes,
        });
        const notes = [...built.warnings];
        if (response.truncated) {
          notes.push(
            `The response was cut at ${request.settings.responseSizeLimitMb} MB (Settings › Response size limit).`,
          );
        }
        if (notes.length)
          notifications.show({
            color: 'yellow',
            title: 'Sent with warnings',
            message: notes.join(' '),
          });
      } else if (outcome.kind === 'cancelled') {
        notifications.show({ color: 'yellow', message: 'Request cancelled.' });
      } else {
        if (outcome.code && NETWORK_ERRORS.has(outcome.code))
          reportRequestConnectivity('network-error');
        recordHistory({ ...entry, error: outcome.message });
        notifications.show({ color: 'red', title: 'Request failed', message: outcome.message });
      }
    },
    [runExecution, runtime, setResponse, recordHistory],
  );

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
      if (await saveRequest(savedId)) {
        const saved = useWorkbenchStore.getState();
        const path = getAncestors(saved.workspace, savedId)
          .map((item) => item.node.name)
          .join(' / ');
        notifications.show({ color: 'teal', message: `Saved to ${path}.` });
      } else reportSaveFailure();
    },
    [saveRequest, sockets, reportSaveFailure],
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
        (id) => !state.openSshSessionIds.includes(id) && !state.openEnvironmentTabIds.includes(id),
      );
      // Environment edits are committed as they are made, so their tabs close without a prompt.
      if (environmentIds.length) state.closeEnvironmentTabs(environmentIds);
      // A closed WebSocket tab must not leave its socket open, nor its message log behind for
      // the next time the same request is opened.
      for (const id of requestIds) {
        if (requestKind(state.workspace, id) === 'websocket') sockets.forget(id);
      }
      if (requestIds.length) {
        await closeRequestTabs(requestIds, { saveRequest, cancelRequest });
      }
      for (const id of sshIds) await ssh.close(id);
    },
    [cancelRequest, saveRequest, sockets, ssh],
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
    await ssh.closeAll();
    await tunnels.stopAll();
    resetConnections();
  }, [sockets, ssh, tunnels]);

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

  /* Updates: GitHub releases for the desktop app, the deployed build for the web app. */
  const updateCheck = useMemo(
    () => (!checkForUpdates || !build ? null : desktop ? githubReleaseCheck() : deploymentCheck()),
    [checkForUpdates, build, desktop],
  );
  useUpdateService(updateCheck, build);

  const applyUpdate = useCallback(
    (update: UpdateInfo) => {
      if (update.kind === 'deployment') window.location.reload();
      else if (update.url && desktop) desktop.openExternal(update.url);
      else if (update.url) window.open(update.url, '_blank', 'noopener,noreferrer');
    },
    [desktop],
  );

  const announceUpdate = useCallback(
    (update: UpdateInfo) =>
      notifications.show({
        id: 'update-available',
        color: 'violet',
        autoClose: 12_000,
        title: `HttpReq ${update.version} is available`,
        message: (
          <Group gap="xs" mt={4}>
            <Text size="sm">
              {update.kind === 'deployment'
                ? 'A newer version has been deployed.'
                : `You are using ${version ?? 'an older version'}.`}
            </Text>
            <Button
              size="compact-xs"
              variant="light"
              onClick={() => {
                notifications.hide('update-available');
                applyUpdate(update);
              }}
            >
              {update.kind === 'deployment' ? 'Reload' : 'Download'}
            </Button>
          </Group>
        ),
      }),
    [applyUpdate, version],
  );

  // A newly found update is announced once; after that the status bar keeps offering it.
  const availableVersion = useUpdates((state) => state.update?.version);
  const announced = useRef<string | null>(null);
  useEffect(() => {
    const update = useUpdates.getState().update;
    if (!update || announced.current === update.version) return;
    announced.current = update.version;
    announceUpdate(update);
  }, [availableVersion, announceUpdate]);

  const checkUpdatesNow = useCallback(async () => {
    try {
      const update = await runUpdateCheck();
      if (update) {
        announced.current = update.version;
        announceUpdate(update);
      } else {
        notifications.show({
          color: 'teal',
          message: `You are up to date: HttpReq ${version ?? ''} is the latest version.`,
        });
      }
    } catch (error) {
      notifications.show({
        color: 'red',
        title: 'Could not check for updates',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, [announceUpdate, version]);

  const tabCount = tabs.length;
  const httpTabActive = activeKind === 'request';
  const requestTabActive = activeKind === 'request' || activeKind === 'websocket';
  const commands = useMemo<CommandMap>(() => {
    const active = () => {
      const state = useWorkbenchStore.getState();
      return state.activeSshSessionId ?? state.activeEnvironmentTabId ?? state.activeRequestId;
    };
    const map: CommandMap = {
      'request.new': { label: 'New Request', shortcut: [{ key: 't', mod: true }], run: newRequest },
      'websocket.new': {
        label: 'New WebSocket Request',
        shortcut: [{ key: 't', mod: true, shift: true }],
        run: newWebSocket,
      },
      'collection.new': { label: 'New Collection', run: () => void createCollection() },
      'file.import': { label: 'Import…', run: () => openImportDialog() },
      'file.export': {
        label: 'Export…',
        // The open request's collection, or the request itself when it is not in one.
        run: () => {
          const state = useWorkbenchStore.getState();
          const request = editableRequest(state, state.activeRequestId);
          if (!request) return;
          const collection = getAncestors(state.workspace, request.id).find(
            (ancestor) => ancestor.kind === 'collection',
          );
          openExportDialog(
            collection
              ? { kind: 'collection', id: collection.node.id }
              : { kind: 'request', request },
          );
        },
        disabled: !httpTabActive,
      },
      'request.save': {
        label: 'Save',
        shortcut: [{ key: 's', mod: true }],
        run: () => void saveActive(),
        disabled: tabCount === 0,
      },
      'request.save-as': {
        label: 'Save As…',
        shortcut: [{ key: 's', mod: true, shift: true }],
        run: saveActiveAs,
        disabled: !requestTabActive,
      },
      'request.close': {
        label: 'Close Request',
        shortcut: [{ key: 'w', mod: true }],
        run: () => {
          const id = active();
          if (id) void closeTab(id);
        },
        disabled: tabCount === 0,
      },
      'request.send': {
        label: 'Send Request',
        shortcut: [{ key: 'Enter', mod: true }],
        run: () => void send(),
        disabled: !httpTabActive,
      },
      'request.send-focus': {
        label: 'Send and Focus Response',
        shortcut: [{ key: 'Enter', mod: true, shift: true }],
        run: () => void send(true),
        disabled: !httpTabActive,
      },
      'request.focus-url': {
        label: 'Focus URL',
        shortcut: [{ key: 'l', mod: true }],
        run: () => {
          urlRef.current?.focus();
          urlRef.current?.select();
        },
        disabled: !httpTabActive,
      },
      'request.duplicate': {
        label: 'Duplicate Request',
        run: () => {
          const id = active();
          if (id) duplicateNode(id);
        },
        disabled: tabCount === 0,
      },
      'request.next': {
        label: 'Next Request',
        shortcut: [
          { key: 'Tab', ctrl: true },
          { key: 'PageDown', ctrl: true },
        ],
        run: () => cycleRequest(1),
        disabled: tabCount <= 1,
        repeatable: true,
      },
      'request.previous': {
        label: 'Previous Request',
        shortcut: [
          { key: 'Tab', ctrl: true, shift: true },
          { key: 'PageUp', ctrl: true },
        ],
        run: () => cycleRequest(-1),
        disabled: tabCount <= 1,
        repeatable: true,
      },
      'view.response-right': {
        label: 'Response Right',
        run: () => setResponsePosition('right'),
        checked: responsePosition === 'right',
      },
      'view.response-bottom': {
        label: 'Response Bottom',
        run: () => setResponsePosition('bottom'),
        checked: responsePosition === 'bottom',
      },
      'view.toggle-sidebar': {
        label: 'Sidebar',
        shortcut: [{ key: 'b', mod: true }],
        run: toggleSidebar,
        checked: sidebarVisible,
      },
      'view.toggle-status-bar': {
        label: 'Status Bar',
        run: toggleStatusBar,
        checked: statusBarVisible,
      },
      'view.toggle-theme': { label: 'Toggle Dark Theme', run: () => toggleColorScheme() },
      'tools.settings': {
        label: 'Settings…',
        shortcut: [{ key: ',', mod: true }],
        run: () => setDialog('settings'),
      },
      'help.documentation': { label: 'Documentation', run: openDocumentation },
      'help.shortcuts': { label: 'Keyboard Shortcuts', run: () => setDialog('shortcuts') },
      'help.about': { label: 'About HttpReq', run: () => setDialog('about') },
    };
    if (updateCheck) {
      map['help.check-updates'] = {
        label: 'Check for Updates…',
        run: () => void checkUpdatesNow(),
      };
    }
    for (let position = 1; position <= 9; position += 1) {
      map[`request.goto-${position}`] = {
        label: `Go to Request ${position}`,
        shortcut: [{ key: String(position), code: `Digit${position}`, mod: true }],
        run: () => {
          const state = useWorkbenchStore.getState();
          const target = [
            ...state.workspace.openRequestIds,
            ...state.openEnvironmentTabIds,
            ...state.openSshSessionIds,
          ][position - 1];
          if (target) activateTab(target);
        },
      };
    }

    if (desktop) {
      const action = desktop.performAction;
      // macOS provides edit, zoom and full-screen through its native menu roles instead.
      if (!mac) {
        const edit = (label: string, key: string, run: () => void, shift = false) => ({
          label,
          // Shown in the menu only: the OS/editor already handles these keys natively.
          shortcut: [{ key, mod: true, shift }],
          allowInEditable: false,
          passive: true,
          run,
        });
        Object.assign(map, {
          'edit.undo': edit('Undo', 'z', () => action('undo')),
          'edit.redo': edit('Redo', 'y', () => action('redo')),
          'edit.cut': edit('Cut', 'x', () => action('cut')),
          'edit.copy': edit('Copy', 'c', () => action('copy')),
          'edit.paste': edit('Paste', 'v', () => action('paste')),
          'edit.select-all': edit('Select All', 'a', () => action('select-all')),
          'view.zoom-in': {
            label: 'Zoom In',
            shortcut: [
              { key: '=', mod: true },
              { key: '+', mod: true, shift: true },
              { key: '+', mod: true },
            ],
            run: () => action('zoom-in'),
          },
          'view.zoom-out': {
            label: 'Zoom Out',
            shortcut: [
              { key: '-', mod: true },
              { key: '_', mod: true, shift: true },
            ],
            run: () => action('zoom-out'),
          },
          'view.zoom-reset': {
            label: 'Reset Zoom',
            shortcut: [{ key: '0', code: 'Digit0', mod: true }],
            run: () => action('zoom-reset'),
          },
          'view.fullscreen': {
            label: 'Full Screen',
            shortcut: [{ key: 'F11' }],
            run: () => action('toggle-fullscreen'),
          },
          'app.exit': { label: 'Exit', run: () => action('quit') },
        } satisfies CommandMap);
      }
      map['help.devtools'] = {
        label: 'Toggle Developer Tools',
        run: () => action('toggle-devtools'),
      };
    } else if (typeof document !== 'undefined' && document.fullscreenEnabled) {
      map['view.fullscreen'] = {
        label: 'Full Screen',
        run: () =>
          void (document.fullscreenElement
            ? document.exitFullscreen()
            : document.documentElement.requestFullscreen()),
      };
    }
    return map;
  }, [
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
    toggleColorScheme,
    openDocumentation,
    updateCheck,
    checkUpdatesNow,
    tabCount,
    responsePosition,
    sidebarVisible,
    statusBarVisible,
    httpTabActive,
    requestTabActive,
    desktop,
    mac,
  ]);

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
        .workspace.tunnelProfiles.filter((tunnel) => tunnel.autoStart && tunnel.sshProfileId);
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

  return (
    <CapabilitiesContext.Provider value={capabilities}>
      <VariableContext.Provider value={variableScope}>
        <AuthServicesContext.Provider value={authServices}>
          <WebSocketContext.Provider value={sockets}>
            <SshContext.Provider value={ssh}>
              <TunnelContext.Provider value={tunnels}>
                <AppShell
                  header={{ height: TITLE_BAR_HEIGHT }}
                  navbar={{
                    width: sidebarWidth,
                    breakpoint: 'sm',
                    collapsed: { mobile: !opened, desktop: !sidebarVisible },
                  }}
                  footer={statusBarVisible ? { height: STATUS_BAR_HEIGHT } : undefined}
                  padding={0}
                  transitionDuration={120}
                >
                  {/* Above the navbar (101) so menus drop down over the sidebar; below dialogs. */}
                  <AppShell.Header className={classes.header} zIndex={Z_LAYERS.header}>
                    <TitleBar
                      // The workspace name is the centred switcher's job, so the title bar's own
                      // text is just whatever tab is open.
                      title={activeName ?? ''}
                      center={
                        <WorkspaceSwitcher
                          actions={workspaceActions}
                          releaseConnections={releaseConnections}
                        />
                      }
                      menus={menus}
                      commands={commands}
                      mac={mac}
                      desktop={desktop}
                      sidebarVisible={sidebarVisible}
                      mobileNavOpened={opened}
                      onToggleMobileNav={toggle}
                    />
                  </AppShell.Header>

                  <AppShell.Navbar className={classes.navbar} aria-label="Sidebar">
                    <Sidebar
                      onClearHistory={clearHistory}
                      onRemoveHistory={removeHistory}
                      onNavigate={closeNav}
                    />
                  </AppShell.Navbar>

                  <AppShell.Main className={classes.main}>
                    <WorkbenchTabs
                      tabs={tabs}
                      activeId={activeTabId}
                      onActivate={activateTab}
                      onClose={onCloseTab}
                      onCloseMany={onCloseTabs}
                      onNew={newRequest}
                      onMove={moveTabAnyKind}
                      newShortcut={shortcutLabel('request.new')}
                      closeShortcut={shortcutLabel('request.close')}
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
                          id={active ? REQUEST_PANEL_ID : undefined}
                          aria-labelledby={requestTabId(tab.id)}
                          className={classes.workspace}
                          hidden={!active}
                        >
                          <SshTerminal sessionId={tab.id} />
                        </div>
                      );
                    })}

                    {activeSshId &&
                    sshTabs.some((tab) => tab.id === activeSshId) ? null : activeKind ===
                        'environment' && activeEnvironmentTabId ? (
                      <div
                        role="tabpanel"
                        id={REQUEST_PANEL_ID}
                        aria-labelledby={requestTabId(activeEnvironmentTabId)}
                        className={classes.workspace}
                      >
                        <EnvironmentEditor
                          key={activeEnvironmentTabId}
                          environmentId={activeEnvironmentTabId}
                        />
                      </div>
                    ) : activeKind === 'websocket' && activeId ? (
                      <div
                        role="tabpanel"
                        id={REQUEST_PANEL_ID}
                        aria-labelledby={requestTabId(activeId)}
                        className={classes.workspace}
                      >
                        <WebSocketEditor
                          key={activeId}
                          requestId={activeId}
                          onSave={() => void saveActive()}
                          onSaveAs={saveActiveAs}
                          shortcuts={{
                            save: shortcutLabel('request.save'),
                            saveAs: shortcutLabel('request.save-as'),
                          }}
                        />
                      </div>
                    ) : activeId && tabs.some((tab) => tab.id === activeId) ? (
                      <div
                        role="tabpanel"
                        id={REQUEST_PANEL_ID}
                        aria-labelledby={requestTabId(activeId)}
                        className={classes.workspace}
                      >
                        <WorkbenchSplit
                          ref={responseRef}
                          requestId="request-editor"
                          labels={{ request: 'Request', response: 'Response' }}
                          splitterLabel="Resize request and response panels"
                          busy={sending}
                          request={
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
                          }
                          response={<ActiveResponse requestId={activeId} loading={sending} />}
                        />
                      </div>
                    ) : (
                      <Center className={classes.workspace}>
                        <Stack align="center" gap="xs">
                          <ThemeIcon variant="light" size={44} radius="xl">
                            <IconSend size={22} />
                          </ThemeIcon>
                          <Text fw={600}>No request open</Text>
                          <Text size="sm" c="dimmed">
                            Open a request from the explorer, or start a new one.
                          </Text>
                          <Group gap="xs" mt="xs">
                            <Button leftSection={<IconPlus size={15} />} onClick={newRequest}>
                              New request
                            </Button>
                            <Button
                              variant="default"
                              leftSection={<IconBolt size={15} />}
                              onClick={newWebSocket}
                            >
                              New WebSocket
                            </Button>
                            <Button
                              variant="default"
                              leftSection={<IconBox size={15} />}
                              onClick={() => createCollection()}
                            >
                              New collection
                            </Button>
                          </Group>
                        </Stack>
                      </Center>
                    )}
                  </AppShell.Main>

                  {statusBarVisible && (
                    <AppShell.Footer className={classes.footer}>
                      <StatusBar
                        workspaceName={workspaceName}
                        runtimeLabel={desktop ? 'Desktop' : 'Browser'}
                        version={version}
                        sending={sending}
                        onApplyUpdate={applyUpdate}
                      />
                    </AppShell.Footer>
                  )}

                  <SettingsDialog opened={dialog === 'settings'} onClose={() => setDialog(null)} />
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
                    onCheckForUpdates={updateCheck ? checkUpdatesNow : undefined}
                    onApplyUpdate={applyUpdate}
                  />
                  <ImportDialog />
                  <ExportDialog />
                  <SaveAsDialog onSaveAs={saveAs} />
                  <ConfirmDialog />
                  <HostKeyDialog />
                </AppShell>
              </TunnelContext.Provider>
            </SshContext.Provider>
          </WebSocketContext.Provider>
        </AuthServicesContext.Provider>
      </VariableContext.Provider>
    </CapabilitiesContext.Provider>
  );
}
