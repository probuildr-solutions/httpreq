/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { createHash, constants, publicEncrypt } from 'node:crypto';

const sha1 = (...parts: Buffer[]) => {
    const hash = createHash('sha1');
    for (const part of parts) hash.update(part);
    return hash.digest();
};

const sha256 = (...parts: Buffer[]) => {
    const hash = createHash('sha256');
    for (const part of parts) hash.update(part);
    return hash.digest();
};

const xor = (a: Buffer, b: Buffer): Buffer => {
    const out = Buffer.alloc(a.length);
    for (let i = 0; i < a.length; i++) out[i] = a[i]! ^ b[i % b.length]!;
    return out;
};

/**
 * `mysql_native_password`: SHA1(password) XOR SHA1(nonce + SHA1(SHA1(password))). Still the
 * default for MariaDB and older MySQL; removed from the newest MySQL releases.
 */
export const nativePasswordResponse = (password: string, nonce: Buffer): Buffer => {
    if (password.length === 0) return Buffer.alloc(0);
    const stage1 = sha1(Buffer.from(password, 'utf8'));
    const stage2 = sha1(stage1);
    return xor(stage1, sha1(nonce.subarray(0, 20), stage2));
};

/**
 * `caching_sha2_password`, the default of MySQL 8 and later: SHA256(password) XOR
 * SHA256(SHA256(SHA256(password)) + nonce). The server answers with "fast auth succeeded" if it
 * has seen this password recently, otherwise asks for the full exchange (see `encryptPassword`).
 */
export const cachingSha2Response = (password: string, nonce: Buffer): Buffer => {
    if (password.length === 0) return Buffer.alloc(0);
    const stage1 = sha256(Buffer.from(password, 'utf8'));
    const stage2 = sha256(stage1);
    return xor(stage1, sha256(stage2, nonce.subarray(0, 20)));
};

/**
 * The full `caching_sha2_password` exchange over a connection that is not encrypted: the password
 * (with a trailing zero), XORed with the nonce, encrypted with the server's RSA public key using
 * OAEP, so it never crosses the network in the clear.
 */
export const encryptPassword = (password: string, nonce: Buffer, publicKeyPem: string): Buffer => {
    const plain = Buffer.concat([Buffer.from(password, 'utf8'), Buffer.from([0])]);
    const masked = xor(plain, nonce.subarray(0, 20));
    return publicEncrypt(
        { key: publicKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' },
        masked,
    );
};
