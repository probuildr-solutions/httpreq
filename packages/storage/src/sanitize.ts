/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import type { HttpRequest, KeyValueItem, WebSocketRequest, Workspace } from '@httpreq/shared';
import { deserializeAuth, isTemplateOnly, serializeAuth } from '@httpreq/api-client';

/** A literal secret is dropped; a `{{variable}}` reference is kept (the secret lives elsewhere). */
const withoutSecretValue = <T extends { value: string; secret?: boolean }>(item: T): T =>
    item.secret && item.value && !isTemplateOnly(item.value) ? { ...item, value: '' } : item;

export const sanitizeRequest = (request: HttpRequest): HttpRequest => ({
    ...request,
    auth: serializeAuth(request.auth),
    headers: request.headers.map((item: KeyValueItem) => withoutSecretValue(item)),
});

export const sanitizeWebSocketRequest = (request: WebSocketRequest): WebSocketRequest => ({
    ...request,
    auth: serializeAuth(request.auth),
    headers: request.headers.map((item: KeyValueItem) => withoutSecretValue(item)),
});

/**
 * Workspace data as it may be written to disk: no passwords, tokens, API-key values, secret
 * headers or secret environment values.
 *
 * SSH and tunnel profiles need no sanitizing by design: they only ever hold a key *path* and an
 * opaque credential id, and the secrets those point at live in the OS credential vault.
 */
export const sanitizeWorkspace = (workspace: Workspace): Workspace => ({
    ...workspace,
    collections: workspace.collections.map((item) => ({ ...item, auth: serializeAuth(item.auth) })),
    folders: workspace.folders.map((item) => ({ ...item, auth: serializeAuth(item.auth) })),
    requests: workspace.requests.map(sanitizeRequest),
    websocketRequests: workspace.websocketRequests.map(sanitizeWebSocketRequest),
    environments: workspace.environments.map((environment) => ({
        ...environment,
        variables: environment.variables.map(withoutSecretValue),
    })),
});

export { deserializeAuth };
