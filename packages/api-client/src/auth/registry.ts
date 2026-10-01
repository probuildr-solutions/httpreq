/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import type { AuthConfig, AuthType, HttpRequest, Workspace } from '@httpreq/shared';
import { findNode, getAncestors, isLeafNode } from '@httpreq/workspace';
import {
    apiKeyAuthProvider,
    basicAuthProvider,
    bearerAuthProvider,
    inheritAuthProvider,
    noAuthProvider,
} from './basic';
import { digestAuthProvider } from './digest';
import { jwtAuthProvider } from './jwt';
import { oauth2AuthProvider } from './oauth2';
import type { AuthConfigOf, AuthProvider } from './types';

type Registry = { [T in AuthType]: AuthProvider<AuthConfigOf<T>> };

/** Every supported scheme. Order is the order of the Authorization Type selector. */
export const authProviders: Registry = {
    none: noAuthProvider,
    inherit: inheritAuthProvider,
    'api-key': apiKeyAuthProvider,
    bearer: bearerAuthProvider,
    basic: basicAuthProvider,
    digest: digestAuthProvider,
    jwt: jwtAuthProvider,
    oauth2: oauth2AuthProvider,
};

/** Every registered authorization scheme, in registry order; adding a provider to `authProviders`
 * adds it here and in the UI.
 */
export const AUTH_TYPES = Object.keys(authProviders) as AuthType[];

/** Looks up the provider for a configuration. Each scheme implements the same interface, so
 * callers never switch on the type.
 */
export const getAuthProvider = <C extends AuthConfig>(config: C): AuthProvider<C> =>
    authProviders[config.type] as unknown as AuthProvider<C>;

export const createAuth = (type: AuthType): AuthConfig => authProviders[type].create();

/** Auth data safe to persist (literal secrets removed). */
export const serializeAuth = (config: AuthConfig): AuthConfig =>
    getAuthProvider(config).serialize(config);

/** Validates untrusted auth data; unknown schemes return `null`. */
export const deserializeAuth = (value: unknown): AuthConfig | null => {
    if (!value || typeof value !== 'object') return null;
    const type = (value as { type?: unknown }).type;
    if (typeof type !== 'string' || !(type in authProviders)) return null;
    return authProviders[type as AuthType].deserialize(value as Record<string, unknown>);
};

/** The names of a configuration's fields that hold secrets and must never be persisted as
 * literals.
 */
export const authSecretFields = (config: AuthConfig): readonly string[] =>
    getAuthProvider(config).secretFields;

/** Where an effective authorization configuration comes from. */
export interface AuthSource {
    kind: 'request' | 'folder' | 'collection' | 'none';
    id: string | null;
    name: string;
}

export interface EffectiveAuth {
    /** Never `inherit`. */
    auth: AuthConfig;
    source: AuthSource;
}

/**
 * The configuration inherited by children of `parentId`: the nearest folder or collection, walking
 * up the tree, whose authorization is anything other than "Inherit from Parent".
 */
export const resolveInheritedAuth = (
    workspace: Workspace,
    parentId: string | null,
): EffectiveAuth => {
    if (parentId) {
        const containers = [...getAncestors(workspace, parentId)];
        const parent = findNode(workspace, parentId);
        if (parent && !isLeafNode(parent)) containers.push(parent);
        for (const container of containers.reverse()) {
            if (container.node.auth.type !== 'inherit') {
                return {
                    auth: container.node.auth,
                    source: {
                        kind: container.kind,
                        id: container.node.id,
                        name: container.node.name,
                    },
                };
            }
        }
    }
    return { auth: { type: 'none' }, source: { kind: 'none', id: null, name: 'No parent' } };
};

/** The authorization a request is sent with, following inheritance. */
export const resolveEffectiveAuth = (
    workspace: Workspace,
    request: Pick<HttpRequest, 'id' | 'name' | 'auth' | 'parentId'>,
): EffectiveAuth =>
    request.auth.type === 'inherit'
        ? resolveInheritedAuth(workspace, request.parentId)
        : { auth: request.auth, source: { kind: 'request', id: request.id, name: request.name } };
