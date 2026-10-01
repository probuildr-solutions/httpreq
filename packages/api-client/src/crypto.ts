/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

/** Small encoding and hashing helpers shared by authorization providers. */

const encoder = new TextEncoder();

export const utf8 = (text: string) => encoder.encode(text);

/** Standard Base64 of `bytes`, encoded in chunks so a large buffer cannot overflow the call stack. */
export const bytesToBase64 = (bytes: Uint8Array): string => {
    let binary = '';
    for (let index = 0; index < bytes.length; index += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    }
    return btoa(binary);
};

export const base64ToBytes = (base64: string): Uint8Array => {
    const binary = atob(base64.replace(/\s+/g, ''));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
};

/** URL-safe Base64 without padding (RFC 4648 §5), as PKCE and JWT require. */
export const base64Url = (bytes: Uint8Array) =>
    bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export const base64UrlFromBase64 = (base64: string) =>
    base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export const hex = (bytes: Uint8Array) =>
    Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

export const randomBytes = (length: number) => crypto.getRandomValues(new Uint8Array(length));

/** SHA-256 digest via Web Crypto, which is available in both the browser and Electron. */
export const sha256 = async (bytes: Uint8Array) =>
    new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));

/* MD5 (RFC 1321). Web Crypto does not provide it, but HTTP Digest authentication still needs it. */

const SHIFTS = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9,
    14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];
const CONSTANTS = Array.from({ length: 64 }, (_, index) =>
    Math.floor(Math.abs(Math.sin(index + 1)) * 2 ** 32),
);

/** MD5 digest of `input`. Only HTTP Digest authentication needs it, never anything
 * security-sensitive of our own.
 */
export const md5 = (input: Uint8Array): Uint8Array => {
    const length = input.length;
    const padded = new Uint8Array((((length + 8) >> 6) + 1) * 64);
    padded.set(input);
    padded[length] = 0x80;
    const view = new DataView(padded.buffer);
    view.setUint32(padded.length - 8, (length * 8) >>> 0, true);
    view.setUint32(padded.length - 4, Math.floor(length / 0x20000000), true);

    let a0 = 0x67452301;
    let b0 = 0xefcdab89;
    let c0 = 0x98badcfe;
    let d0 = 0x10325476;
    const words = new Uint32Array(16);
    for (let offset = 0; offset < padded.length; offset += 64) {
        for (let index = 0; index < 16; index += 1)
            words[index] = view.getUint32(offset + index * 4, true);
        let a = a0;
        let b = b0;
        let c = c0;
        let d = d0;
        for (let index = 0; index < 64; index += 1) {
            let f: number;
            let g: number;
            if (index < 16) {
                f = (b & c) | (~b & d);
                g = index;
            } else if (index < 32) {
                f = (d & b) | (~d & c);
                g = (5 * index + 1) % 16;
            } else if (index < 48) {
                f = b ^ c ^ d;
                g = (3 * index + 5) % 16;
            } else {
                f = c ^ (b | ~d);
                g = (7 * index) % 16;
            }
            const next = d;
            d = c;
            c = b;
            const sum = (a + f + CONSTANTS[index]! + words[g]!) >>> 0;
            const shift = SHIFTS[index]!;
            b = (b + ((sum << shift) | (sum >>> (32 - shift)))) >>> 0;
            a = next;
        }
        a0 = (a0 + a) >>> 0;
        b0 = (b0 + b) >>> 0;
        c0 = (c0 + c) >>> 0;
        d0 = (d0 + d) >>> 0;
    }
    const out = new Uint8Array(16);
    const outView = new DataView(out.buffer);
    [a0, b0, c0, d0].forEach((word, index) => outView.setUint32(index * 4, word, true));
    return out;
};
