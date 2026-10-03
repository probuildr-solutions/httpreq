/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { describe, expect, it } from 'vitest';
import { explainConnectionFailure } from './connectionErrors';

const kind = (message: string) => explainConnectionFailure(new Error(message)).kind;

describe('connection failures', () => {
    it.each([
        ['Could not connect to db.example.com:3306 (ENOTFOUND).', 'dns'],
        ['MongoDB SRV lookup failed: there are no SRV records for “c.example.net”.', 'srv'],
        ['Could not connect to h:1 (ETIMEDOUT).', 'timeout'],
        ['Connection timed out after 10000 ms.', 'timeout'],
        ['Could not connect to h:1 (ECONNREFUSED).', 'refused'],
        ['Could not connect to h:1 (EHOSTUNREACH).', 'unreachable'],
        ['Could not connect to h:1 (DEPTH_ZERO_SELF_SIGNED_CERT).', 'certificate'],
        ['Could not connect to h:1 (CERT_HAS_EXPIRED).', 'certificate'],
        ['Could not connect to h:1 (ERR_TLS_CERT_ALTNAME_INVALID).', 'certificate'],
        ['Could not connect to h:1 (ERR_SSL_WRONG_VERSION_NUMBER).', 'tls'],
        ['Access denied for user “root” (using password).', 'auth'],
        ['Authentication failed.', 'auth'],
        [
            'The login method “PLAIN” is not supported (use SCRAM-SHA-256 or SCRAM-SHA-1).',
            'unsupported-auth',
        ],
        ['Unknown database “shop”.', 'unavailable'],
        ['something odd', 'unknown'],
    ])('classifies “%s” as %s', (message, expected) => {
        expect(kind(message)).toBe(expected);
    });

    it('hides a password in the detail it keeps', () => {
        const failure = explainConnectionFailure(
            new Error('bad uri mysql://root:hunter2@db.example.com/x'),
        );
        expect(failure.detail).not.toContain('hunter2');
    });

    it('always offers something to check', () => {
        expect(explainConnectionFailure(new Error('x')).hint.length).toBeGreaterThan(10);
    });
});
