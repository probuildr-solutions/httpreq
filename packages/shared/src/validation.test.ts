/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { describe, expect, it } from 'vitest';
import {
    createSshProfile,
    createTunnelProfile,
    hasErrors,
    parseSshProfile,
    parseTunnelProfile,
    redact,
    redactText,
    REDACTED,
    validateSshProfile,
    validateTunnelProfile,
} from './index';

const validProfile = () => ({
    ...createSshProfile('Bastion'),
    host: 'ssh.example.com',
    username: 'ada',
});

const validTunnel = (sshProfileId: string) => ({
    ...createTunnelProfile(sshProfileId, 'MySQL'),
    localPort: 3307,
    remoteHost: 'mysql.internal',
    remotePort: 3306,
});

describe('validateSshProfile', () => {
    it('accepts a complete password profile', () => {
        expect(validateSshProfile(validProfile())).toEqual({});
    });

    it('reports every missing field at once, so the form can show them together', () => {
        const errors = validateSshProfile(createSshProfile(''));
        expect(Object.keys(errors).sort()).toEqual(['host', 'name', 'username']);
    });

    it('requires a key file for both key-based authentication types', () => {
        for (const authType of ['key', 'key-passphrase'] as const) {
            expect(validateSshProfile({ ...validProfile(), authType })).toHaveProperty(
                'privateKeyPath',
            );
            expect(
                validateSshProfile({
                    ...validProfile(),
                    authType,
                    privateKeyPath: '/home/ada/id_ed25519',
                }),
            ).toEqual({});
        }
    });

    it('accepts an unresolved variable as a host, and rejects a port outside the range', () => {
        expect(validateSshProfile({ ...validProfile(), host: '{{SSH_HOST}}' })).toEqual({});
        expect(validateSshProfile({ ...validProfile(), port: 0 })).toHaveProperty('port');
        expect(validateSshProfile({ ...validProfile(), port: 70_000 })).toHaveProperty('port');
    });
});

describe('validateTunnelProfile', () => {
    it('accepts a complete local tunnel', () => {
        expect(validateTunnelProfile(validTunnel('ssh-1'))).toEqual({});
    });

    it('requires an SSH profile and both ends of the forward', () => {
        const errors = validateTunnelProfile(createTunnelProfile('', 'Tunnel'));
        expect(hasErrors(errors)).toBe(true);
        expect(Object.keys(errors).sort()).toEqual([
            'localPort',
            'remoteHost',
            'remotePort',
            'sshProfileId',
        ]);
    });

    it('does not ask a dynamic tunnel for a destination, because the client chooses one', () => {
        const dynamic = {
            ...validTunnel('ssh-1'),
            type: 'dynamic' as const,
            remoteHost: '',
            remotePort: 0,
        };
        expect(validateTunnelProfile(dynamic)).toEqual({});
    });
});

describe('parseSshProfile', () => {
    it('rebuilds a valid profile from an untrusted payload', () => {
        const profile = validProfile();
        expect(parseSshProfile(JSON.parse(JSON.stringify(profile)))).toEqual(profile);
    });

    it('rejects anything incomplete or not a profile at all', () => {
        expect(parseSshProfile(null)).toBeNull();
        expect(parseSshProfile('nope')).toBeNull();
        expect(parseSshProfile({ ...validProfile(), host: '' })).toBeNull();
        expect(parseSshProfile({ ...validProfile(), id: '' })).toBeNull();
        expect(parseSshProfile({ ...validProfile(), credentialId: '' })).toBeNull();
    });

    it('drops unknown fields, so a renderer cannot smuggle extra ssh2 options through', () => {
        const parsed = parseSshProfile({
            ...validProfile(),
            password: 'hunter2',
            privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----',
            agentForward: true,
        });
        expect(parsed).not.toBeNull();
        expect(parsed).not.toHaveProperty('password');
        expect(parsed).not.toHaveProperty('privateKey');
        expect(parsed).not.toHaveProperty('agentForward');
    });

    it('falls back to the default port when the payload gives a nonsense one', () => {
        expect(parseSshProfile({ ...validProfile(), port: -1 })?.port).toBe(22);
    });
});

describe('parseTunnelProfile', () => {
    it('rebuilds a valid tunnel and rejects an invalid one', () => {
        const tunnel = validTunnel('ssh-1');
        expect(parseTunnelProfile(JSON.parse(JSON.stringify(tunnel)))).toEqual(tunnel);
        expect(parseTunnelProfile({ ...tunnel, localPort: 0 })).toBeNull();
        expect(parseTunnelProfile({})).toBeNull();
    });

    it('keeps an unknown forwarding mode out by falling back to local', () => {
        expect(parseTunnelProfile({ ...validTunnel('ssh-1'), type: 'sneaky' })?.type).toBe('local');
    });
});

describe('redaction', () => {
    it('removes a PEM private key wherever it appears', () => {
        const key =
            '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNza\n-----END OPENSSH PRIVATE KEY-----';
        const text = redactText(`Failed to parse: ${key}`);
        expect(text).not.toContain('b3BlbnNza');
        expect(text).toContain(REDACTED);
    });

    it('removes a truncated key block too, so a partial dump cannot leak', () => {
        expect(redactText('-----BEGIN RSA PRIVATE KEY-----\nMIIEow')).not.toContain('MIIEow');
    });

    it('removes password-like pairs in free text', () => {
        expect(redactText('connect password=hunter2 user=ada')).toBe(
            `connect password=${REDACTED} user=ada`,
        );
        expect(redactText('Authorization: Bearer abc.def')).toBe(`Authorization: ${REDACTED}`);
    });

    it('replaces secret-looking properties at any depth of an object', () => {
        const redacted = redact({
            host: 'ssh.example.com',
            auth: { password: 'hunter2', passphrase: 'open sesame' },
            nested: [{ apiKey: 'k-123', label: 'fine' }],
        }) as Record<string, unknown>;

        expect(JSON.stringify(redacted)).not.toMatch(/hunter2|open sesame|k-123/);
        expect(redacted.host).toBe('ssh.example.com');
        expect((redacted.nested as Record<string, unknown>[])[0]!.label).toBe('fine');
    });

    it('redacts an Error down to a safe one-line summary', () => {
        expect(redact(new Error('bad passphrase: "swordfish"'))).toBe(
            `Error: bad passphrase: ${REDACTED}`,
        );
    });
});
