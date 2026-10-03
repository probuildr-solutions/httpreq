/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import {
    isDbFileProgress,
    isDbEditProgress,
    isDbHostEvent,
    isDbHostStatus,
    isDbItemsProgress,
    isDbSearchHits,
    isDbSearchProgress,
    isDesktopUpdateState,
    isMenuCommand,
    isMqttStatus,
    isSshStatus,
    type DbStudioBridge,
    type DesktopBridge,
    type DesktopWindowState,
    type GrpcBridge,
    type HostKeyPrompt,
    type HttpStreamMessage,
    type HttpReqBridge,
    type MenuCommand,
    type MqttBridge,
    type MqttEvent,
    type SshBridge,
    type SshSessionEvent,
    type UpdatesBridge,
    type TunnelBridge,
    type TunnelRuntimeState,
    type WebSocketBridge,
    type WebSocketEvent,
} from '@httpreq/shared';

/**
 * The only surface the renderer sees. Nothing here hands out `require`, `fs`, `child_process` or
 * the raw `ipcRenderer`: each function is a named operation on a fixed channel, and every payload
 * is validated again in the main process before anything privileged happens.
 *
 * Events are validated on the way in as well, so a compromised main-process message cannot push an
 * arbitrary object into React state.
 */

// Each subscription wraps the listener so the renderer never receives the raw IpcRendererEvent
// (which exposes `sender`), and returns an unsubscribe function.
const subscribe = <T>(
    channel: string,
    listener: (value: T) => void,
    accept: (value: unknown) => value is T,
) => {
    const handler = (_event: IpcRendererEvent, value: unknown) => {
        if (accept(value)) listener(value);
    };
    ipcRenderer.on(channel, handler);
    return () => void ipcRenderer.removeListener(channel, handler);
};

/** Subscription for channels that carry an owning id alongside the payload. */
const subscribeKeyed = <T>(
    channel: string,
    listener: (id: string, value: T) => void,
    accept: (value: unknown) => value is T,
) => {
    const handler = (_event: IpcRendererEvent, id: unknown, value: unknown) => {
        if (typeof id === 'string' && accept(value)) listener(id, value);
    };
    ipcRenderer.on(channel, handler);
    return () => void ipcRenderer.removeListener(channel, handler);
};

const isWindowState = (value: unknown): value is DesktopWindowState =>
    !!value &&
    typeof (value as DesktopWindowState).maximized === 'boolean' &&
    typeof (value as DesktopWindowState).fullscreen === 'boolean' &&
    typeof (value as DesktopWindowState).zoomLevel === 'number';

const isWebSocketEvent = (value: unknown): value is WebSocketEvent => {
    if (!value || typeof value !== 'object') return false;
    const type = (value as { type?: unknown }).type;
    return type === 'open' || type === 'message' || type === 'close' || type === 'error';
};

const isMqttEvent = (value: unknown): value is MqttEvent => {
    if (!value || typeof value !== 'object') return false;
    const event = value as { type?: unknown; status?: unknown };
    switch (event.type) {
        case 'status':
            return isMqttStatus(event.status);
        case 'message':
        case 'error':
            return true;
        default:
            return false;
    }
};

const isHttpStreamMessage = (value: unknown): value is HttpStreamMessage => {
    if (!value || typeof value !== 'object') return false;
    const message = value as { type?: unknown; head?: unknown; events?: unknown };
    return (
        (message.type === 'start' && !!message.head && typeof message.head === 'object') ||
        (message.type === 'events' && Array.isArray(message.events))
    );
};

const isSshSessionEvent = (value: unknown): value is SshSessionEvent => {
    if (!value || typeof value !== 'object') return false;
    const event = value as { type?: unknown; status?: unknown; data?: unknown };
    switch (event.type) {
        case 'status':
            return isSshStatus(event.status);
        case 'data':
            return typeof event.data === 'string';
        case 'error':
        case 'closed':
            return true;
        default:
            return false;
    }
};

const isHostKeyPrompt = (value: unknown): value is HostKeyPrompt =>
    !!value &&
    typeof value === 'object' &&
    typeof (value as HostKeyPrompt).host === 'string' &&
    typeof (value as HostKeyPrompt).fingerprint === 'string';

const isTunnelState = (value: unknown): value is TunnelRuntimeState =>
    !!value &&
    typeof value === 'object' &&
    typeof (value as TunnelRuntimeState).tunnelId === 'string' &&
    typeof (value as TunnelRuntimeState).status === 'string';

const updates: UpdatesBridge = {
    getState: () => ipcRenderer.invoke('updates:state'),
    check: () => ipcRenderer.invoke('updates:check'),
    install: () => ipcRenderer.send('updates:install'),
    onStateChange: (listener) => subscribe('updates:state-changed', listener, isDesktopUpdateState),
};

const desktop: DesktopBridge = {
    platform: process.platform,
    getAppInfo: () => ipcRenderer.invoke('app:info'),
    getWindowState: () => ipcRenderer.invoke('window:state'),
    performAction: (action) => ipcRenderer.send('window:action', action),
    openExternal: (url) => ipcRenderer.send('shell:open-external', url),
    openAuthorizationUrl: (url) => ipcRenderer.send('shell:open-authorization-url', url),
    checkConnectivity: () => ipcRenderer.invoke('net:check'),
    writeClipboardText: async (text) => {
        if (!(await ipcRenderer.invoke('clipboard:write-text', text))) {
            throw new Error('The text could not be written to the clipboard.');
        }
    },
    readClipboardText: () => ipcRenderer.invoke('clipboard:read-text'),
    updates,
    onWindowStateChange: (listener) => subscribe('window:state-changed', listener, isWindowState),
    onMenuCommand: (listener) => subscribe<MenuCommand>('menu:command', listener, isMenuCommand),
};

const webSocket: WebSocketBridge = {
    open: (socketId, prepared) => ipcRenderer.invoke('ws:open', socketId, prepared),
    sendText: (socketId, data) => ipcRenderer.send('ws:send-text', socketId, data),
    // Copied into a plain array-backed view so the structured clone carries only the bytes.
    sendBinary: (socketId, data) =>
        ipcRenderer.send('ws:send-binary', socketId, new Uint8Array(data)),
    close: (socketId, code, reason) => ipcRenderer.send('ws:close', socketId, code, reason),
    onEvent: (listener) => subscribeKeyed('ws:event', listener, isWebSocketEvent),
};

const grpc: GrpcBridge = {
    call: (callId, prepared) => ipcRenderer.invoke('grpc:call', callId, prepared),
    cancel: (callId) => ipcRenderer.send('grpc:cancel', callId),
};

const mqtt: MqttBridge = {
    connect: (id, prepared) => ipcRenderer.invoke('mqtt:connect', id, prepared),
    publish: (id, input) => ipcRenderer.invoke('mqtt:publish', id, input),
    subscribe: (id, subscriptions) => ipcRenderer.invoke('mqtt:subscribe', id, subscriptions),
    unsubscribe: (id, topics) => ipcRenderer.invoke('mqtt:unsubscribe', id, topics),
    disconnect: (id) => ipcRenderer.invoke('mqtt:disconnect', id),
    onEvent: (listener) => subscribeKeyed('mqtt:event', listener, isMqttEvent),
};

const ssh: SshBridge = {
    listSessions: () => ipcRenderer.invoke('ssh:list'),
    connect: (options) => ipcRenderer.invoke('ssh:connect', options),
    testConnection: (profile) => ipcRenderer.invoke('ssh:test', profile),
    disconnect: (sessionId) => ipcRenderer.invoke('ssh:disconnect', sessionId),
    write: (sessionId, data) => ipcRenderer.send('ssh:write', sessionId, data),
    resize: (sessionId, size) => ipcRenderer.send('ssh:resize', sessionId, size),
    pickPrivateKey: () => ipcRenderer.invoke('ssh:pick-key'),
    // One-way: a secret can be written to the vault, never read back out of it.
    setCredential: (input) => ipcRenderer.invoke('ssh:set-credential', input),
    hasCredential: (credentialId) => ipcRenderer.invoke('ssh:has-credential', credentialId),
    deleteCredential: (credentialId) => ipcRenderer.invoke('ssh:delete-credential', credentialId),
    listKnownHosts: () => ipcRenderer.invoke('ssh:known-hosts'),
    forgetKnownHost: (host, port) => ipcRenderer.invoke('ssh:forget-host', host, port),
    resolveHostKey: (promptId, decision) =>
        ipcRenderer.send('ssh:host-key-decision', promptId, decision),
    onSessionEvent: (listener) => subscribeKeyed('ssh:event', listener, isSshSessionEvent),
    onHostKeyPrompt: (listener) => subscribeKeyed('ssh:host-key-prompt', listener, isHostKeyPrompt),
};

const tunnels: TunnelBridge = {
    start: (profile, sshProfile) => ipcRenderer.invoke('tunnel:start', profile, sshProfile),
    stop: (tunnelId) => ipcRenderer.invoke('tunnel:stop', tunnelId),
    list: () => ipcRenderer.invoke('tunnel:list'),
    isPortAvailable: (address, port) => ipcRenderer.invoke('tunnel:port-available', address, port),
    onStateChange: (listener) => subscribe('tunnel:state', listener, isTunnelState),
};

const dbStudio: DbStudioBridge = {
    getStatus: () => ipcRenderer.invoke('dbstudio:status'),
    pickFile: () => ipcRenderer.invoke('dbstudio:file:pick'),
    openFile: (token) => ipcRenderer.invoke('dbstudio:file:open', token),
    readLines: (fileId, from, count) =>
        ipcRenderer.invoke('dbstudio:file:lines', fileId, from, count),
    closeFile: (fileId) => ipcRenderer.invoke('dbstudio:file:close', fileId),
    onFileProgress: (listener) => subscribe('dbstudio:file-progress', listener, isDbFileProgress),
    onHostStatus: (listener) => subscribe('dbstudio:host-status', listener, isDbHostStatus),
    analyzeFile: (fileId, format) => ipcRenderer.invoke('dbstudio:items:analyze', fileId, format),
    listItems: (fileId, from, count) =>
        ipcRenderer.invoke('dbstudio:items:list', fileId, from, count),
    readItem: (fileId, index) => ipcRenderer.invoke('dbstudio:items:read', fileId, index),
    itemAt: (fileId, offset) => ipcRenderer.invoke('dbstudio:items:at', fileId, offset),
    startSearch: (fileId, searchId, query, maxHits) =>
        ipcRenderer.invoke('dbstudio:search:start', fileId, searchId, query, maxHits),
    cancelSearch: (searchId) => ipcRenderer.invoke('dbstudio:search:cancel', searchId),
    dbRequest: (op, payload) => ipcRenderer.invoke('dbstudio:db:request', op, payload),
    onDbEvent: (listener) => subscribe('dbstudio:db-event', listener, isDbHostEvent),
    setDbPassword: (profileId, password) =>
        ipcRenderer.invoke('dbstudio:db:set-password', profileId, password),
    hasDbPassword: (profileId) => ipcRenderer.invoke('dbstudio:db:has-password', profileId),
    deleteDbPassword: (profileId) => ipcRenderer.invoke('dbstudio:db:delete-password', profileId),
    readText: (fileId) => ipcRenderer.invoke('dbstudio:edit:read-text', fileId),
    saveFile: (fileId, pieces, eol) =>
        ipcRenderer.invoke('dbstudio:edit:save', fileId, pieces, eol),
    saveFileAs: (fileId, pieces, eol) =>
        ipcRenderer.invoke('dbstudio:edit:save-as', fileId, pieces, eol),
    replaceAll: (fileId, query, replacement) =>
        ipcRenderer.invoke('dbstudio:edit:replace-all', fileId, query, replacement),
    onEditProgress: (listener) => subscribe('dbstudio:edit-progress', listener, isDbEditProgress),
    onItemsProgress: (listener) =>
        subscribe('dbstudio:items-progress', listener, isDbItemsProgress),
    onSearchHits: (listener) => subscribe('dbstudio:search-hits', listener, isDbSearchHits),
    onSearchProgress: (listener) =>
        subscribe('dbstudio:search-progress', listener, isDbSearchProgress),
};

const bridge: HttpReqBridge = {
    executeHttp: (request, executionId) => ipcRenderer.invoke('http:execute', request, executionId),
    cancelHttp: (executionId) => ipcRenderer.send('http:cancel', executionId),
    onHttpStream: (listener) => subscribeKeyed('http:stream', listener, isHttpStreamMessage),
    desktop,
    webSocket,
    grpc,
    mqtt,
    ssh,
    tunnels,
    dbStudio,
};

contextBridge.exposeInMainWorld('httpreq', bridge);
