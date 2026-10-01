/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import {
    AppError,
    type Environment,
    type HttpRequest,
    type KeyValueItem,
    type Workspace,
} from '@httpreq/shared';
import { getAuthProvider, resolveEffectiveAuth, type EffectiveAuth } from '../auth/registry';
import { HeaderMap, type AuthContext, type RequestDraft } from '../auth/types';
import type { VariableResolver } from '../variables';

/** Behaviour shared by every non-HTTP protocol builder: URLs, headers and authorization. */

export const enabledRows = <T extends { enabled: boolean; key: string }>(items: T[]) =>
    items.filter((item) => item.enabled && item.key.trim() !== '');

const scopeOf = (environment: Environment | null) =>
    environment ? `the “${environment.name}” environment` : 'any environment (none is selected)';

/**
 * Parses a URL written by the user after variables were substituted. `schemes` are the accepted
 * protocols, without the colon. A variable that stayed undefined gets its own message, because
 * "not a valid URL" would hide the real cause.
 */
export const parseProtocolUrl = (
    text: string,
    resolver: VariableResolver,
    environment: Environment | null,
    schemes: readonly string[],
    label: string,
    example: string,
): URL => {
    const undefinedNames = [...resolver.unresolved];
    if (!text) throw new AppError('INVALID_REQUEST', `Enter a ${label} URL, e.g. ${example}.`);
    let url: URL | undefined;
    try {
        url = new URL(text);
    } catch {
        url = undefined;
    }
    const unresolvedHost = !!url && (url.host.includes('%7B%7B') || url.host.includes('{{'));
    if (!url || unresolvedHost) {
        if (undefinedNames.length) {
            throw new AppError(
                'INVALID_REQUEST',
                `${undefinedNames.map((name) => `{{${name}}}`).join(', ')} in the URL is not defined in ${scopeOf(environment)}.`,
            );
        }
        throw new AppError(
            'INVALID_REQUEST',
            `“${text}” is not a valid ${label} URL, e.g. ${example}.`,
        );
    }
    const scheme = url.protocol.replace(/:$/, '').toLowerCase();
    if (!schemes.includes(scheme)) {
        throw new AppError(
            'INVALID_REQUEST',
            `“${scheme}://” is not a ${label} scheme. Use ${schemes.map((item) => `${item}://`).join(', ')}.`,
        );
    }
    return url;
};

export interface AppliedAuth {
    effective: EffectiveAuth;
    /** Headers (metadata) after the authorization scheme was applied. */
    headers: HeaderMap;
    url: URL;
}

/**
 * Resolves the request's effective authorization and applies it to an HTTP-shaped draft, the same
 * providers HTTP and WebSocket use. `draftUrl` stands in for the real URL (an `http(s)` URL for
 * the same host), because providers such as API-key-in-query and Digest work on one.
 */
export const applyProtocolAuth = async (
    request: HttpRequest,
    workspace: Workspace,
    authContext: AuthContext,
    resolver: VariableResolver,
    draftUrl: URL,
): Promise<AppliedAuth> => {
    const headers = new HeaderMap();
    enabledRows(request.headers).forEach((item: KeyValueItem) =>
        headers.set(resolver.resolve(item.key.trim()), resolver.resolve(item.value)),
    );
    const draft: RequestDraft = { method: 'POST', url: draftUrl, headers };
    const effective = resolveEffectiveAuth(workspace, request);
    const provider = getAuthProvider(effective.auth);
    const blocking = provider
        .validate(effective.auth)
        .filter((issue) => issue.severity === 'error');
    if (blocking.length) {
        throw new AppError('AUTHENTICATION_ERROR', `${provider.label}: ${blocking[0]!.message}`);
    }
    await provider.applyToRequest(
        provider.resolve(effective.auth, authContext),
        draft,
        authContext,
    );
    return { effective, headers, url: draft.url };
};

/** gRPC metadata keys are lower-case ASCII; anything else cannot be sent. */
const METADATA_KEY = /^[0-9a-z_.-]+$/;

export const toMetadata = (headers: Record<string, string>): Record<string, string> => {
    const metadata: Record<string, string> = {};
    for (const [name, value] of Object.entries(headers)) {
        const key = name.toLowerCase();
        if (!METADATA_KEY.test(key)) {
            throw new AppError(
                'INVALID_REQUEST',
                `“${name}” is not a valid metadata key (letters, digits, “-”, “_” and “.”).`,
            );
        }
        if (/[\r\n\0]/.test(value)) {
            throw new AppError(
                'INVALID_REQUEST',
                `The value of “${name}” cannot contain line breaks.`,
            );
        }
        metadata[key] = value;
    }
    return metadata;
};
