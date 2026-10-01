/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import {
    createCollection,
    createEmptyBody,
    createEmptyRequest,
    createEnvironment,
    createId,
    createSshProfile,
    createTunnelProfile,
    createWebSocketRequest,
    DEFAULT_REQUEST_SETTINGS,
    DEFAULT_SSH_PORT,
    DEFAULT_WEBSOCKET_SETTINGS,
    isSshAuthType,
    isTunnelType,
    LOOPBACK_BIND_ADDRESS,
    WEBSOCKET_PAYLOAD_TYPES,
    isHttpMethod,
    TEXT_CONTENT_TYPES,
    BODY_MODES,
    WORKSPACE_VERSION,
    withEnvironmentLink,
    type AuthConfig,
    type Collection,
    type Environment,
    type EnvironmentVariable,
    type FileReference,
    type Folder,
    type HttpRequest,
    type KeyValueItem,
    type MultipartField,
    type RequestBody,
    type RequestSettings,
    type SshProfile,
    type TunnelProfile,
    type WebSocketPayloadType,
    type WebSocketRequest,
    type WebSocketSettings,
    type Workspace,
} from '@httpreq/shared';
import { normalizeProtocolFields } from './protocols';
import { urlWithParams } from './query';

export * from './protocols';
export * from './query';
export * from './tree';
export * from './workspaces';

export const DEFAULT_WORKSPACE_ID = 'default';

/** A first-run workspace with one example collection, request and environment. */
export const createDefaultWorkspace = (): Workspace => {
    const collection = createCollection('Sample API');
    const request: HttpRequest = {
        ...createEmptyRequest(collection.id),
        name: 'Get request',
        url: '{{base_url}}/get',
    };
    const environment: Environment = {
        ...createEnvironment('Development'),
        variables: [
            {
                id: createId(),
                key: 'base_url',
                value: 'https://httpbin.org',
                enabled: true,
                secret: false,
            },
        ],
    };
    return {
        version: WORKSPACE_VERSION,
        id: DEFAULT_WORKSPACE_ID,
        name: 'My Workspace',
        // The sample request uses {{base_url}}, so its collection is linked to the environment that defines it.
        collections: [{ ...collection, environmentId: environment.id }],
        folders: [],
        requests: [request],
        websocketRequests: [],
        environments: [environment],
        activeEnvironmentId: null,
        sshProfiles: [],
        tunnelProfiles: [],
        openRequestIds: [request.id],
        updatedAt: new Date().toISOString(),
    };
};

/** An empty workspace, as created from the workspace switcher. */
export const createWorkspace = (name = 'New Workspace', workspaceId = createId()): Workspace => ({
    version: WORKSPACE_VERSION,
    id: workspaceId,
    name: name.trim() || 'New Workspace',
    collections: [],
    folders: [],
    requests: [],
    websocketRequests: [],
    environments: [],
    activeEnvironmentId: null,
    sshProfiles: [],
    tunnelProfiles: [],
    openRequestIds: [],
    updatedAt: new Date().toISOString(),
});

/* ---------- Normalization of untrusted stored or imported data ---------- */

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => !!value && typeof value === 'object';
const str = (value: unknown, fallback = '') => (typeof value === 'string' ? value : fallback);
const bool = (value: unknown, fallback: boolean) => (typeof value === 'boolean' ? value : fallback);
const num = (value: unknown, fallback: number) =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
const id = (value: unknown) => (typeof value === 'string' && value ? value : createId());
const list = (value: unknown) => (Array.isArray(value) ? value.filter(isObject) : []);

/** Validates an auth object; storage passes the provider registry's stricter deserializer. */
export type AuthNormalizer = (value: unknown) => AuthConfig | null;

const basicAuthNormalizer: AuthNormalizer = (value) =>
    isObject(value) && typeof value.type === 'string' ? (value as AuthConfig) : null;

const normalizeKeyValue = (value: Json): KeyValueItem => ({
    id: id(value.id),
    key: str(value.key),
    value: str(value.value),
    enabled: bool(value.enabled, true),
    ...(typeof value.description === 'string' && value.description
        ? { description: value.description }
        : {}),
    ...(value.secret === true ? { secret: true } : {}),
});

const normalizeFile = (value: unknown): FileReference | null =>
    isObject(value) && typeof value.name === 'string'
        ? { id: id(value.id), name: value.name, size: num(value.size, 0), type: str(value.type) }
        : null;

const normalizeBody = (value: unknown): RequestBody => {
    const body = createEmptyBody();
    if (!isObject(value)) return body;
    // Version 1 stored `{ type: 'none' | 'json', content }`.
    if (typeof value.type === 'string' && !('mode' in value)) {
        return value.type === 'json' ? { ...body, mode: 'json', json: str(value.content) } : body;
    }
    const mode = (BODY_MODES as readonly string[]).includes(str(value.mode))
        ? (value.mode as RequestBody['mode'])
        : 'none';
    const textContentType = (TEXT_CONTENT_TYPES as readonly string[]).includes(
        str(value.textContentType),
    )
        ? (value.textContentType as RequestBody['textContentType'])
        : 'text/plain';
    return {
        mode,
        json: str(value.json),
        text: str(value.text),
        textContentType,
        formUrlEncoded: list(value.formUrlEncoded).map(normalizeKeyValue),
        multipart: list(value.multipart).map((field): MultipartField => ({
            ...normalizeKeyValue(field),
            kind: field.kind === 'file' ? 'file' : 'text',
            file: normalizeFile(field.file),
        })),
        binary: normalizeFile(value.binary),
    };
};

const normalizeSettings = (value: unknown): RequestSettings => {
    const settings = isObject(value) ? value : {};
    const defaults = DEFAULT_REQUEST_SETTINGS;
    return {
        timeoutMs: num(settings.timeoutMs, defaults.timeoutMs),
        followRedirects: bool(settings.followRedirects, defaults.followRedirects),
        verifyTls: bool(settings.verifyTls, defaults.verifyTls),
        sendCookies: bool(settings.sendCookies, defaults.sendCookies),
        responseSizeLimitMb: num(settings.responseSizeLimitMb, defaults.responseSizeLimitMb),
    };
};

export const normalizeRequest = (
    value: Json,
    parentId: string | null,
    normalizeAuth: AuthNormalizer = basicAuthNormalizer,
): HttpRequest => {
    const scripts = isObject(value.scripts) ? value.scripts : {};
    return {
        id: id(value.id),
        name: str(value.name).trim() || 'Untitled Request',
        parentId,
        ...normalizeProtocolFields(value),
        method: isHttpMethod(value.method) ? value.method : 'GET',
        url: str(value.url),
        params: list(value.params).map(normalizeKeyValue),
        ...(Array.isArray(value.pathVariables) && value.pathVariables.length
            ? { pathVariables: list(value.pathVariables).map(normalizeKeyValue) }
            : {}),
        headers: list(value.headers).map(normalizeKeyValue),
        body: normalizeBody(value.body),
        auth: normalizeAuth(value.auth) ?? (parentId ? { type: 'inherit' } : { type: 'none' }),
        settings: normalizeSettings(value.settings),
        scripts: {
            preRequest: str(scripts.preRequest),
            postResponse: str(scripts.postResponse),
            tests: str(scripts.tests),
        },
        description: str(value.description),
        ...(typeof value.environmentId === 'string' && value.environmentId
            ? { environmentId: value.environmentId }
            : {}),
    };
};

const normalizeWebSocketSettings = (value: unknown): WebSocketSettings => {
    const settings = isObject(value) ? value : {};
    const defaults = DEFAULT_WEBSOCKET_SETTINGS;
    return {
        handshakeTimeoutMs: num(settings.handshakeTimeoutMs, defaults.handshakeTimeoutMs),
        verifyTls: bool(settings.verifyTls, defaults.verifyTls),
        autoReconnect: bool(settings.autoReconnect, defaults.autoReconnect),
        reconnectDelayMs: num(settings.reconnectDelayMs, defaults.reconnectDelayMs),
        messageLimit: Math.max(1, num(settings.messageLimit, defaults.messageLimit)),
    };
};

export const normalizeWebSocketRequest = (
    value: Json,
    parentId: string | null,
    normalizeAuth: AuthNormalizer = basicAuthNormalizer,
): WebSocketRequest => {
    const payloadType = str(value.draftPayloadType);
    return {
        id: id(value.id),
        name: str(value.name).trim() || 'Untitled Socket',
        parentId,
        url: str(value.url),
        params: list(value.params).map(normalizeKeyValue),
        headers: list(value.headers).map(normalizeKeyValue),
        subprotocols: Array.isArray(value.subprotocols)
            ? value.subprotocols.filter(
                  (item): item is string => typeof item === 'string' && !!item,
              )
            : [],
        auth: normalizeAuth(value.auth) ?? (parentId ? { type: 'inherit' } : { type: 'none' }),
        settings: normalizeWebSocketSettings(value.settings),
        draftPayloadType: (WEBSOCKET_PAYLOAD_TYPES as readonly string[]).includes(payloadType)
            ? (payloadType as WebSocketPayloadType)
            : 'text',
        draftMessage: str(value.draftMessage),
        description: str(value.description),
    };
};

/**
 * Desktop connection profiles. A stored profile can never contain a password or passphrase, so
 * normalization only has to repair shapes; anything secret-looking is simply not a field here.
 */
export const normalizeSshProfile = (value: Json): SshProfile => {
    const fallback = createSshProfile();
    const port = num(value.port, DEFAULT_SSH_PORT);
    return {
        id: id(value.id),
        name: str(value.name).trim() || 'Connection',
        host: str(value.host).trim(),
        port: Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : DEFAULT_SSH_PORT,
        username: str(value.username).trim(),
        authType: isSshAuthType(value.authType) ? value.authType : 'password',
        privateKeyPath: str(value.privateKeyPath),
        // A profile that lost its vault key gets a fresh one; the old secret becomes unreachable.
        credentialId: str(value.credentialId) || fallback.credentialId,
        keepAliveSeconds: num(value.keepAliveSeconds, fallback.keepAliveSeconds),
        connectTimeoutMs: num(value.connectTimeoutMs, fallback.connectTimeoutMs),
        description: str(value.description),
    };
};

export const normalizeTunnelProfile = (value: Json): TunnelProfile => {
    const fallback = createTunnelProfile();
    const port = (raw: unknown) => {
        const parsed = num(raw, 0);
        return Number.isInteger(parsed) && parsed >= 0 && parsed <= 65_535 ? parsed : 0;
    };
    return {
        id: id(value.id),
        name: str(value.name).trim() || 'Tunnel',
        sshProfileId: str(value.sshProfileId),
        type: isTunnelType(value.type) ? value.type : 'local',
        // Anything unparseable falls back to loopback rather than to a public interface.
        localBindAddress: str(value.localBindAddress).trim() || LOOPBACK_BIND_ADDRESS,
        localPort: port(value.localPort),
        remoteHost: str(value.remoteHost).trim(),
        remotePort: port(value.remotePort),
        autoStart: bool(value.autoStart, fallback.autoStart),
        description: str(value.description),
    };
};

const normalizeVariable = (value: Json): EnvironmentVariable => ({
    id: id(value.id),
    key: str(value.key),
    value: str(value.value),
    enabled: bool(value.enabled, true),
    secret: bool(value.secret, false),
});

/**
 * Turns stored or imported JSON into a valid current-version workspace, migrating version 1 (a
 * flat list of open requests) and repairing dangling references. Returns `null` when the value
 * is not a workspace at all.
 */
export const migrateWorkspace = (
    value: unknown,
    normalizeAuth: AuthNormalizer = basicAuthNormalizer,
): Workspace | null => {
    if (!isObject(value) || typeof value.id !== 'string' || !Array.isArray(value.requests)) {
        return null;
    }
    const linkOf = (item: Json) =>
        typeof item.environmentId === 'string' && item.environmentId
            ? { environmentId: item.environmentId }
            : {};
    const collections: Collection[] = list(value.collections).map((item) => ({
        id: id(item.id),
        name: str(item.name).trim() || 'Collection',
        description: str(item.description),
        auth: normalizeAuth(item.auth) ?? { type: 'none' },
        ...linkOf(item),
    }));
    // Keep only folders reachable from a collection (orphaned chains are dropped).
    const reachable = new Set(collections.map((item) => item.id));
    const rawFolders = list(value.folders).filter((item) => typeof item.id === 'string');
    let grew = true;
    while (grew) {
        grew = false;
        for (const item of rawFolders) {
            if (!reachable.has(str(item.id)) && reachable.has(str(item.parentId))) {
                reachable.add(str(item.id));
                grew = true;
            }
        }
    }
    const folders: Folder[] = rawFolders
        .filter((item) => reachable.has(str(item.id)) && str(item.id) !== str(item.parentId))
        .map((item) => ({
            id: str(item.id),
            name: str(item.name).trim() || 'Folder',
            parentId: str(item.parentId),
            description: str(item.description),
            auth: normalizeAuth(item.auth) ?? { type: 'inherit' },
            ...linkOf(item),
        }));
    const liveContainers = new Set([...collections, ...folders].map((item) => item.id));

    const version1 = value.version !== WORKSPACE_VERSION;
    const containerOf = (item: Json) =>
        typeof item.parentId === 'string' && liveContainers.has(item.parentId)
            ? item.parentId
            : null;
    const requests = list(value.requests).map((item) => {
        const request = normalizeRequest(item, containerOf(item), normalizeAuth);
        // Version 1 appended enabled params at send time; they now live in the URL.
        return version1 ? { ...request, url: urlWithParams(request.url, request.params) } : request;
    });
    // Versions 1 and 2 had no WebSocket requests, so the list is simply absent there.
    const websocketRequests = list(value.websocketRequests).map((item) =>
        normalizeWebSocketRequest(item, containerOf(item), normalizeAuth),
    );
    const sshProfiles = list(value.sshProfiles).map(normalizeSshProfile);
    const knownSshProfiles = new Set(sshProfiles.map((profile) => profile.id));
    // A tunnel whose SSH profile is gone cannot start, but it is kept so the user can repoint it.
    const tunnelProfiles = list(value.tunnelProfiles)
        .map(normalizeTunnelProfile)
        .map((tunnel) =>
            knownSshProfiles.has(tunnel.sshProfileId) ? tunnel : { ...tunnel, sshProfileId: '' },
        );
    const requestIds = new Set([
        ...requests.map((item) => item.id),
        ...websocketRequests.map((item) => item.id),
    ]);

    const environments: Environment[] = list(value.environments).map((item) => ({
        id: id(item.id),
        name: str(item.name).trim() || 'Environment',
        variables: list(item.variables).map(normalizeVariable),
    }));
    const knownEnvironments = new Set(environments.map((item) => item.id));
    const withKnownLink = <T extends { environmentId?: string | null }>(item: T): T => {
        if (!item.environmentId || knownEnvironments.has(item.environmentId)) return item;
        return withEnvironmentLink(item, null);
    };
    const activeEnvironmentId = environments.some((item) => item.id === value.activeEnvironmentId)
        ? (value.activeEnvironmentId as string)
        : null;
    const open = version1
        ? requests.map((item) => item.id)
        : (Array.isArray(value.openRequestIds) ? value.openRequestIds : []).filter(
              (openId): openId is string => typeof openId === 'string' && requestIds.has(openId),
          );

    return {
        version: WORKSPACE_VERSION,
        id: value.id,
        name: str(value.name).trim() || 'My Workspace',
        collections: collections.map(withKnownLink),
        folders: folders.map(withKnownLink),
        requests: requests.map(withKnownLink),
        websocketRequests,
        environments,
        activeEnvironmentId,
        sshProfiles,
        tunnelProfiles,
        openRequestIds: [...new Set(open)],
        updatedAt: str(value.updatedAt, new Date().toISOString()),
    };
};

export const validateWorkspace = (value: unknown): value is Workspace =>
    isObject(value) &&
    value.version === WORKSPACE_VERSION &&
    typeof value.id === 'string' &&
    Array.isArray(value.collections) &&
    Array.isArray(value.folders) &&
    Array.isArray(value.requests) &&
    Array.isArray(value.websocketRequests) &&
    Array.isArray(value.environments) &&
    Array.isArray(value.sshProfiles) &&
    Array.isArray(value.tunnelProfiles) &&
    Array.isArray(value.openRequestIds);

// Re-exported so callers reach every factory through @httpreq/workspace alone.
export { createSshProfile, createTunnelProfile, createWebSocketRequest };
