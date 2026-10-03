/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { createHash, createHmac, pbkdf2, randomBytes, timingSafeEqual } from 'node:crypto';
import { DbError } from '@httpreq/db-core';

export type ScramMechanism = 'SCRAM-SHA-1' | 'SCRAM-SHA-256';

const MIN_ITERATIONS = 4096;
/** An absurd iteration count would be a denial of service from a hostile server. */
const MAX_ITERATIONS = 2_000_000;

const algorithm = (mechanism: ScramMechanism) => (mechanism === 'SCRAM-SHA-1' ? 'sha1' : 'sha256');

const hmac = (mechanism: ScramMechanism, key: Buffer, data: string | Buffer): Buffer =>
    createHmac(algorithm(mechanism), key).update(data).digest();

const hash = (mechanism: ScramMechanism, data: Buffer): Buffer =>
    createHash(algorithm(mechanism)).update(data).digest();

const xor = (a: Buffer, b: Buffer): Buffer => Buffer.from(a.map((byte, i) => byte ^ b[i]!));

const pbkdf2Async = (
    password: string | Buffer,
    salt: Buffer,
    iterations: number,
    length: number,
    digest: string,
): Promise<Buffer> =>
    new Promise((resolve, reject) =>
        pbkdf2(password, salt, iterations, length, digest, (error, key) =>
            error ? reject(error) : resolve(key),
        ),
    );

/** Escapes the characters SCRAM reserves in a user name. */
const saslName = (name: string) => name.replace(/=/g, '=3D').replace(/,/g, '=2C');

const parseAttributes = (message: string): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const part of message.split(',')) {
        const at = part.indexOf('=');
        if (at === 1) out[part[0]!] = part.slice(2);
    }
    return out;
};

/**
 * The password as the mechanism feeds it into the key derivation. SCRAM-SHA-1 in MongoDB hashes
 * `user:mongo:password` with MD5 first (a historical quirk); SCRAM-SHA-256 uses the password
 * itself, normalised (SASLprep is approximated by Unicode NFKC, which is what it reduces to for
 * the characters that occur in passwords).
 */
const preparePassword = (
    mechanism: ScramMechanism,
    user: string,
    password: string,
): string | Buffer =>
    mechanism === 'SCRAM-SHA-1'
        ? createHash('md5').update(`${user}:mongo:${password}`).digest('hex')
        : password.normalize('NFKC');

export interface ScramStart {
    /** The payload for `saslStart`. */
    payload: Buffer;
    /** Continues the conversation with the server's reply; returns the next payload. */
    next: (serverFirst: Buffer) => Promise<Buffer>;
    /** Checks the server's final message, proving the server knew the password too. */
    finish: (serverFinal: Buffer) => void;
}

/**
 * The client side of SCRAM (RFC 5802 / 7677) for MongoDB. It is a small state machine, kept free
 * of any socket so it can be tested against the server side written in the tests.
 */
export const scramStart = (
    mechanism: ScramMechanism,
    user: string,
    password: string,
    nonceBytes: Buffer = randomBytes(24),
): ScramStart => {
    const clientNonce = nonceBytes.toString('base64');
    const gs2 = 'n,,';
    const clientFirstBare = `n=${saslName(user)},r=${clientNonce}`;
    let serverSignature: Buffer | null = null;

    return {
        payload: Buffer.from(`${gs2}${clientFirstBare}`),
        next: async (serverFirstBuffer) => {
            const serverFirst = serverFirstBuffer.toString('utf8');
            const attributes = parseAttributes(serverFirst);
            if (attributes.m)
                throw new DbError(
                    'AUTH_FAILED',
                    'The server requires an extension this client does not support.',
                );
            const { r: nonce, s: salt, i: iterationText } = attributes;
            if (!nonce || !salt || !iterationText) {
                throw new DbError('AUTH_FAILED', 'The server sent a malformed login message.');
            }
            if (!nonce.startsWith(clientNonce)) {
                throw new DbError(
                    'AUTH_FAILED',
                    'The server did not answer with the nonce it was given.',
                );
            }
            const iterations = Number(iterationText);
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
            const digestLength = mechanism === 'SCRAM-SHA-1' ? 20 : 32;
            const salted = await pbkdf2Async(
                preparePassword(mechanism, user, password),
                Buffer.from(salt, 'base64'),
                iterations,
                digestLength,
                algorithm(mechanism),
            );
            const clientKey = hmac(mechanism, salted, 'Client Key');
            const storedKey = hash(mechanism, clientKey);
            const clientFinalWithoutProof = `c=${Buffer.from(gs2).toString('base64')},r=${nonce}`;
            const authMessage = `${clientFirstBare},${serverFirst},${clientFinalWithoutProof}`;
            const clientSignature = hmac(mechanism, storedKey, authMessage);
            const proof = xor(clientKey, clientSignature);
            serverSignature = hmac(mechanism, hmac(mechanism, salted, 'Server Key'), authMessage);
            return Buffer.from(`${clientFinalWithoutProof},p=${proof.toString('base64')}`);
        },
        finish: (serverFinalBuffer) => {
            const attributes = parseAttributes(serverFinalBuffer.toString('utf8'));
            if (attributes.e)
                throw new DbError('AUTH_FAILED', `Login was refused (${attributes.e}).`);
            const expected = serverSignature;
            const given = attributes.v ? Buffer.from(attributes.v, 'base64') : null;
            if (
                !expected ||
                !given ||
                given.length !== expected.length ||
                !timingSafeEqual(given, expected)
            ) {
                throw new DbError(
                    'AUTH_FAILED',
                    'The server could not prove it knows the password.',
                );
            }
        },
    };
};

/** Test support and server-side checks: derives what a server stores for a password. */
export const scramCredentials = async (
    mechanism: ScramMechanism,
    user: string,
    password: string,
    salt: Buffer,
    iterations: number,
) => {
    const salted = await pbkdf2Async(
        preparePassword(mechanism, user, password),
        salt,
        iterations,
        mechanism === 'SCRAM-SHA-1' ? 20 : 32,
        algorithm(mechanism),
    );
    return {
        storedKey: hash(mechanism, hmac(mechanism, salted, 'Client Key')),
        serverKey: hmac(mechanism, salted, 'Server Key'),
    };
};
