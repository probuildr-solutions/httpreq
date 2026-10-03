/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

export * from './capabilities';
export * from './codegen';
export * from './dbstudio';
export * from './equality';
export * from './grpc';
export * from './model';
export * from './mqtt';
export * from './pathVariables';
export * from './protocols';
export * from './scripts';
export * from './soap';
export * from './ssh';
export * from './validation';
export * from './websocket';

import type { HistoryEntry, HttpMethod, HttpRequest, Workspace, WorkspaceMeta } from './model';
import type { DbStudioBridge } from './dbstudio';
import type { GrpcBridge } from './grpc';
import type { MqttBridge } from './mqtt';
import type { SshBridge, TunnelBridge } from './ssh';
import type { PreparedWebSocket, WebSocketEvent } from './websocket';

export type PreparedBody =
    | { kind: 'text'; text: string }
    | { kind: 'bytes'; bytes: Uint8Array }
    | { kind: 'multipart'; parts: PreparedPart[] };

export type PreparedPart =
    | { name: string; value: string }
    | { name: string; fileName: string; contentType: string; bytes: Uint8Array };

/** Transport options derived from request settings; each runtime honours what it can. */
export interface PreparedOptions {
    followRedirects: boolean;
    verifyTls: boolean;
    sendCookies: boolean;
    /** 0 reads the whole body. */
    maxResponseBytes: number;
}

/**
 * The final, fully resolved request produced by the execution pipeline: variables substituted,
 * authorization applied, body encoded. It is the only request shape that crosses into a runtime
 * (and over Electron IPC), so saved requests are never mutated with resolved values.
 */
export interface PreparedRequest {
    method: HttpMethod;
    url: string;
    headers: Record<string, string>;
    body?: PreparedBody;
    options: PreparedOptions;
}

/** One Server-Sent Event, as assembled from the `event`, `data`, `id` and `retry` fields. */
export interface SseEvent {
    /** Position in the stream, from 1. */
    index: number;
    /** The `event` field; absent for the default "message" event. */
    event?: string;
    /** The `data` lines joined with newlines. */
    data: string;
    /** The last event id in effect (`id` field), when the server sent one. */
    id?: string;
    /** Reconnection time in milliseconds (`retry` field). */
    retry?: number;
    /** Milliseconds since the request was sent. */
    receivedAt: number;
}

/** What is known about a streamed response as soon as its headers arrive. */
export interface StreamHead {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    contentType: string;
}

export interface HttpResponse {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    /**
     * The body as text. Empty for a binary body (see `binary`), which is never decoded: decoding
     * would corrupt it and the viewer would show garbage.
     */
    body: string;
    contentType: string;
    durationMs: number;
    sizeBytes: number;
    /** The body was cut at the request's response size limit. */
    truncated?: boolean;
    /** The exact bytes received, kept so saving a response never alters it. */
    bytes?: Uint8Array;
    /** The body is not text; it can be saved but not shown in the body viewer. */
    binary?: boolean;
    /** Set for gRPC responses: the call's status, which the HTTP-shaped fields above summarize. */
    grpc?: { code: number; name: string; details: string; trailers: Record<string, string> };
    /** Set for `text/event-stream` responses: the events received, in order. */
    stream?: {
        events: SseEvent[];
        /** `stopped`: the user stopped an open stream; `closed`: the server ended it. */
        ended: 'closed' | 'stopped';
        /** Older events dropped from `events` to bound memory. */
        dropped: number;
    };
}

/**
 * Progress callbacks for streaming responses. A runtime calls them only when the response is a
 * stream (`text/event-stream`); ordinary responses never touch them.
 */
export interface ExecutionHooks {
    /** The response headers arrived and the body is a stream that stays open. */
    onStreamStart?(head: StreamHead): void;
    /** Events that arrived since the last call. */
    onStreamEvents?(events: SseEvent[]): void;
}

/** Messages the desktop main process pushes while a stream is open. */
export type HttpStreamMessage =
    { type: 'start'; head: StreamHead } | { type: 'events'; events: SseEvent[] };

export interface HttpRuntime {
    readonly kind: 'browser' | 'electron';
    execute(
        request: PreparedRequest,
        signal?: AbortSignal,
        hooks?: ExecutionHooks,
    ): Promise<HttpResponse>;
}

/**
 * Storage for every workspace. Implementations differ only in where the bytes land (browser
 * IndexedDB, desktop application data); the workspace semantics live above this interface.
 */
export interface WorkspaceRepository {
    /** Every known workspace, most recently updated first. */
    listWorkspaces(): Promise<WorkspaceMeta[]>;
    getWorkspace(id: string): Promise<Workspace | null>;
    saveWorkspace(workspace: Workspace): Promise<void>;
    deleteWorkspace(id: string): Promise<void>;
    /** Id of the workspace to restore on the next start, when it still exists. */
    getActiveWorkspaceId(): Promise<string | null>;
    setActiveWorkspaceId(id: string): Promise<void>;
    /** Unsaved edits of open requests, kept so they survive a reload. Keyed by request id. */
    getDrafts(workspaceId: string): Promise<Record<string, HttpRequest>>;
    saveDrafts(workspaceId: string, drafts: Record<string, HttpRequest>): Promise<void>;
}

export interface HistoryRepository {
    list(workspaceId: string): Promise<HistoryEntry[]>;
    /** Adds an entry and returns the retained list, newest first. */
    add(workspaceId: string, entry: HistoryEntry): Promise<HistoryEntry[]>;
    /** Deletes the given entries and returns what is left, newest first. */
    remove(workspaceId: string, entryIds: string[]): Promise<HistoryEntry[]>;
    clear(workspaceId: string): Promise<void>;
}

export type AppErrorCode =
    | 'NETWORK_ERROR'
    | 'DNS_ERROR'
    | 'CONNECTION_TIMEOUT'
    | 'TLS_ERROR'
    | 'AUTHENTICATION_ERROR'
    | 'INVALID_REQUEST'
    | 'UNKNOWN_ERROR';

export class AppError extends Error {
    constructor(
        public readonly code: AppErrorCode,
        message: string,
        options?: ErrorOptions,
    ) {
        super(message, options);
        this.name = 'AppError';
    }
}

/** Plain-object error form that survives Electron IPC structured cloning. */
export interface SerializedAppError {
    code: AppErrorCode;
    message: string;
}

export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: SerializedAppError };

export const serializeError = (error: unknown, fallback: SerializedAppError): SerializedAppError =>
    error instanceof AppError ? { code: error.code, message: error.message } : fallback;

/** Project documentation; the only external URL the desktop shell will open. */
export const DOCUMENTATION_URL = 'https://github.com/yamatrireddy/httpreq';

/**
 * Lightweight reachability probe (an empty 204 response, as used for captive-portal detection).
 * It is only requested on connectivity changes, never on a continuous timer while online.
 */
export const CONNECTIVITY_PROBE_URL = 'https://www.gstatic.com/generate_204';

/** Window and edit actions the renderer may ask the Electron main process to perform. */
export const WINDOW_ACTIONS = [
    'undo',
    'redo',
    'cut',
    'copy',
    'paste',
    'select-all',
    'zoom-in',
    'zoom-out',
    'zoom-reset',
    'minimize',
    'toggle-maximize',
    'close',
    'toggle-fullscreen',
    'toggle-devtools',
    'quit',
] as const;

export type WindowAction = (typeof WINDOW_ACTIONS)[number];

export const isWindowAction = (value: unknown): value is WindowAction =>
    typeof value === 'string' && (WINDOW_ACTIONS as readonly string[]).includes(value);

/** Application commands the native (macOS) menu forwards to the renderer. */
export const MENU_COMMANDS = [
    'request.new',
    'file.import',
    'file.export',
    'request.close',
    'request.save',
    'request.save-as',
    'request.send',
    'request.duplicate',
    'request.focus-url',
    'view.response-right',
    'view.response-bottom',
    'view.toggle-sidebar',
    'view.toggle-status-bar',
    'tools.settings',
    'help.shortcuts',
    'help.check-updates',
    'help.about',
] as const;

export type MenuCommand = (typeof MENU_COMMANDS)[number];

export const isMenuCommand = (value: unknown): value is MenuCommand =>
    typeof value === 'string' && (MENU_COMMANDS as readonly string[]).includes(value);

export interface DesktopWindowState {
    maximized: boolean;
    fullscreen: boolean;
    /** Electron zoom level of the window; 0 is 100%. */
    zoomLevel: number;
}

/** Identity of a build of the app: the same for the web bundle and the desktop app that ships it. */
export interface BuildInfo {
    version: string;
    /** Short commit hash, or `dev` for a build outside a git checkout. */
    commit: string;
    /** ISO 8601 time of the build. */
    builtAt: string;
}

/** Where published releases live; the desktop app checks it for newer versions. */
export const RELEASES_URL = 'https://github.com/yamatrireddy/httpreq/releases';
export const LATEST_RELEASE_API =
    'https://api.github.com/repos/yamatrireddy/httpreq/releases/latest';

export interface AppInfo {
    name: string;
    version: string;
    platform: string;
    versions: { electron: string; chrome: string; node: string };
}

/**
 * Where the desktop auto-updater is. `available` and `downloading` happen without interrupting
 * the user; `ready` means the new version is downloaded and installing restarts the app.
 * `unsupported` is a build that cannot replace itself (a Linux package, an unsigned macOS app), so
 * the user is pointed to the releases page instead.
 */
export type DesktopUpdateStatus =
    | 'idle'
    | 'checking'
    | 'available'
    | 'downloading'
    | 'ready'
    | 'current'
    | 'error'
    | 'unsupported';

export interface DesktopUpdateState {
    status: DesktopUpdateStatus;
    /** The newer version, once known. */
    version?: string;
    /** Download progress, 0 to 100, while `downloading`. */
    percent?: number;
    /** What went wrong, when `error`. The installed version keeps working. */
    error?: string;
}

export const DESKTOP_UPDATE_STATUSES: readonly DesktopUpdateStatus[] = [
    'idle',
    'checking',
    'available',
    'downloading',
    'ready',
    'current',
    'error',
    'unsupported',
];

export const isDesktopUpdateState = (value: unknown): value is DesktopUpdateState =>
    !!value &&
    typeof value === 'object' &&
    (DESKTOP_UPDATE_STATUSES as readonly unknown[]).includes((value as DesktopUpdateState).status);

export interface UpdatesBridge {
    getState(): Promise<DesktopUpdateState>;
    /** Looks for an update now (the periodic check runs on its own). */
    check(): Promise<DesktopUpdateState>;
    /** Quits and installs a downloaded update, then relaunches. Ignored unless one is ready. */
    install(): void;
    onStateChange(listener: (state: DesktopUpdateState) => void): () => void;
}

/** Desktop-shell operations exposed by the preload. Every call is validated in the main process. */
export interface DesktopBridge {
    readonly platform: string;
    getAppInfo(): Promise<AppInfo>;
    getWindowState(): Promise<DesktopWindowState>;
    performAction(action: WindowAction): void;
    /** Opens an allow-listed documentation URL in the system browser. */
    openExternal(url: string): void;
    /** Opens an OAuth 2.0 authorization page (http/https only) in the system browser. */
    openAuthorizationUrl(url: string): void;
    /** Resolves whether the internet is reachable, using a native lightweight probe. */
    checkConnectivity(): Promise<boolean>;
    /**
     * Writes plain text to the system clipboard through Electron's clipboard module. The renderer's
     * own Clipboard API is not used in the desktop app: its permission is denied there, and it
     * also fails once a user gesture has expired (e.g. after building a cURL command).
     */
    writeClipboardText(text: string): Promise<void>;
    /** Reads plain text from the system clipboard, for pasting into the terminal. */
    readClipboardText(): Promise<string>;
    /** Background updates; absent in builds that cannot update themselves (e.g. unpackaged). */
    updates?: UpdatesBridge;
    onWindowStateChange(listener: (state: DesktopWindowState) => void): () => void;
    onMenuCommand(listener: (command: MenuCommand) => void): () => void;
}

/**
 * WebSocket operations the preload exposes. The main process owns the socket, so the renderer
 * gets events and never a handle to anything privileged.
 */
export interface WebSocketBridge {
    open(socketId: string, prepared: PreparedWebSocket): Promise<IpcResult<void>>;
    sendText(socketId: string, data: string): void;
    /** Binary frames cross IPC as a plain byte array. */
    sendBinary(socketId: string, data: Uint8Array): void;
    close(socketId: string, code?: number, reason?: string): void;
    onEvent(listener: (socketId: string, event: WebSocketEvent) => void): () => void;
}

/**
 * Operations the Electron preload exposes to the renderer as `window.httpreq`.
 *
 * Each capability is optional: the renderer must treat a missing bridge as "this platform cannot
 * do that" rather than assuming a desktop build has everything.
 */
export interface HttpReqBridge {
    executeHttp(request: PreparedRequest, executionId: string): Promise<IpcResult<HttpResponse>>;
    cancelHttp(executionId: string): void;
    /** Progress of streaming (SSE) responses, keyed by execution id. */
    onHttpStream?(listener: (executionId: string, message: HttpStreamMessage) => void): () => void;
    desktop?: DesktopBridge;
    webSocket?: WebSocketBridge;
    ssh?: SshBridge;
    tunnels?: TunnelBridge;
    grpc?: GrpcBridge;
    mqtt?: MqttBridge;
    dbStudio?: DbStudioBridge;
}
