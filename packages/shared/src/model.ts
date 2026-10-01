/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

/**
 * Request and workspace domain model. Every entity is identified by its `id`; names and URLs are
 * display data only, so renaming or moving never breaks tabs, history or inheritance.
 */

import type { WebSocketRequest } from './websocket';
import type { SshProfile, TunnelProfile } from './ssh';

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export const isHttpMethod = (value: unknown): value is HttpMethod =>
    typeof value === 'string' && (HTTP_METHODS as readonly string[]).includes(value);

export interface KeyValueItem {
    id: string;
    key: string;
    value: string;
    enabled: boolean;
    description?: string;
    /** Masks the value in the editor and keeps literal values out of persisted workspace data. */
    secret?: boolean;
}

/** A file chosen by the user. Its bytes stay in memory for the session and are never persisted. */
export interface FileReference {
    id: string;
    name: string;
    size: number;
    type: string;
}

export interface MultipartField extends KeyValueItem {
    kind: 'text' | 'file';
    file?: FileReference | null;
}

export const BODY_MODES = [
    'none',
    'json',
    'text',
    'form-urlencoded',
    'multipart',
    'binary',
] as const;
export type BodyMode = (typeof BODY_MODES)[number];

export const TEXT_CONTENT_TYPES = [
    'text/plain',
    'application/xml',
    'text/html',
    'application/javascript',
] as const;
export type TextContentType = (typeof TEXT_CONTENT_TYPES)[number];

/**
 * Every mode keeps its own content, so switching body modes never discards what was typed in
 * another mode. Only the active `mode` is sent.
 */
export interface RequestBody {
    mode: BodyMode;
    json: string;
    text: string;
    textContentType: TextContentType;
    formUrlEncoded: KeyValueItem[];
    multipart: MultipartField[];
    binary: FileReference | null;
}

export const JWT_ALGORITHMS = [
    'HS256',
    'HS384',
    'HS512',
    'RS256',
    'RS384',
    'RS512',
    'PS256',
    'PS384',
    'PS512',
    'ES256',
    'ES384',
] as const;
export type JwtAlgorithm = (typeof JWT_ALGORITHMS)[number];

export const OAUTH2_GRANT_TYPES = [
    'authorization_code',
    'authorization_code_pkce',
    'client_credentials',
    'password',
    'refresh_token',
] as const;
export type OAuth2GrantType = (typeof OAUTH2_GRANT_TYPES)[number];

export type NoAuth = { type: 'none' };
export type InheritAuth = { type: 'inherit' };
export type ApiKeyAuth = {
    type: 'api-key';
    key: string;
    value: string;
    location: 'header' | 'query';
};
export type BearerAuth = { type: 'bearer'; token: string; prefix: string };
export type BasicAuth = { type: 'basic'; username: string; password: string };
export type DigestAuth = { type: 'digest'; username: string; password: string };
export type JwtAuth = {
    type: 'jwt';
    algorithm: JwtAlgorithm;
    /** HMAC secret, or a PKCS#8 PEM private key for RSA/ECDSA algorithms. */
    secret: string;
    secretBase64: boolean;
    /** JSON object of additional claims. */
    payload: string;
    /** JSON object of additional JOSE header fields. */
    header: string;
    issuer: string;
    subject: string;
    audience: string;
    /** Lifetime of the token in seconds; 0 omits the `exp` claim. */
    expiresInSeconds: number;
    addTo: 'header' | 'query';
    headerPrefix: string;
    queryParamKey: string;
};
export type OAuth2Auth = {
    type: 'oauth2';
    grantType: OAuth2GrantType;
    authUrl: string;
    tokenUrl: string;
    clientId: string;
    clientSecret: string;
    scope: string;
    callbackUrl: string;
    /** Resource-owner credentials for the legacy password grant. */
    username: string;
    password: string;
    clientAuthentication: 'basic-header' | 'body';
    headerPrefix: string;
    accessToken: string;
    refreshToken: string;
    /** Epoch milliseconds when the access token expires, when the server reported it. */
    expiresAt: number | null;
    /** When set, a retrieved access token is also written to this environment variable. */
    tokenVariable: string;
};

export type AuthConfig =
    NoAuth | InheritAuth | ApiKeyAuth | BearerAuth | BasicAuth | DigestAuth | JwtAuth | OAuth2Auth;

export type AuthType = AuthConfig['type'];

export interface RequestSettings {
    /** Milliseconds; 0 waits indefinitely. */
    timeoutMs: number;
    followRedirects: boolean;
    /** Desktop only: verify the server's TLS certificate chain. */
    verifyTls: boolean;
    /** Send and store cookies (browser: credentialed CORS; desktop: the app's cookie jar). */
    sendCookies: boolean;
    /** Megabytes of response body to read; 0 reads everything. */
    responseSizeLimitMb: number;
}

export interface RequestScripts {
    preRequest: string;
    postResponse: string;
    tests: string;
}

export interface HttpRequest {
    id: string;
    name: string;
    /** Owning collection or folder; `null` for drafts that are not in a collection. */
    parentId: string | null;
    method: HttpMethod;
    url: string;
    /** Mirrors the URL's query string plus disabled parameters that are not in the URL. */
    params: KeyValueItem[];
    /** Values for the `:name` segments of the URL; kept in step with the URL by the editor. */
    pathVariables?: KeyValueItem[];
    headers: KeyValueItem[];
    body: RequestBody;
    auth: AuthConfig;
    settings: RequestSettings;
    scripts: RequestScripts;
    description: string;
    /**
     * Environment linked to this request; it is activated whenever the request is selected and
     * takes precedence over its collection's. Absent or `null` means "use the collection's".
     */
    environmentId?: string | null;
}

export interface Collection {
    id: string;
    name: string;
    description: string;
    auth: AuthConfig;
    /** Environment activated whenever this collection (or a request in it) is selected. */
    environmentId?: string | null;
}

export interface Folder {
    id: string;
    name: string;
    /** Collection or folder that contains this folder. */
    parentId: string;
    description: string;
    auth: AuthConfig;
    environmentId?: string | null;
}

export interface EnvironmentVariable {
    id: string;
    key: string;
    value: string;
    enabled: boolean;
    /** Masked in the UI and tooltips; literal values are never written to workspace storage. */
    secret: boolean;
}

export interface Environment {
    id: string;
    name: string;
    variables: EnvironmentVariable[];
}

/** 3 added WebSocket requests and the desktop connection profiles. */
export const WORKSPACE_VERSION = 3;

/**
 * The top-level container for everything a user works on. Workspaces are fully isolated: nothing
 * outside this object belongs to a workspace, so switching one out reloads every panel at once.
 */
export interface Workspace {
    version: typeof WORKSPACE_VERSION;
    id: string;
    name: string;
    /** Array order is the display order of siblings in the explorer. */
    collections: Collection[];
    folders: Folder[];
    requests: HttpRequest[];
    /** WebSocket requests live in the same tree, addressed by the same `parentId`. */
    websocketRequests: WebSocketRequest[];
    environments: Environment[];
    activeEnvironmentId: string | null;
    /** Desktop only; ignored by the browser build, but kept so data survives a round trip. */
    sshProfiles: SshProfile[];
    tunnelProfiles: TunnelProfile[];
    /** Ids of open editor tabs (HTTP or WebSocket requests), in tab order. */
    openRequestIds: string[];
    updatedAt: string;
}

/** Workspace identity without its contents, for the switcher and the workspace index. */
export interface WorkspaceMeta {
    id: string;
    name: string;
    updatedAt: string;
}

export const workspaceMeta = (workspace: Workspace): WorkspaceMeta => ({
    id: workspace.id,
    name: workspace.name,
    updatedAt: workspace.updatedAt,
});

export type TreeNodeKind = 'collection' | 'folder' | 'request' | 'websocket';

/** Tree nodes that open in a tab. */
export type RequestKind = 'request' | 'websocket';

export interface HistoryEntry {
    id: string;
    /** Source request; the current name is looked up by id so renames stay in sync. */
    requestId: string;
    /** Name, method and unresolved URL at send time, for requests that no longer exist. */
    name: string;
    method: HttpMethod;
    url: string;
    status: number | null;
    statusText: string;
    durationMs: number | null;
    sizeBytes: number | null;
    error?: string;
    timestamp: string;
}

export const DEFAULT_REQUEST_SETTINGS: RequestSettings = {
    timeoutMs: 0,
    followRedirects: true,
    verifyTls: true,
    sendCookies: false,
    responseSizeLimitMb: 50,
};

export const createId = () => crypto.randomUUID();

/** A copy of a collection, folder or request linked to `environmentId`, or unlinked for `null`. */
export const withEnvironmentLink = <T extends { environmentId?: string | null }>(
    item: T,
    environmentId: string | null,
): T => {
    const copy = { ...item };
    delete copy.environmentId;
    return environmentId ? { ...copy, environmentId } : copy;
};

export const createEmptyBody = (): RequestBody => ({
    mode: 'none',
    json: '',
    text: '',
    textContentType: 'text/plain',
    formUrlEncoded: [],
    multipart: [],
    binary: null,
});

export const createEmptyRequest = (parentId: string | null = null): HttpRequest => ({
    id: createId(),
    name: 'Untitled Request',
    parentId,
    method: 'GET',
    url: '',
    params: [],
    headers: [],
    body: createEmptyBody(),
    // Requests in a collection follow the collection's authorization unless overridden.
    auth: parentId ? { type: 'inherit' } : { type: 'none' },
    settings: { ...DEFAULT_REQUEST_SETTINGS },
    scripts: { preRequest: '', postResponse: '', tests: '' },
    description: '',
});

export const createCollection = (name = 'New Collection'): Collection => ({
    id: createId(),
    name,
    description: '',
    auth: { type: 'none' },
});

export const createFolder = (parentId: string, name = 'New Folder'): Folder => ({
    id: createId(),
    name,
    parentId,
    description: '',
    auth: { type: 'inherit' },
});

export const createEnvironment = (name = 'New Environment'): Environment => ({
    id: createId(),
    name,
    variables: [],
});

export const createKeyValue = (patch: Partial<KeyValueItem> = {}): KeyValueItem => ({
    id: createId(),
    key: '',
    value: '',
    enabled: true,
    ...patch,
});
