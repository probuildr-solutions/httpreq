/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { readFile } from 'node:fs/promises';
import { Client, type ConnectConfig } from 'ssh2';
import {
    redactText,
    SSH_ERROR_CODES,
    sshError,
    sshErrorOf,
    type HostKeyPrompt,
    type SshErrorInfo,
    type SshProfile,
} from '@httpreq/shared';
import type { CredentialStore } from './credentials';
import { fingerprintOf, type KnownHostsStore } from './knownHosts';

/**
 * Opening an authenticated `ssh2` connection: reading the key, fetching the secret from the vault,
 * verifying the host key, and turning every library failure into an actionable error.
 *
 * Both the terminal sessions and the tunnels go through here, so host verification and credential
 * handling cannot differ between them.
 */

/** Asks the user whether to trust a host key. Resolves to false to abort the connection. */
export type HostKeyApprover = (prompt: HostKeyPrompt) => Promise<boolean>;

export interface ConnectionDeps {
    credentials: CredentialStore;
    knownHosts: KnownHostsStore;
}

/** The key type is the first SSH wire-format string in the host key blob. */
const hostKeyType = (key: Buffer): string => {
    try {
        const length = key.readUInt32BE(0);
        return length > 0 && length < key.length
            ? key.subarray(4, 4 + length).toString('ascii')
            : 'ssh';
    } catch {
        return 'ssh';
    }
};

const AUTH_HINTS = [
    'all configured authentication methods failed',
    'authentication failure',
    'no matching authentication',
];

/**
 * Maps an `ssh2` or Node error to a user-facing one. The detail is passed through redaction, so a
 * library message that happened to echo a passphrase cannot reach the UI or a log.
 */
export const toSshError = (error: unknown): SshErrorInfo => {
    if (isSshErrorInfo(error)) return error;
    const raw = error instanceof Error ? error : new Error(String(error));
    const message = raw.message.toLowerCase();
    const level = (raw as { level?: string }).level;
    const code = (raw as { code?: string }).code;
    const detail = redactText(raw.message);

    if (level === 'client-timeout' || code === 'ETIMEDOUT' || message.includes('timed out')) {
        return sshErrorOf('SSH_TIMEOUT', detail);
    }
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
        return sshError(
            'SSH_HOST_UNREACHABLE',
            'Host could not be resolved. Check the host name or IP address.',
            detail,
        );
    }
    if (code === 'ECONNREFUSED') {
        return sshError(
            'SSH_HOST_UNREACHABLE',
            'The connection was refused. Check the port and that the SSH service is running.',
            detail,
        );
    }
    if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || code === 'ECONNRESET') {
        return sshErrorOf('SSH_HOST_UNREACHABLE', detail);
    }
    if (message.includes('passphrase')) {
        return message.includes('encrypted') && message.includes('no passphrase')
            ? sshError(
                  'SSH_KEY_PASSPHRASE_INVALID',
                  'This private key is encrypted. Choose "Private key + passphrase" and enter it.',
                  detail,
              )
            : sshErrorOf('SSH_KEY_PASSPHRASE_INVALID', detail);
    }
    if (message.includes('cannot parse privatekey') || message.includes('unsupported key format')) {
        return sshErrorOf('SSH_KEY_UNREADABLE', detail);
    }
    if (level === 'client-authentication' || AUTH_HINTS.some((hint) => message.includes(hint))) {
        return sshErrorOf('SSH_AUTH_FAILED', detail);
    }
    return sshError('SSH_UNKNOWN', 'The SSH connection failed.', detail);
};

/**
 * Only an error this module already produced. The check is deliberately strict: a Node error
 * carries a `code` too (`ENOTFOUND`, `ETIMEDOUT`), and passing one through unmapped would put a
 * raw library string in front of the user instead of an actionable message.
 */
const isSshErrorInfo = (value: unknown): value is SshErrorInfo =>
    !!value &&
    typeof value === 'object' &&
    !(value instanceof Error) &&
    typeof (value as SshErrorInfo).message === 'string' &&
    (SSH_ERROR_CODES as readonly string[]).includes((value as SshErrorInfo).code);

const readPrivateKey = async (path: string): Promise<Buffer> => {
    try {
        return await readFile(path);
    } catch (cause) {
        const reason =
            (cause as { code?: string }).code === 'ENOENT' ? 'not found' : 'not readable';
        throw sshError(
            'SSH_KEY_UNREADABLE',
            `Unable to read private key: the file is ${reason}.`,
            // The path is the user's own and contains no secret, so it helps rather than leaks.
            path,
        );
    }
};

/**
 * Builds the `ssh2` configuration for a profile: the key is read from its original location and
 * the password or passphrase comes straight from the vault into this object, which stays inside
 * the main process and is never returned, serialized or logged.
 */
const buildConfig = async (profile: SshProfile, deps: ConnectionDeps): Promise<ConnectConfig> => {
    const config: ConnectConfig = {
        host: profile.host,
        port: profile.port,
        username: profile.username,
        readyTimeout: profile.connectTimeoutMs > 0 ? profile.connectTimeoutMs : undefined,
        keepaliveInterval: profile.keepAliveSeconds > 0 ? profile.keepAliveSeconds * 1000 : 0,
        // Every authentication method is explicit, so ssh2 never silently tries an agent or a
        // default key from the user's home directory.
        agent: undefined,
        tryKeyboard: false,
    };

    const secret = await deps.credentials.get(profile.credentialId);
    if (profile.authType === 'password') {
        if (!secret) {
            throw sshError(
                'SSH_AUTH_FAILED',
                'No password is stored for this connection. Edit the profile and enter it.',
            );
        }
        config.password = secret;
        return config;
    }

    config.privateKey = await readPrivateKey(profile.privateKeyPath);
    if (profile.authType === 'key-passphrase') {
        if (!secret) {
            throw sshError(
                'SSH_KEY_PASSPHRASE_INVALID',
                'No passphrase is stored for this key. Edit the profile and enter it.',
            );
        }
        config.passphrase = secret;
    }
    return config;
};

export interface OpenedConnection {
    client: Client;
    /** Fingerprint the server presented, for display. */
    fingerprint: string;
    banner: string;
}

/**
 * Connects and authenticates, prompting for host-key approval when the key is unknown or has
 * changed. Rejects with an {@link SshErrorInfo}.
 */
export const openConnection = async (
    profile: SshProfile,
    deps: ConnectionDeps,
    /** Supplied per call, because the prompt belongs to the window that asked to connect. */
    approveHostKey: HostKeyApprover,
): Promise<OpenedConnection> => {
    const config = await buildConfig(profile, deps);
    const client = new Client();
    let fingerprint = '';
    let banner = '';

    return new Promise<OpenedConnection>((resolve, reject) => {
        let settled = false;
        const fail = (error: unknown) => {
            if (settled) return;
            settled = true;
            client.end();
            client.destroy();
            reject(toSshError(error));
        };

        client.on('banner', (message: string) => {
            banner = message;
        });
        client.on('error', fail);
        client.on('ready', () => {
            if (settled) return;
            settled = true;
            resolve({ client, fingerprint, banner });
        });
        client.on('close', () => {
            if (!settled) fail(sshErrorOf('SSH_CONNECTION_LOST'));
        });

        const hostVerifier = (key: Buffer, callback: (accepted: boolean) => void) => {
            fingerprint = fingerprintOf(key);
            const keyType = hostKeyType(key);
            void (async () => {
                try {
                    const verdict = await deps.knownHosts.check(
                        profile.host,
                        profile.port,
                        fingerprint,
                    );
                    if (verdict.kind === 'trusted') {
                        callback(true);
                        return;
                    }
                    const accepted = await approveHostKey({
                        host: profile.host,
                        port: profile.port,
                        keyType,
                        fingerprint,
                        storedFingerprint:
                            verdict.kind === 'changed' ? verdict.storedFingerprint : null,
                    });
                    if (!accepted) {
                        // Reported before `callback(false)`, whose own error is a generic handshake failure.
                        fail(
                            verdict.kind === 'changed'
                                ? sshErrorOf('SSH_HOST_KEY_CHANGED')
                                : sshErrorOf('SSH_HOST_KEY_REJECTED'),
                        );
                        callback(false);
                        return;
                    }
                    await deps.knownHosts.trust(profile.host, profile.port, keyType, fingerprint);
                    callback(true);
                } catch (error) {
                    fail(error);
                    callback(false);
                }
            })();
        };

        try {
            client.connect({ ...config, hostVerifier });
        } catch (error) {
            fail(error);
        }
    });
};
