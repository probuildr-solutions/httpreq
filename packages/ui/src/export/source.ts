/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { serializeAuth } from '@httpreq/api-client';
import type {
    AuthConfig,
    Environment,
    EnvironmentVariable,
    Folder,
    HttpRequest,
    Workspace,
} from '@httpreq/shared';
import { sanitizeRequest } from '@httpreq/storage';
import { collectSubtree } from '@httpreq/workspace';

/**
 * What an export is made of, independent of the file format it is written in: one collection (or
 * a lone request wrapped as one), its folders and HTTP requests, and the variables they use.
 *
 * Everything is sanitized exactly as it is for storage before any format sees it: literal
 * passwords, tokens, API-key values, secret headers and secret variable values are removed, while
 * `{{variable}}` references are kept, so an export can be shared without leaking credentials.
 */
export interface ExportSource {
    /** The id children of the root point at through `parentId`. */
    rootId: string;
    name: string;
    description: string;
    /** Authorization at the root; requests and folders set to "inherit" follow it. */
    auth: AuthConfig;
    folders: Folder[];
    requests: HttpRequest[];
    /** The active environment's variables, when one is selected. */
    environment: { name: string; variables: EnvironmentVariable[] } | null;
    /** Things in the source that the export leaves out, such as WebSocket requests. */
    skipped: string[];
}

const withoutSecret = (variable: EnvironmentVariable): EnvironmentVariable =>
    variable.secret && !/^\s*\{\{[^{}]+\}\}\s*$/.test(variable.value)
        ? { ...variable, value: '' }
        : variable;

const exportEnvironment = (environment: Environment | null | undefined) =>
    environment
        ? {
              name: environment.name,
              variables: environment.variables.filter((item) => item.key).map(withoutSecret),
          }
        : null;

const activeEnvironmentOf = (workspace: Workspace) =>
    workspace.environments.find((item) => item.id === workspace.activeEnvironmentId) ?? null;

/** A collection and everything beneath it. Returns null when there is no such collection. */
export const collectionSource = (
    workspace: Workspace,
    collectionId: string,
): ExportSource | null => {
    const collection = workspace.collections.find((item) => item.id === collectionId);
    if (!collection) return null;
    const { containers, requests, websockets } = collectSubtree(workspace, collectionId);
    return {
        rootId: collection.id,
        name: collection.name,
        description: collection.description,
        auth: serializeAuth(collection.auth),
        folders: workspace.folders
            .filter((folder) => containers.has(folder.id))
            .map((folder) => ({ ...folder, auth: serializeAuth(folder.auth) })),
        requests: workspace.requests.filter((item) => requests.has(item.id)).map(sanitizeRequest),
        environment: exportEnvironment(activeEnvironmentOf(workspace)),
        skipped: websockets.size
            ? [
                  `${websockets.size} WebSocket request${websockets.size === 1 ? ' is' : 's are'} not part of this format and ${websockets.size === 1 ? 'was' : 'were'} left out.`,
              ]
            : [],
    };
};

/**
 * One request on its own. Its authorization is exported as it is actually sent: an inherited
 * scheme is written out on the request, since the parent it came from is not in the file.
 */
export const requestSource = (
    workspace: Workspace,
    request: HttpRequest,
    effectiveAuth: AuthConfig,
): ExportSource => {
    const rootId = `export-${request.id}`;
    return {
        rootId,
        name: request.name,
        description: request.description,
        auth: { type: 'none' },
        folders: [],
        requests: [
            sanitizeRequest({
                ...request,
                parentId: rootId,
                auth: request.auth.type === 'inherit' ? effectiveAuth : request.auth,
            }),
        ],
        environment: exportEnvironment(activeEnvironmentOf(workspace)),
        skipped: [],
    };
};

/** Children of a container in explorer order: folders, then requests. */
export const childrenOf = (source: ExportSource, parentId: string) => ({
    folders: source.folders.filter((folder) => folder.parentId === parentId),
    requests: source.requests.filter((request) => request.parentId === parentId),
});

/** Variables that are switched on and named, later rows winning, as the resolver sees them. */
export const effectiveVariables = (source: ExportSource): Map<string, EnvironmentVariable> => {
    const values = new Map<string, EnvironmentVariable>();
    for (const variable of source.environment?.variables ?? []) {
        if (variable.enabled && variable.key) values.set(variable.key, variable);
    }
    return values;
};
