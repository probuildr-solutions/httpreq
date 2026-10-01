/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import {
    app,
    BrowserWindow,
    clipboard,
    ipcMain,
    Menu,
    nativeTheme,
    net,
    screen,
    session,
    shell,
    type IpcMainEvent,
    type IpcMainInvokeEvent,
} from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    CONNECTIVITY_PROBE_URL,
    isWindowAction,
    type AppInfo,
    type DesktopWindowState,
    type HttpResponse,
    type HttpStreamMessage,
    type IpcResult,
    type MenuCommand,
    type WindowAction,
} from '@httpreq/shared';
import { executeHttp } from './http';
import { buildMacMenu } from './menu';
import {
    buildContentSecurityPolicy,
    denyAllPermissions,
    hasDebuggerSwitch,
    isDevToolsAllowed,
    lockDownWebContents,
} from './security';
import { registerServices } from './services';
import { createUpdateController, loadElectronUpdater, supportsSelfUpdate } from './updater';
import { loadWindowState, resolveWindowBounds, saveWindowState } from './windowState';
import {
    isAllowedExternalUrl,
    isAuthorizationUrl,
    isClipboardText,
    isTrustedRendererUrl,
    nextZoomLevel,
} from './shell';

const currentDir = dirname(fileURLToPath(import.meta.url));
const devServer = process.env.VITE_DEV_SERVER_URL;
const isMac = process.platform === 'darwin';

app.setName('HttpReq');

// A packaged build never runs with an external debugger attached or an inspector port open, and
// it runs every renderer in the OS sandbox, whatever its own options say.
if (app.isPackaged && hasDebuggerSwitch((name) => app.commandLine.hasSwitch(name))) app.exit(1);
app.enableSandbox();

const devToolsAllowed = isDevToolsAllowed(app.isPackaged);
// Groups taskbar entries and notifications under the installed app on Windows.
if (process.platform === 'win32') app.setAppUserModelId('dev.httpreq.desktop');

// `resources/` sits next to `dist/` both in the repository and inside the packaged app.asar.
const windowIcon = join(currentDir, '../../resources/icon.png');
// The packaged renderer lives inside app.asar, next to the main-process code, so the same
// integrity check covers both and neither can be swapped on disk without the app noticing.
const rendererEntry = app.isPackaged
    ? join(app.getAppPath(), 'renderer/index.html')
    : join(currentDir, '../../../web/dist/index.html');

const contentSecurityPolicy = buildContentSecurityPolicy(!!devServer);

/** Matches the renderer's body colour, so the window can be shown before the page paints. */
const windowBackground = () => (nativeTheme.shouldUseDarkColors ? '#242424' : '#ffffff');

// Only the top-level document of the app may use shell IPC; subframes have a parent frame.
const isTrustedSender = (event: IpcMainEvent | IpcMainInvokeEvent) =>
    !!event.senderFrame &&
    event.senderFrame.parent === null &&
    isTrustedRendererUrl(event.senderFrame.url, devServer);

const windowFor = (event: IpcMainEvent | IpcMainInvokeEvent) =>
    BrowserWindow.fromWebContents(event.sender);

const windowState = (window: BrowserWindow): DesktopWindowState => ({
    maximized: window.isMaximized(),
    fullscreen: window.isFullScreen(),
    zoomLevel: window.webContents.getZoomLevel(),
});

/**
 * API requests run in their own sessions rather than the app's default session: they keep a
 * separate cookie jar, and the app's CSP header injection never touches API responses. Requests
 * that opt out of TLS verification use a second session whose certificate check accepts
 * everything, so the relaxed check can never leak into verified requests.
 */
let verifiedSession: Electron.Session | undefined;
let unverifiedSession: Electron.Session | undefined;
const apiSession = (verifyTls: boolean): Electron.Session => {
    if (verifyTls) return (verifiedSession ??= session.fromPartition('persist:httpreq-api'));
    if (!unverifiedSession) {
        unverifiedSession = session.fromPartition('persist:httpreq-api-insecure');
        unverifiedSession.setCertificateVerifyProc((_request, callback) => callback(0));
    }
    return unverifiedSession;
};

// In-flight native requests, keyed by sender so one window cannot cancel another's requests.
const inFlight = new Map<string, AbortController>();
const inFlightKey = (event: { sender: { id: number } }, executionId: string) =>
    `${event.sender.id}:${executionId}`;

ipcMain.handle(
    'http:execute',
    async (event, request: unknown, executionId: unknown): Promise<IpcResult<HttpResponse>> => {
        if (typeof executionId !== 'string' || !executionId) {
            return {
                ok: false,
                error: { code: 'INVALID_REQUEST', message: 'Missing execution id.' },
            };
        }
        const key = inFlightKey(event, executionId);
        const controller = new AbortController();
        inFlight.set(key, controller);
        try {
            // Streamed (SSE) responses report progress to the window that sent the request.
            const push = (message: HttpStreamMessage) => {
                if (!event.sender.isDestroyed())
                    event.sender.send('http:stream', executionId, message);
            };
            return await executeHttp(
                request,
                controller.signal,
                (url, init, options) => apiSession(options.verifyTls).fetch(url, init),
                {
                    onStreamStart: (head) => push({ type: 'start', head }),
                    onStreamEvents: (events) => push({ type: 'events', events }),
                },
            );
        } finally {
            if (inFlight.get(key) === controller) inFlight.delete(key);
        }
    },
);

ipcMain.on('http:cancel', (event, executionId: unknown) => {
    if (typeof executionId === 'string') inFlight.get(inFlightKey(event, executionId))?.abort();
});

ipcMain.handle('app:info', (event): AppInfo | null => {
    if (!isTrustedSender(event)) return null;
    return {
        name: app.getName(),
        version: app.getVersion(),
        platform: process.platform,
        versions: {
            electron: process.versions.electron,
            chrome: process.versions.chrome,
            node: process.versions.node,
        },
    };
});

ipcMain.handle('window:state', (event): DesktopWindowState | null => {
    const window = windowFor(event);
    return window && isTrustedSender(event) ? windowState(window) : null;
});

const performAction = (window: BrowserWindow, action: WindowAction) => {
    const contents = window.webContents;
    switch (action) {
        case 'undo':
            return contents.undo();
        case 'redo':
            return contents.redo();
        case 'cut':
            return contents.cut();
        case 'copy':
            return contents.copy();
        case 'paste':
            return contents.paste();
        case 'select-all':
            return contents.selectAll();
        case 'zoom-in':
            return contents.setZoomLevel(nextZoomLevel(contents.getZoomLevel(), 'in'));
        case 'zoom-out':
            return contents.setZoomLevel(nextZoomLevel(contents.getZoomLevel(), 'out'));
        case 'zoom-reset':
            return contents.setZoomLevel(0);
        case 'minimize':
            return window.minimize();
        case 'toggle-maximize':
            return window.isMaximized() ? window.unmaximize() : window.maximize();
        case 'close':
            return window.close();
        case 'toggle-fullscreen':
            return window.setFullScreen(!window.isFullScreen());
        case 'toggle-devtools':
            return devToolsAllowed ? contents.toggleDevTools() : undefined;
        case 'quit':
            return app.quit();
    }
};

ipcMain.on('window:action', (event, action: unknown) => {
    const window = windowFor(event);
    if (!window || !isTrustedSender(event) || !isWindowAction(action)) return;
    performAction(window, action);
    // The zoom level is shown in the renderer (the status bar's Reset Zoom), so tell it the new one.
    if (action.startsWith('zoom-') && !window.isDestroyed()) {
        window.webContents.send('window:state-changed', windowState(window));
    }
});

ipcMain.on('shell:open-external', (event, url: unknown) => {
    if (isTrustedSender(event) && isAllowedExternalUrl(url)) void shell.openExternal(url);
});

ipcMain.on('shell:open-authorization-url', (event, url: unknown) => {
    if (isTrustedSender(event) && isAuthorizationUrl(url)) void shell.openExternal(url);
});

ipcMain.handle('net:check', async (event): Promise<boolean> => {
    if (!isTrustedSender(event) || !net.isOnline()) return false;
    try {
        const response = await net.fetch(CONNECTIVITY_PROBE_URL, {
            method: 'HEAD',
            cache: 'no-store',
            signal: AbortSignal.timeout(5000),
        });
        // Captive portals answer with a redirect or a login page instead of the expected 204.
        return response.status === 204;
    } catch {
        return false;
    }
});

/*
 * Clipboard access goes through the main process. The renderer's Clipboard API is denied here (all
 * web permissions are), and it also needs a live user gesture, which is gone by the time a cURL
 * command has been built. Only the app's own document may use these, and only plain text moves.
 */
ipcMain.handle('clipboard:write-text', async (event, text: unknown): Promise<boolean> => {
    if (!isTrustedSender(event) || !isClipboardText(text)) return false;
    await clipboard.writeText(text);
    return true;
});

ipcMain.handle('clipboard:read-text', async (event): Promise<string> =>
    isTrustedSender(event) ? await clipboard.readText() : '',
);

/**
 * WebSocket, SSH and tunnel services. Registered once, before the first window exists, so their
 * IPC handlers are in place by the time the renderer loads.
 */
const services = registerServices({ isTrustedSender });

/*
 * Background updates. A failure here only ever becomes an `error` state shown to the user: the
 * installed version keeps starting and running whatever the update feed does.
 */
let shuttingDown = false;
const updates = createUpdateController({
    loadUpdater: loadElectronUpdater,
    supported: supportsSelfUpdate(app.isPackaged, process.platform, process.env),
    onState: (state) => {
        for (const window of BrowserWindow.getAllWindows()) {
            if (!window.isDestroyed()) window.webContents.send('updates:state-changed', state);
        }
    },
    // Sockets, shells and tunnels are closed before the installer takes over, and the quit handler
    // below is told not to hold the quit again.
    prepareInstall: async () => {
        shuttingDown = true;
        await services.disposeAll();
    },
});

ipcMain.handle('updates:state', (event) =>
    isTrustedSender(event) ? updates.getState() : { status: 'idle' },
);
ipcMain.handle('updates:check', (event) =>
    isTrustedSender(event) ? updates.check() : { status: 'idle' },
);
ipcMain.on('updates:install', (event) => {
    if (isTrustedSender(event)) void updates.install();
});

const WINDOW_DEFAULTS = { width: 1440, height: 920, minWidth: 900, minHeight: 600 };

const createWindow = async () => {
    const stateFile = join(app.getPath('userData'), 'window-state.json');
    const saved = loadWindowState(stateFile);
    const bounds = resolveWindowBounds(
        saved,
        screen.getAllDisplays().map((display) => display.workArea),
        WINDOW_DEFAULTS,
    );
    const window = new BrowserWindow({
        ...bounds,
        minWidth: WINDOW_DEFAULTS.minWidth,
        minHeight: WINDOW_DEFAULTS.minHeight,
        title: 'HttpReq',
        icon: isMac ? undefined : windowIcon,
        backgroundColor: windowBackground(),
        // Shown immediately rather than on `ready-to-show`: on Windows each Chromium child process
        // (GPU, renderer) can take over a second to start, and a window that appears at once in the
        // app's colours feels far faster than one that appears only when the page has painted.
        show: true,
        // The React title bar hosts the menu and, on Windows and Linux, its own minimise, maximise
        // and close buttons; macOS keeps the native traffic lights.
        titleBarStyle: 'hidden',
        ...(isMac ? { trafficLightPosition: { x: 14, y: 11 } } : {}),
        webPreferences: {
            preload: join(currentDir, 'preload.cjs'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
        },
    });

    // Reopen maximized when it was closed maximized; the restored size is what un-maximizing uses.
    if (saved?.maximized) window.maximize();

    // The restored rectangle is what is remembered, so a maximized close keeps the normal size too.
    const persistState = () => {
        if (window.isDestroyed() || window.isMinimized() || window.isFullScreen()) return;
        const normal = window.getNormalBounds();
        saveWindowState(stateFile, {
            width: normal.width,
            height: normal.height,
            x: normal.x,
            y: normal.y,
            maximized: window.isMaximized(),
        });
    };
    let persistTimer: NodeJS.Timeout | undefined;
    const persistSoon = () => {
        clearTimeout(persistTimer);
        persistTimer = setTimeout(persistState, 400);
    };
    window.on('resize', persistSoon);
    window.on('move', persistSoon);
    window.on('maximize', persistState);
    window.on('unmaximize', persistState);
    // Written synchronously on close, before the window (and its bounds) are gone.
    window.on('close', () => {
        clearTimeout(persistTimer);
        persistState();
    });

    const notifyState = () => {
        if (!window.isDestroyed())
            window.webContents.send('window:state-changed', windowState(window));
    };
    window.on('maximize', notifyState);
    window.on('unmaximize', notifyState);
    window.on('enter-full-screen', notifyState);
    window.on('leave-full-screen', notifyState);
    // Ctrl + mouse wheel zooms without going through a window action.
    window.webContents.on('zoom-changed', () => setTimeout(notifyState, 0));

    // Sockets and shells belong to the window that opened them and die with it.
    const senderId = window.webContents.id;
    window.webContents.on('destroyed', () => services.releaseSender(senderId));

    lockDownWebContents(window.webContents, { devServer, devToolsAllowed });
    if (devServer) await window.loadURL(devServer);
    else await window.loadFile(rendererEntry);
};

const sendMenuCommand = (command: MenuCommand) =>
    BrowserWindow.getFocusedWindow()?.webContents.send('menu:command', command);

app.whenReady().then(async () => {
    denyAllPermissions(session.defaultSession);
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
        callback({
            responseHeaders: {
                ...details.responseHeaders,
                'Content-Security-Policy': [contentSecurityPolicy],
            },
        });
    });
    // Windows and Linux render the menu inside the React title bar instead of a native menu bar.
    Menu.setApplicationMenu(
        isMac
            ? buildMacMenu({
                  command: sendMenuCommand,
                  openExternal: (url) => void shell.openExternal(url),
              })
            : null,
    );
    await createWindow();
    updates.start();
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) void createWindow();
    });
});

/**
 * Quitting is held just long enough to close every socket, SSH channel and listening port, so
 * HttpReq never leaves an orphan session or an occupied local port behind.
 */
app.on('before-quit', (event) => {
    if (shuttingDown) return;
    event.preventDefault();
    shuttingDown = true;
    void services.disposeAll().finally(() => app.quit());
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
