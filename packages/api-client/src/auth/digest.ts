/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import type { DigestAuth, HttpMethod } from '@httpreq/shared';
import { hex, md5, randomBytes, sha256, utf8 } from '../crypto';
import { defineProvider } from './define';

export interface DigestChallenge {
    realm: string;
    nonce: string;
    qop?: string;
    algorithm: string;
    opaque?: string;
}

/** Parses a `WWW-Authenticate: Digest ...` header (the Digest challenge, if several are listed). */
export const parseDigestChallenge = (header: string): DigestChallenge | null => {
    const start = header.search(/digest\s/i);
    if (start < 0) return null;
    const params: Record<string, string> = {};
    const pattern = /([a-z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/gi;
    for (const match of header.slice(start + 7).matchAll(pattern)) {
        params[match[1]!.toLowerCase()] = (match[2] ?? match[3] ?? '').replace(/\\(.)/g, '$1');
    }
    if (!params.nonce || params.realm === undefined) return null;
    return {
        realm: params.realm,
        nonce: params.nonce,
        qop: params.qop,
        algorithm: params.algorithm ?? 'MD5',
        opaque: params.opaque,
    };
};

const hashHex = async (algorithm: string, text: string) =>
    algorithm.toUpperCase().startsWith('SHA-256')
        ? hex(await sha256(utf8(text)))
        : hex(md5(utf8(text)));

/** Builds the `Authorization: Digest ...` answer to a challenge (RFC 7616, qop="auth"). */
export const buildDigestAuthorization = async (options: {
    challenge: DigestChallenge;
    username: string;
    password: string;
    method: HttpMethod;
    uri: string;
    cnonce?: string;
    nonceCount?: number;
}): Promise<string> => {
    const { challenge, username, password, method, uri } = options;
    const algorithm = challenge.algorithm;
    const cnonce = options.cnonce ?? hex(randomBytes(8));
    const nc = (options.nonceCount ?? 1).toString(16).padStart(8, '0');
    const qop = challenge.qop
        ?.split(',')
        .map((value) => value.trim())
        .includes('auth')
        ? 'auth'
        : undefined;

    let ha1 = await hashHex(algorithm, `${username}:${challenge.realm}:${password}`);
    if (/-sess$/i.test(algorithm))
        ha1 = await hashHex(algorithm, `${ha1}:${challenge.nonce}:${cnonce}`);
    const ha2 = await hashHex(algorithm, `${method}:${uri}`);
    const response = qop
        ? await hashHex(algorithm, `${ha1}:${challenge.nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
        : await hashHex(algorithm, `${ha1}:${challenge.nonce}:${ha2}`);

    const quote = (value: string) => `"${value.replace(/(["\\])/g, '\\$1')}"`;
    const parts = [
        `username=${quote(username)}`,
        `realm=${quote(challenge.realm)}`,
        `nonce=${quote(challenge.nonce)}`,
        `uri=${quote(uri)}`,
        `algorithm=${algorithm}`,
        `response=${quote(response)}`,
    ];
    if (qop) parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce=${quote(cnonce)}`);
    if (challenge.opaque !== undefined) parts.push(`opaque=${quote(challenge.opaque)}`);
    return `Digest ${parts.join(', ')}`;
};

/**
 * Digest needs a server nonce, so the first request goes out without credentials and the 401
 * challenge is answered once. Browsers only expose `WWW-Authenticate` to scripts when the server
 * lists it in `Access-Control-Expose-Headers`; the desktop app always sees it.
 */
export const digestAuthProvider = defineProvider<DigestAuth>({
    type: 'digest',
    label: 'Digest Auth',
    description: 'Answers the server’s Digest challenge with a hashed username and password.',
    secretFields: ['password'],
    create: () => ({ type: 'digest', username: '', password: '' }),
    validate: (config) =>
        config.username.trim()
            ? []
            : [{ field: 'username', message: 'Enter a username.', severity: 'warning' }],
    appliedHeaders: () => ['Authorization'],
    previewHeaders: () => ({
        Authorization: 'Digest <computed from the server’s 401 challenge; sent on the retry>',
    }),
    applyToRequest: () => undefined,
    async handleChallenge(config, request, response) {
        if (response.status !== 401) return null;
        const header = Object.entries(response.headers).find(
            ([name]) => name.toLowerCase() === 'www-authenticate',
        )?.[1];
        const challenge = header ? parseDigestChallenge(header) : null;
        if (!challenge) return null;
        const url = new URL(request.url);
        const authorization = await buildDigestAuthorization({
            challenge,
            username: config.username,
            password: config.password,
            method: request.method,
            uri: `${url.pathname}${url.search}`,
        });
        return { ...request, headers: { ...request.headers, Authorization: authorization } };
    },
});
