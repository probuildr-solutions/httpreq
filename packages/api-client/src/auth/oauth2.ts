/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import {
    AppError,
    DEFAULT_REQUEST_SETTINGS,
    OAUTH2_GRANT_TYPES,
    type HttpResponse,
    type OAuth2Auth,
    type OAuth2GrantType,
    type PreparedRequest,
} from '@httpreq/shared';
import { base64Url, randomBytes, sha256, utf8 } from '../crypto';
import { encodeBasicCredentials } from './basic';
import { defineProvider, maskedCredential, withPrefix } from './define';
import type { AuthIssue } from './types';

export const OAUTH2_GRANT_LABELS: Record<OAuth2GrantType, string> = {
    authorization_code: 'Authorization Code',
    authorization_code_pkce: 'Authorization Code (With PKCE)',
    client_credentials: 'Client Credentials',
    password: 'Password Credentials (legacy)',
    refresh_token: 'Refresh Token',
};

export const usesAuthorizationEndpoint = (grant: OAuth2GrantType) =>
    grant === 'authorization_code' || grant === 'authorization_code_pkce';

/** Whether the stored access token is past its expiry. A token with no known expiry is treated as
 * valid.
 */
export const isTokenExpired = (config: Pick<OAuth2Auth, 'expiresAt'>, now = Date.now()) =>
    config.expiresAt !== null && config.expiresAt <= now;

export const oauth2AuthProvider = defineProvider<OAuth2Auth>({
    type: 'oauth2',
    label: 'OAuth 2.0',
    description:
        'Obtains an access token from an authorization server and sends it as a bearer token.',
    secretFields: ['clientSecret', 'password', 'accessToken', 'refreshToken'],
    enums: {
        grantType: OAUTH2_GRANT_TYPES,
        clientAuthentication: ['basic-header', 'body'],
    },
    create: () => ({
        type: 'oauth2',
        grantType: 'authorization_code_pkce',
        authUrl: '',
        tokenUrl: '',
        clientId: '',
        clientSecret: '',
        scope: '',
        callbackUrl: '',
        username: '',
        password: '',
        clientAuthentication: 'basic-header',
        headerPrefix: 'Bearer',
        accessToken: '',
        refreshToken: '',
        expiresAt: null,
        tokenVariable: '',
    }),
    validate(config) {
        const issues: AuthIssue[] = [];
        if (!config.accessToken.trim()) {
            issues.push({
                field: 'accessToken',
                message: 'No access token yet. Use “Get New Access Token”.',
                severity: 'warning',
            });
        } else if (isTokenExpired(config)) {
            issues.push({
                field: 'accessToken',
                message: 'The access token has expired.',
                severity: 'warning',
            });
        }
        return issues;
    },
    appliedHeaders: () => ['Authorization'],
    // Without a token nothing is sent, so nothing is previewed.
    previewHeaders: (config): Record<string, string> =>
        config.accessToken
            ? {
                  Authorization: withPrefix(
                      config.headerPrefix,
                      maskedCredential(config.accessToken),
                  ),
              }
            : {},
    applyToRequest(config, request) {
        if (!config.accessToken) return;
        const prefix = config.headerPrefix.trim();
        request.headers.set(
            'Authorization',
            prefix ? `${prefix} ${config.accessToken}` : config.accessToken,
        );
    },
});

/* ---------- Token retrieval ---------- */

export interface PkcePair {
    verifier: string;
    challenge: string;
}

/** A PKCE verifier and its S256 challenge (RFC 7636). The verifier stays in memory until the code
 * is exchanged.
 */
export const createPkcePair = async (): Promise<PkcePair> => {
    const verifier = base64Url(randomBytes(48));
    return { verifier, challenge: base64Url(await sha256(utf8(verifier))) };
};

/** An unguessable `state` value that ties the redirect back to the authorization request that
 * started it.
 */
export const createOAuthState = () => base64Url(randomBytes(16));

/** The URL the user opens to sign in and approve access (authorization-code grants). */
export const buildAuthorizationUrl = (
    config: OAuth2Auth,
    options: { state: string; codeChallenge?: string },
): string => {
    let url: URL;
    try {
        url = new URL(config.authUrl);
    } catch (cause) {
        throw new AppError('INVALID_REQUEST', 'Enter a valid authorization URL.', { cause });
    }
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', config.clientId);
    if (config.callbackUrl) url.searchParams.set('redirect_uri', config.callbackUrl);
    if (config.scope) url.searchParams.set('scope', config.scope);
    url.searchParams.set('state', options.state);
    if (options.codeChallenge) {
        url.searchParams.set('code_challenge', options.codeChallenge);
        url.searchParams.set('code_challenge_method', 'S256');
    }
    return url.toString();
};

/**
 * Accepts the full redirect URL (or just the code) the user copied after approving access, and
 * checks the `state` to reject responses that belong to another attempt.
 */
export const parseAuthorizationResponse = (input: string, expectedState: string): string => {
    const text = input.trim();
    let params: URLSearchParams | null = null;
    try {
        const url = new URL(text);
        params = new URLSearchParams(url.search || url.hash.slice(1));
    } catch {
        if (text.includes('code=')) params = new URLSearchParams(text.replace(/^[?#]/, ''));
    }
    if (!params) {
        if (!text) throw new AppError('AUTHENTICATION_ERROR', 'Paste the redirect URL or code.');
        return text;
    }
    const error = params.get('error');
    if (error) {
        throw new AppError(
            'AUTHENTICATION_ERROR',
            params.get('error_description') ?? `Authorization failed: ${error}`,
        );
    }
    const code = params.get('code');
    if (!code)
        throw new AppError('AUTHENTICATION_ERROR', 'The redirect URL does not contain a code.');
    const state = params.get('state');
    if (state !== null && state !== expectedState) {
        throw new AppError(
            'AUTHENTICATION_ERROR',
            'The authorization response state does not match.',
        );
    }
    return code;
};

export interface OAuthTokens {
    accessToken: string;
    refreshToken: string;
    tokenType: string;
    expiresAt: number | null;
}

type Execute = (request: PreparedRequest) => Promise<HttpResponse>;

/**
 * Exchanges credentials, a code or a refresh token for tokens. The request runs through the
 * caller's runtime, so the desktop app uses native networking (and no CORS) here too.
 */
export const requestOAuthTokens = async (
    config: OAuth2Auth,
    execute: Execute,
    options: { code?: string; codeVerifier?: string; now?: number } = {},
): Promise<OAuthTokens> => {
    const form = new URLSearchParams();
    const grant = config.grantType;
    if (usesAuthorizationEndpoint(grant)) {
        if (!options.code)
            throw new AppError('AUTHENTICATION_ERROR', 'An authorization code is required.');
        form.set('grant_type', 'authorization_code');
        form.set('code', options.code);
        if (config.callbackUrl) form.set('redirect_uri', config.callbackUrl);
        if (options.codeVerifier) form.set('code_verifier', options.codeVerifier);
    } else if (grant === 'client_credentials') {
        form.set('grant_type', 'client_credentials');
    } else if (grant === 'password') {
        form.set('grant_type', 'password');
        form.set('username', config.username);
        form.set('password', config.password);
    } else {
        if (!config.refreshToken)
            throw new AppError('AUTHENTICATION_ERROR', 'A refresh token is required.');
        form.set('grant_type', 'refresh_token');
        form.set('refresh_token', config.refreshToken);
    }
    if (config.scope && !usesAuthorizationEndpoint(grant)) form.set('scope', config.scope);

    const headers: Record<string, string> = {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
    };
    if (config.clientAuthentication === 'basic-header' && config.clientSecret) {
        headers.Authorization = `Basic ${encodeBasicCredentials(
            encodeURIComponent(config.clientId),
            encodeURIComponent(config.clientSecret),
        )}`;
    } else {
        form.set('client_id', config.clientId);
        if (config.clientSecret) form.set('client_secret', config.clientSecret);
    }

    let tokenUrl: string;
    try {
        tokenUrl = new URL(config.tokenUrl).toString();
    } catch (cause) {
        throw new AppError('INVALID_REQUEST', 'Enter a valid access token URL.', { cause });
    }
    const response = await execute({
        method: 'POST',
        url: tokenUrl,
        headers,
        body: { kind: 'text', text: form.toString() },
        options: {
            followRedirects: true,
            verifyTls: true,
            sendCookies: false,
            maxResponseBytes: DEFAULT_REQUEST_SETTINGS.responseSizeLimitMb * 1024 * 1024,
        },
    });

    let payload: Record<string, unknown> = {};
    try {
        payload = JSON.parse(response.body) as Record<string, unknown>;
    } catch {
        // Some servers answer form-encoded.
        payload = Object.fromEntries(new URLSearchParams(response.body));
    }
    if (response.status >= 400 || typeof payload.access_token !== 'string') {
        const detail =
            (typeof payload.error_description === 'string' && payload.error_description) ||
            (typeof payload.error === 'string' && payload.error) ||
            `${response.status} ${response.statusText}`.trim();
        throw new AppError('AUTHENTICATION_ERROR', `The token request failed: ${detail}`);
    }
    const expiresIn = Number(payload.expires_in);
    return {
        accessToken: payload.access_token,
        refreshToken:
            typeof payload.refresh_token === 'string' ? payload.refresh_token : config.refreshToken,
        tokenType: typeof payload.token_type === 'string' ? payload.token_type : 'Bearer',
        expiresAt:
            Number.isFinite(expiresIn) && expiresIn > 0
                ? (options.now ?? Date.now()) + expiresIn * 1000
                : null,
    };
};
