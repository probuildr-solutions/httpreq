/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { describe, expect, it } from 'vitest';
import { base64UrlFromBase64, bytesToBase64, hex, md5, utf8 } from './crypto';
import { buildDigestAuthorization, parseDigestChallenge } from './auth/digest';
import { signJwt, jwtAuthProvider } from './auth/jwt';
import { parseAuthorizationResponse, requestOAuthTokens, oauth2AuthProvider } from './auth/oauth2';
import { authProviders, deserializeAuth, serializeAuth } from './auth/registry';
import { base64ToBytes } from './crypto';

describe('md5', () => {
    it.each([
        ['', 'd41d8cd98f00b204e9800998ecf8427e'],
        ['abc', '900150983cd24fb0d6963f7d28e17f72'],
        [
            '12345678901234567890123456789012345678901234567890123456789012345678901234567890',
            '57edf4a22be3c955ac49da2e2107b67a',
        ],
    ])('hashes %j', (input, expected) => {
        expect(hex(md5(utf8(input)))).toBe(expected);
    });
});

describe('digest', () => {
    it('produces the RFC 2617 example response', async () => {
        const challenge = parseDigestChallenge(
            'Digest realm="testrealm@host.com", qop="auth,auth-int", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"',
        )!;
        const header = await buildDigestAuthorization({
            challenge,
            username: 'Mufasa',
            password: 'Circle Of Life',
            method: 'GET',
            uri: '/dir/index.html',
            cnonce: '0a4f113b',
        });
        expect(header).toContain('response="6629fae49393a05397450978507c4ef1"');
        expect(header).toContain('opaque="5ccc069c403ebaf9f0171e9517f40e41"');
    });
});

describe('jwt', () => {
    it('signs HS256 tokens that verify with the secret', async () => {
        const config = {
            ...jwtAuthProvider.create(),
            secret: 'top-secret',
            payload: '{"role":"admin"}',
            issuer: 'httpreq',
            expiresInSeconds: 60,
        };
        const token = await signJwt(config, 1_700_000_000_000);
        const [header, payload, signature] = token.split('.');
        const decode = (part: string) =>
            JSON.parse(
                new TextDecoder().decode(base64ToBytes(part.replace(/-/g, '+').replace(/_/g, '/'))),
            );
        expect(decode(header!)).toEqual({ alg: 'HS256', typ: 'JWT' });
        expect(decode(payload!)).toEqual({
            iat: 1_700_000_000,
            exp: 1_700_000_060,
            iss: 'httpreq',
            role: 'admin',
        });
        const key = await crypto.subtle.importKey(
            'raw',
            utf8('top-secret') as BufferSource,
            { name: 'HMAC', hash: 'SHA-256' },
            false,
            ['sign'],
        );
        const expected = new Uint8Array(
            await crypto.subtle.sign('HMAC', key, utf8(`${header}.${payload}`) as BufferSource),
        );
        expect(signature).toBe(base64UrlFromBase64(bytesToBase64(expected)));
    });

    it('reports malformed payload JSON as a blocking issue', () => {
        const issues = jwtAuthProvider.validate({
            ...jwtAuthProvider.create(),
            secret: 's',
            payload: '{',
        });
        expect(issues).toContainEqual(
            expect.objectContaining({ field: 'payload', severity: 'error' }),
        );
    });
});

describe('provider persistence', () => {
    it('drops literal secrets but keeps variable references', () => {
        expect(serializeAuth({ type: 'bearer', token: 'literal', prefix: 'Bearer' })).toEqual({
            type: 'bearer',
            token: '',
            prefix: 'Bearer',
        });
        expect(
            serializeAuth({ type: 'bearer', token: '{{accessToken}}', prefix: 'Bearer' }),
        ).toMatchObject({
            token: '{{accessToken}}',
        });
        expect(
            serializeAuth({
                ...oauth2AuthProvider.create(),
                clientSecret: 'shh',
                accessToken: 'tok',
                clientId: 'app',
            }),
        ).toMatchObject({ clientSecret: '', accessToken: '', clientId: 'app' });
    });

    it('validates untrusted data and fills defaults', () => {
        expect(deserializeAuth({ type: 'api-key', key: 'X-Key', location: 'cookie' })).toEqual({
            type: 'api-key',
            key: 'X-Key',
            value: '',
            location: 'header',
        });
        expect(deserializeAuth({ type: 'ntlm' })).toBeNull();
        expect(deserializeAuth('bearer')).toBeNull();
    });

    it('round-trips every provider’s defaults', () => {
        for (const provider of Object.values(authProviders)) {
            const config = provider.create();
            expect(deserializeAuth(JSON.parse(JSON.stringify(config)))).toEqual(config);
        }
    });
});

describe('oauth2', () => {
    it('parses the redirect URL and checks state', () => {
        expect(parseAuthorizationResponse('https://app/cb?code=abc&state=s1', 's1')).toBe('abc');
        expect(() =>
            parseAuthorizationResponse('https://app/cb?code=abc&state=other', 's1'),
        ).toThrow(/state/);
        expect(() =>
            parseAuthorizationResponse('https://app/cb?error=access_denied', 's1'),
        ).toThrow(/access_denied/);
        expect(parseAuthorizationResponse('raw-code', 's1')).toBe('raw-code');
    });

    it('requests client-credentials tokens through the given executor', async () => {
        let sent: { url: string; headers: Record<string, string>; body?: unknown } | undefined;
        const tokens = await requestOAuthTokens(
            {
                ...oauth2AuthProvider.create(),
                grantType: 'client_credentials',
                tokenUrl: 'https://auth.example.com/token',
                clientId: 'app',
                clientSecret: 'secret',
                scope: 'read',
            },
            async (request) => {
                sent = request;
                return {
                    status: 200,
                    statusText: 'OK',
                    headers: {},
                    body: '{"access_token":"at","expires_in":60,"token_type":"Bearer"}',
                    contentType: 'application/json',
                    durationMs: 1,
                    sizeBytes: 1,
                };
            },
            { now: 1000 },
        );
        expect(tokens).toEqual({
            accessToken: 'at',
            refreshToken: '',
            tokenType: 'Bearer',
            expiresAt: 61_000,
        });
        expect(sent?.headers.Authorization).toBe(`Basic ${btoa('app:secret')}`);
        expect(sent?.body).toEqual({
            kind: 'text',
            text: 'grant_type=client_credentials&scope=read',
        });
    });
});
