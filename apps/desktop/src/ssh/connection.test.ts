/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { describe, expect, it } from 'vitest';
import { REDACTED } from '@httpreq/shared';
import { toSshError } from './connection';

/** An ssh2-style error: a message plus the `level` or `code` the library attaches. */
const sshFailure = (message: string, extra: Record<string, string> = {}) =>
    Object.assign(new Error(message), extra);

describe('toSshError', () => {
    it('maps an authentication failure to an actionable message', () => {
        const error = toSshError(
            sshFailure('All configured authentication methods failed', {
                level: 'client-authentication',
            }),
        );
        expect(error.code).toBe('SSH_AUTH_FAILED');
        expect(error.message).toMatch(/username and credentials/i);
    });

    it('maps DNS, refusal and unreachability to a host problem, each with its own advice', () => {
        expect(toSshError(sshFailure('getaddrinfo', { code: 'ENOTFOUND' }))).toMatchObject({
            code: 'SSH_HOST_UNREACHABLE',
            message: expect.stringMatching(/host name or IP/i),
        });
        expect(toSshError(sshFailure('connect', { code: 'ECONNREFUSED' }))).toMatchObject({
            code: 'SSH_HOST_UNREACHABLE',
            message: expect.stringMatching(/port and that the SSH service/i),
        });
        expect(toSshError(sshFailure('unreachable', { code: 'EHOSTUNREACH' })).code).toBe(
            'SSH_HOST_UNREACHABLE',
        );
    });

    it('maps a timeout, however the library reports it', () => {
        expect(toSshError(sshFailure('x', { level: 'client-timeout' })).code).toBe('SSH_TIMEOUT');
        expect(toSshError(sshFailure('x', { code: 'ETIMEDOUT' })).code).toBe('SSH_TIMEOUT');
        expect(toSshError(new Error('Connection timed out')).code).toBe('SSH_TIMEOUT');
    });

    it('distinguishes a wrong passphrase from an unreadable key', () => {
        expect(toSshError(new Error('Bad passphrase')).code).toBe('SSH_KEY_PASSPHRASE_INVALID');
        expect(toSshError(new Error('Cannot parse privateKey: unsupported')).code).toBe(
            'SSH_KEY_UNREADABLE',
        );
    });

    it('tells the user which option to pick when the key is encrypted but no passphrase was given', () => {
        const error = toSshError(
            new Error('Encrypted private OpenSSH key detected, but no passphrase given'),
        );
        expect(error.code).toBe('SSH_KEY_PASSPHRASE_INVALID');
        expect(error.message).toMatch(/Private key \+ passphrase/i);
    });

    it('falls back to a generic failure it can still show', () => {
        const error = toSshError(new Error('something odd'));
        expect(error.code).toBe('SSH_UNKNOWN');
        expect(error.detail).toBe('something odd');
    });

    it('redacts the detail, so a library message echoing a secret cannot reach the UI', () => {
        const error = toSshError(new Error('auth failed with password=hunter2'));
        expect(error.detail).not.toContain('hunter2');
        expect(error.detail).toContain(REDACTED);
    });

    it('passes an error it produced itself straight through', () => {
        const original = { code: 'SSH_HOST_KEY_CHANGED' as const, message: 'changed' };
        expect(toSshError(original)).toBe(original);
    });
});
