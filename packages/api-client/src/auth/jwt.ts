/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { AppError, JWT_ALGORITHMS, type JwtAlgorithm, type JwtAuth } from '@httpreq/shared';
import { base64ToBytes, base64Url, utf8 } from '../crypto';
import { defineProvider, withPrefix } from './define';
import type { AuthIssue } from './types';

type Hash = 'SHA-256' | 'SHA-384' | 'SHA-512';

const hashFor = (algorithm: JwtAlgorithm): Hash =>
    algorithm.endsWith('256') ? 'SHA-256' : algorithm.endsWith('384') ? 'SHA-384' : 'SHA-512';

export const isHmacAlgorithm = (algorithm: JwtAlgorithm) => algorithm.startsWith('HS');

const pemToDer = (pem: string): Uint8Array => {
    if (/BEGIN (RSA|EC) PRIVATE KEY/.test(pem)) {
        throw new AppError(
            'AUTHENTICATION_ERROR',
            'JWT signing needs a PKCS#8 private key ("BEGIN PRIVATE KEY"). Convert it, e.g. with `openssl pkcs8 -topk8 -nocrypt`.',
        );
    }
    const body = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s+/g, '');
    try {
        return base64ToBytes(body);
    } catch (cause) {
        throw new AppError('AUTHENTICATION_ERROR', 'The JWT private key is not valid PEM.', {
            cause,
        });
    }
};

const importKey = async (
    config: JwtAuth,
): Promise<[CryptoKey, AlgorithmIdentifier | RsaPssParams | EcdsaParams]> => {
    const { algorithm } = config;
    const hash = hashFor(algorithm);
    try {
        if (isHmacAlgorithm(algorithm)) {
            const secret = config.secretBase64 ? base64ToBytes(config.secret) : utf8(config.secret);
            const key = await crypto.subtle.importKey(
                'raw',
                secret as BufferSource,
                { name: 'HMAC', hash },
                false,
                ['sign'],
            );
            return [key, { name: 'HMAC' }];
        }
        const der = pemToDer(config.secret) as BufferSource;
        if (algorithm.startsWith('RS')) {
            const key = await crypto.subtle.importKey(
                'pkcs8',
                der,
                { name: 'RSASSA-PKCS1-v1_5', hash },
                false,
                ['sign'],
            );
            return [key, { name: 'RSASSA-PKCS1-v1_5' }];
        }
        if (algorithm.startsWith('PS')) {
            const key = await crypto.subtle.importKey(
                'pkcs8',
                der,
                { name: 'RSA-PSS', hash },
                false,
                ['sign'],
            );
            return [key, { name: 'RSA-PSS', saltLength: Number(algorithm.slice(2)) / 8 }];
        }
        const namedCurve = algorithm === 'ES256' ? 'P-256' : 'P-384';
        const key = await crypto.subtle.importKey(
            'pkcs8',
            der,
            { name: 'ECDSA', namedCurve },
            false,
            ['sign'],
        );
        // Web Crypto emits ECDSA signatures as r||s, which is exactly the JWS encoding.
        return [key, { name: 'ECDSA', hash }];
    } catch (cause) {
        if (cause instanceof AppError) throw cause;
        throw new AppError(
            'AUTHENTICATION_ERROR',
            `The ${algorithm} signing key could not be imported.`,
            {
                cause,
            },
        );
    }
};

const parseObject = (text: string, label: string): Record<string, unknown> => {
    if (!text.trim()) return {};
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch (cause) {
        throw new AppError('AUTHENTICATION_ERROR', `The JWT ${label} is not valid JSON.`, {
            cause,
        });
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new AppError('AUTHENTICATION_ERROR', `The JWT ${label} must be a JSON object.`);
    }
    return value as Record<string, unknown>;
};

/** Signs a JWT from a resolved configuration. */
export const signJwt = async (config: JwtAuth, nowMs: number): Promise<string> => {
    const header = { ...parseObject(config.header, 'header'), alg: config.algorithm, typ: 'JWT' };
    const issuedAt = Math.floor(nowMs / 1000);
    const claims: Record<string, unknown> = {
        iat: issuedAt,
        ...parseObject(config.payload, 'payload'),
    };
    if (config.issuer) claims.iss = config.issuer;
    if (config.subject) claims.sub = config.subject;
    if (config.audience) claims.aud = config.audience;
    if (config.expiresInSeconds > 0) claims.exp = issuedAt + config.expiresInSeconds;

    const encode = (value: unknown) => base64Url(utf8(JSON.stringify(value)));
    const signingInput = `${encode(header)}.${encode(claims)}`;
    const [key, params] = await importKey(config);
    const signature = new Uint8Array(
        await crypto.subtle.sign(params, key, utf8(signingInput) as BufferSource),
    );
    return `${signingInput}.${base64Url(signature)}`;
};

const validJson = (text: string, field: string, label: string): AuthIssue[] => {
    try {
        if (text.trim()) parseObject(text.replace(/\{\{[^{}]+\}\}/g, '0'), label);
        return [];
    } catch (error) {
        return [{ field, message: (error as Error).message, severity: 'error' }];
    }
};

/**
 * Generates and signs a fresh token for every request, so the secret is only used at send time
 * and signed tokens are never stored.
 */
export const jwtAuthProvider = defineProvider<JwtAuth>({
    type: 'jwt',
    label: 'JWT Bearer',
    description: 'Signs a JSON Web Token for each request and sends it as a bearer token.',
    secretFields: ['secret'],
    enums: { algorithm: JWT_ALGORITHMS, addTo: ['header', 'query'] },
    create: () => ({
        type: 'jwt',
        algorithm: 'HS256',
        secret: '',
        secretBase64: false,
        payload: '{\n  \n}',
        header: '',
        issuer: '',
        subject: '',
        audience: '',
        expiresInSeconds: 3600,
        addTo: 'header',
        headerPrefix: 'Bearer',
        queryParamKey: 'token',
    }),
    validate: (config) => [
        ...(config.secret.trim()
            ? []
            : [
                  {
                      field: 'secret',
                      message: isHmacAlgorithm(config.algorithm)
                          ? 'Enter a signing secret.'
                          : 'Paste a private key.',
                      severity: 'warning' as const,
                  },
              ]),
        ...validJson(config.payload, 'payload', 'payload'),
        ...validJson(config.header, 'header', 'header'),
    ],
    appliedHeaders: (config) => (config.addTo === 'header' ? ['Authorization'] : []),
    previewHeaders: (config): Record<string, string> =>
        config.addTo === 'header'
            ? {
                  Authorization: withPrefix(
                      config.headerPrefix,
                      '<JWT signed when the request is sent>',
                  ),
              }
            : {},
    async applyToRequest(config, request, context) {
        const token = await signJwt(config, context.now());
        if (config.addTo === 'query') {
            request.url.searchParams.set(config.queryParamKey || 'token', token);
        } else {
            const prefix = config.headerPrefix.trim();
            request.headers.set('Authorization', prefix ? `${prefix} ${token}` : token);
        }
    },
});
