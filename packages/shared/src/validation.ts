/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

/**
 * Validation and redaction shared by the renderer and the Electron main process.
 *
 * The main process must never trust the renderer, so it runs exactly these checks again on every
 * IPC payload. Keeping one implementation means the form and the privileged boundary can never
 * disagree about what a valid profile is.
 */

import {
    DEFAULT_SSH_PORT,
    isSshAuthType,
    isTunnelType,
    type SshProfile,
    type TunnelProfile,
} from './ssh';

export const MIN_PORT = 1;
export const MAX_PORT = 65_535;

export const isValidPort = (value: unknown): value is number =>
    typeof value === 'number' && Number.isInteger(value) && value >= MIN_PORT && value <= MAX_PORT;

/** Host names, IPv4/IPv6 literals and unresolved `{{variables}}` all pass; empty does not. */
export const isValidHost = (value: unknown): value is string =>
    typeof value === 'string' && value.trim().length > 0 && !/\s/.test(value.trim());

const str = (value: unknown) => (typeof value === 'string' ? value : '');
const trimmed = (value: unknown) => str(value).trim();

/** Field-keyed problems, for inline form errors. Empty means valid. */
export type ValidationErrors = Record<string, string>;

export const validateSshProfile = (profile: Partial<SshProfile>): ValidationErrors => {
    const errors: ValidationErrors = {};
    if (!trimmed(profile.name)) errors.name = 'Enter a profile name.';
    if (!isValidHost(profile.host)) errors.host = 'Enter a host name or IP address.';
    if (!isValidPort(profile.port))
        errors.port = `Enter a port between ${MIN_PORT} and ${MAX_PORT}.`;
    if (!trimmed(profile.username)) errors.username = 'Enter a username.';
    if (!isSshAuthType(profile.authType)) errors.authType = 'Choose an authentication type.';
    else if (profile.authType !== 'password' && !trimmed(profile.privateKeyPath)) {
        errors.privateKeyPath = 'Choose a private-key file.';
    }
    if (typeof profile.connectTimeoutMs !== 'number' || profile.connectTimeoutMs < 0) {
        errors.connectTimeoutMs = 'Enter a timeout of 0 or more milliseconds.';
    }
    return errors;
};

export const validateTunnelProfile = (profile: Partial<TunnelProfile>): ValidationErrors => {
    const errors: ValidationErrors = {};
    if (!trimmed(profile.name)) errors.name = 'Enter a tunnel name.';
    if (!trimmed(profile.sshProfileId)) errors.sshProfileId = 'Choose an SSH profile.';
    if (!isTunnelType(profile.type)) errors.type = 'Choose a forwarding mode.';
    if (!isValidHost(profile.localBindAddress)) {
        errors.localBindAddress = 'Enter a local bind address.';
    }
    if (!isValidPort(profile.localPort)) {
        errors.localPort = `Enter a local port between ${MIN_PORT} and ${MAX_PORT}.`;
    }
    // Dynamic (SOCKS) forwarding has no fixed destination; the client chooses one per connection.
    if (profile.type !== 'dynamic') {
        if (!isValidHost(profile.remoteHost)) errors.remoteHost = 'Enter a remote host.';
        if (!isValidPort(profile.remotePort)) {
            errors.remotePort = `Enter a remote port between ${MIN_PORT} and ${MAX_PORT}.`;
        }
    }
    return errors;
};

export const hasErrors = (errors: ValidationErrors) => Object.keys(errors).length > 0;

/**
 * Rebuilds an SSH profile from an untrusted IPC payload, keeping only known fields with valid
 * types. Returns null when a required field is missing, so the main process never acts on a
 * half-formed profile.
 */
export const parseSshProfile = (value: unknown): SshProfile | null => {
    if (!value || typeof value !== 'object') return null;
    const raw = value as Record<string, unknown>;
    const profile: SshProfile = {
        id: trimmed(raw.id),
        name: trimmed(raw.name),
        host: trimmed(raw.host),
        port: isValidPort(raw.port) ? raw.port : DEFAULT_SSH_PORT,
        username: trimmed(raw.username),
        authType: isSshAuthType(raw.authType) ? raw.authType : 'password',
        privateKeyPath: str(raw.privateKeyPath),
        credentialId: trimmed(raw.credentialId),
        keepAliveSeconds:
            typeof raw.keepAliveSeconds === 'number' && raw.keepAliveSeconds >= 0
                ? raw.keepAliveSeconds
                : 30,
        connectTimeoutMs:
            typeof raw.connectTimeoutMs === 'number' && raw.connectTimeoutMs >= 0
                ? raw.connectTimeoutMs
                : 20_000,
        description: str(raw.description),
    };
    if (!profile.id || !profile.credentialId) return null;
    return hasErrors(validateSshProfile(profile)) ? null : profile;
};

export const parseTunnelProfile = (value: unknown): TunnelProfile | null => {
    if (!value || typeof value !== 'object') return null;
    const raw = value as Record<string, unknown>;
    const profile: TunnelProfile = {
        id: trimmed(raw.id),
        name: trimmed(raw.name),
        sshProfileId: trimmed(raw.sshProfileId),
        type: isTunnelType(raw.type) ? raw.type : 'local',
        localBindAddress: trimmed(raw.localBindAddress),
        localPort: isValidPort(raw.localPort) ? raw.localPort : 0,
        remoteHost: trimmed(raw.remoteHost),
        remotePort: isValidPort(raw.remotePort) ? raw.remotePort : 0,
        autoStart: raw.autoStart === true,
        description: str(raw.description),
    };
    if (!profile.id) return null;
    return hasErrors(validateTunnelProfile(profile)) ? null : profile;
};

/* ---------- Redaction ---------- */

const SECRET_KEYS =
    /^(password|passphrase|secret|token|access[_-]?token|refresh[_-]?token|private[_-]?key|privatekey|credential|authorization|auth|apikey|api[_-]?key|cookie)$/i;

/** Marker written in place of a redacted value. */
export const REDACTED = '[redacted]';

const PEM_BLOCK = /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g;

/**
 * Removes anything that looks like a secret from text destined for a log, an error detail or the
 * UI: PEM key blocks, `Authorization` headers and `password=...` style pairs.
 */
export const redactText = (text: string): string =>
    text
        .replace(PEM_BLOCK, REDACTED)
        .replace(/(-----BEGIN [^-]*PRIVATE KEY-----)[\s\S]*/g, REDACTED)
        // A header value runs to the end of the line, so "Bearer abc.def" goes as a whole.
        .replace(
            /\b((?:proxy-)?authorization|cookie|set-cookie)(\s*:\s*).*/gi,
            (_match, key: string, separator: string) => `${key}${separator}${REDACTED}`,
        )
        .replace(
            /\b(password|passphrase|secret|token|api[_-]?key)\b(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&]+)/gi,
            (_match, key: string, separator: string) => `${key}${separator}${REDACTED}`,
        );

/**
 * Deep copy of a value with every secret-looking property replaced. Used before anything is
 * written to a log or surfaced in an error detail.
 */
export const redact = (value: unknown, depth = 0): unknown => {
    if (depth > 8) return REDACTED;
    if (typeof value === 'string') return redactText(value);
    if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
    if (value && typeof value === 'object') {
        if (value instanceof Error) return redactText(`${value.name}: ${value.message}`);
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>).map(([key, item]) => [
                key,
                SECRET_KEYS.test(key) ? REDACTED : redact(item, depth + 1),
            ]),
        );
    }
    return value;
};
