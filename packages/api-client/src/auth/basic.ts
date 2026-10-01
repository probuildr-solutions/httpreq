/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import type { ApiKeyAuth, BasicAuth, BearerAuth, InheritAuth, NoAuth } from '@httpreq/shared';
import { bytesToBase64, utf8 } from '../crypto';
import { defineProvider, maskedCredential, withPrefix } from './define';
import type { AuthIssue } from './types';

const required = (value: string, field: string, message: string): AuthIssue[] =>
    value.trim() ? [] : [{ field, message, severity: 'warning' }];

export const noAuthProvider = defineProvider<NoAuth>({
    type: 'none',
    label: 'No Auth',
    description: 'This request does not use authorization.',
    secretFields: [],
    create: () => ({ type: 'none' }),
    applyToRequest: () => undefined,
});

/**
 * Placeholder scheme: the pipeline replaces it with the nearest configured ancestor's scheme
 * before any provider runs, so applying it directly is a no-op.
 */
export const inheritAuthProvider = defineProvider<InheritAuth>({
    type: 'inherit',
    label: 'Inherit from Parent',
    description: 'Uses the authorization of the closest folder or collection that configures one.',
    secretFields: [],
    create: () => ({ type: 'inherit' }),
    applyToRequest: () => undefined,
});

export const apiKeyAuthProvider = defineProvider<ApiKeyAuth>({
    type: 'api-key',
    label: 'API Key',
    description: 'Sends a key as a request header or query parameter.',
    secretFields: ['value'],
    enums: { location: ['header', 'query'] },
    create: () => ({ type: 'api-key', key: '', value: '', location: 'header' }),
    validate: (config) => required(config.key, 'key', 'Enter the key name.'),
    appliedHeaders: (config) => (config.location === 'header' && config.key ? [config.key] : []),
    previewHeaders: (config): Record<string, string> =>
        config.location === 'header' && config.key
            ? { [config.key]: maskedCredential(config.value, '<empty>') }
            : {},
    applyToRequest(config, request) {
        if (!config.key) return;
        if (config.location === 'header') request.headers.set(config.key, config.value);
        else request.url.searchParams.set(config.key, config.value);
    },
});

export const bearerAuthProvider = defineProvider<BearerAuth>({
    type: 'bearer',
    label: 'Bearer Token',
    description: 'Sends the token in an “Authorization: Bearer <token>” header.',
    secretFields: ['token'],
    create: () => ({ type: 'bearer', token: '', prefix: 'Bearer' }),
    validate: (config) => required(config.token, 'token', 'The token is empty.'),
    appliedHeaders: () => ['Authorization'],
    previewHeaders: (config) => ({
        Authorization: withPrefix(config.prefix, maskedCredential(config.token)),
    }),
    applyToRequest(config, request) {
        const prefix = config.prefix.trim();
        request.headers.set('Authorization', prefix ? `${prefix} ${config.token}` : config.token);
    },
});

export const encodeBasicCredentials = (username: string, password: string) =>
    bytesToBase64(utf8(`${username}:${password}`));

export const basicAuthProvider = defineProvider<BasicAuth>({
    type: 'basic',
    label: 'Basic Auth',
    description: 'Sends a username and password in an “Authorization: Basic” header.',
    secretFields: ['password'],
    create: () => ({ type: 'basic', username: '', password: '' }),
    validate: (config) => required(config.username, 'username', 'Enter a username.'),
    appliedHeaders: () => ['Authorization'],
    previewHeaders: () => ({ Authorization: 'Basic <base64 of username:password>' }),
    applyToRequest(config, request) {
        request.headers.set(
            'Authorization',
            `Basic ${encodeBasicCredentials(config.username, config.password)}`,
        );
    },
});
