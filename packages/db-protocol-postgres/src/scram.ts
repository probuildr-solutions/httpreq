/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { createHash, createHmac, pbkdf2, randomBytes, timingSafeEqual } from 'node:crypto';
import { DbError } from '@httpreq/db-core';

const MIN_ITERATIONS = 4096;
/** A hostile server could ask for an absurd count to tie the client up. */
const MAX_ITERATIONS = 2_000_000;

const hmac = (key: Buffer, data: string | Buffer) =>
    createHmac('sha256', key).update(data).digest();
const sha256 = (data: Buffer) => createHash('sha256').update(data).digest();
const xor = (a: Buffer, b: Buffer) => Buffer.from(a.map((byte, i) => byte ^ b[i]!));

const derive = (password: string, salt: Buffer, iterations: number): Promise<Buffer> =>
    new Promise((resolve, reject) =>
        pbkdf2(password.normalize('NFKC'), salt, iterations, 32, 'sha256', (error, key) =>
            error ? reject(error) : resolve(key),
        ),
    );

const attributes = (message: string): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const part of message.split(',')) {
        if (part[1] === '=') out[part[0]!] = part.slice(2);
    }
    return out;
};

export interface ScramExchange {
    /** The client-first message, sent with the mechanism name. */
    first: Buffer;
    /** Answers the server's first message with the client-final message. */
    final: (serverFirst: Buffer) => Promise<Buffer>;
    /** Checks the server's final message: the server proves it knows the password too. */
    verify: (serverFinal: Buffer) => void;
}

/**
 * The client side of SCRAM-SHA-256 as PostgreSQL uses it (RFC 5802 and 7677). PostgreSQL takes the
 * user name from the startup message, so the name in the SCRAM message is left empty.
 */
export const scramSha256 = (
    password: string,
    nonceBytes: Buffer = randomBytes(18),
): ScramExchange => {
    const clientNonce = nonceBytes.toString('base64');
    const gs2 = 'n,,';
    const firstBare = `n=,r=${clientNonce}`;
    let serverSignature: Buffer | null = null;
    return {
        first: Buffer.from(`${gs2}${firstBare}`),
        final: async (serverFirstBuffer) => {
            const serverFirst = serverFirstBuffer.toString('utf8');
            const { r: nonce, s: salt, i: count } = attributes(serverFirst);
            if (!nonce || !salt || !count)
                throw new DbError('AUTH_FAILED', 'The server sent a malformed login message.');
            if (!nonce.startsWith(clientNonce))
                throw new DbError(
                    'AUTH_FAILED',
                    'The server did not answer with the nonce it was given.',
                );
            const iterations = Number(count);
            if (
                !Number.isInteger(iterations) ||
                iterations < MIN_ITERATIONS ||
                iterations > MAX_ITERATIONS
            ) {
                throw new DbError(
                    'AUTH_FAILED',
                    'The server asked for an unreasonable number of iterations.',
                );
            }
            const salted = await derive(password, Buffer.from(salt, 'base64'), iterations);
            const clientKey = hmac(salted, 'Client Key');
            const withoutProof = `c=${Buffer.from(gs2).toString('base64')},r=${nonce}`;
            const authMessage = `${firstBare},${serverFirst},${withoutProof}`;
            const proof = xor(clientKey, hmac(sha256(clientKey), authMessage));
            serverSignature = hmac(hmac(salted, 'Server Key'), authMessage);
            return Buffer.from(`${withoutProof},p=${proof.toString('base64')}`);
        },
        verify: (serverFinalBuffer) => {
            const { v, e } = attributes(serverFinalBuffer.toString('utf8'));
            if (e) throw new DbError('AUTH_FAILED', `Login was refused (${e}).`);
            const given = v ? Buffer.from(v, 'base64') : null;
            if (
                !serverSignature ||
                !given ||
                given.length !== serverSignature.length ||
                !timingSafeEqual(given, serverSignature)
            ) {
                throw new DbError(
                    'AUTH_FAILED',
                    'The server could not prove it knows the password.',
                );
            }
        },
    };
};

/** What a server stores for a password, for the test server and for checking a proof. */
export const scramVerifier = async (password: string, salt: Buffer, iterations: number) => {
    const salted = await derive(password, salt, iterations);
    return { storedKey: sha256(hmac(salted, 'Client Key')), serverKey: hmac(salted, 'Server Key') };
};

/** `md5(md5(password + user) + salt)`, the legacy challenge response. */
export const md5Password = (user: string, password: string, salt: Buffer): string => {
    const inner = createHash('md5').update(password).update(user).digest('hex');
    return `md5${createHash('md5').update(inner).update(salt).digest('hex')}`;
};
