/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

/**
 * SSH and port-forwarding domain model. Desktop only.
 *
 * Nothing in this file holds a secret. Profiles reference a private key by its path on disk and a
 * password or passphrase by an opaque `credentialId` whose value lives in the OS credential vault,
 * so workspace storage, application state, exports and logs can never contain one.
 */

import { createId } from './model';

export const SSH_AUTH_TYPES = ['password', 'key', 'key-passphrase'] as const;
export type SshAuthType = (typeof SSH_AUTH_TYPES)[number];

export const isSshAuthType = (value: unknown): value is SshAuthType =>
    typeof value === 'string' && (SSH_AUTH_TYPES as readonly string[]).includes(value);

export const DEFAULT_SSH_PORT = 22;

/** A reusable connection profile. Secrets are referenced, never embedded. */
export interface SshProfile {
    id: string;
    name: string;
    /** Host name or IP; may contain `{{variables}}`. */
    host: string;
    port: number;
    /** May contain `{{variables}}`. */
    username: string;
    authType: SshAuthType;
    /** Absolute path of a `.pem`/OpenSSH private key, chosen with the native file picker. */
    privateKeyPath: string;
    /**
     * Vault key for this profile's password or key passphrase. Stable across edits so the stored
     * secret follows the profile; the value itself is never part of this object.
     */
    credentialId: string;
    /** Seconds between keep-alive probes; 0 disables them. */
    keepAliveSeconds: number;
    /** Milliseconds to wait for the TCP connection and handshake. */
    connectTimeoutMs: number;
    description: string;
}

export const createSshProfile = (name = 'New Connection'): SshProfile => ({
    id: createId(),
    name,
    host: '',
    port: DEFAULT_SSH_PORT,
    username: '',
    authType: 'password',
    privateKeyPath: '',
    credentialId: createId(),
    keepAliveSeconds: 30,
    connectTimeoutMs: 20_000,
    description: '',
});

export const TUNNEL_TYPES = ['local', 'remote', 'dynamic'] as const;
/**
 * Forwarding direction. Only `local` (ssh -L) is implemented; `remote` (-R) and `dynamic`
 * (-D, SOCKS) are part of the model so profiles and UI do not have to change when they land.
 */
export type TunnelType = (typeof TUNNEL_TYPES)[number];

export const isTunnelType = (value: unknown): value is TunnelType =>
    typeof value === 'string' && (TUNNEL_TYPES as readonly string[]).includes(value);

export const IMPLEMENTED_TUNNEL_TYPES: readonly TunnelType[] = ['local'];

/** Binding to anything other than the loopback address exposes the tunnel to the network. */
export const LOOPBACK_BIND_ADDRESS = '127.0.0.1';

export const isLoopbackAddress = (address: string) =>
    address === '127.0.0.1' || address === '::1' || address === 'localhost';

export interface TunnelProfile {
    id: string;
    name: string;
    /** The SSH profile that carries the tunnel. */
    sshProfileId: string;
    type: TunnelType;
    /** Local interface to listen on; defaults to loopback. */
    localBindAddress: string;
    localPort: number;
    /** Ignored for `dynamic` tunnels. */
    remoteHost: string;
    remotePort: number;
    /** Start this tunnel as soon as its workspace is opened. */
    autoStart: boolean;
    description: string;
}

export const createTunnelProfile = (sshProfileId = '', name = 'New Tunnel'): TunnelProfile => ({
    id: createId(),
    name,
    sshProfileId,
    type: 'local',
    localBindAddress: LOOPBACK_BIND_ADDRESS,
    localPort: 0,
    remoteHost: '',
    remotePort: 0,
    autoStart: false,
    description: '',
});

export const SSH_STATUSES = [
    'disconnected',
    'connecting',
    'connected',
    'disconnecting',
    'error',
] as const;
export type SshStatus = (typeof SSH_STATUSES)[number];

export const isSshStatus = (value: unknown): value is SshStatus =>
    typeof value === 'string' && (SSH_STATUSES as readonly string[]).includes(value);

export const TUNNEL_STATUSES = ['stopped', 'starting', 'active', 'stopping', 'error'] as const;
export type TunnelStatus = (typeof TUNNEL_STATUSES)[number];

/** Live statistics for a running tunnel, pushed to the UI as they change. */
export interface TunnelRuntimeState {
    tunnelId: string;
    status: TunnelStatus;
    /** ISO timestamp of the last successful start. */
    startedAt: string | null;
    bytesSent: number;
    bytesReceived: number;
    activeConnections: number;
    error: SshErrorInfo | null;
}

/** The host identity offered during a handshake, for the trust prompt. */
export interface HostKeyPrompt {
    host: string;
    port: number;
    keyType: string;
    /** `SHA256:...`, the same form OpenSSH prints. */
    fingerprint: string;
    /** Set when a different key was already trusted for this host: a possible interception. */
    storedFingerprint: string | null;
}

export type HostKeyDecision = 'trust' | 'reject';

export interface KnownHostEntry {
    host: string;
    port: number;
    keyType: string;
    fingerprint: string;
    trustedAt: string;
}

export const SSH_ERROR_CODES = [
    'SSH_AUTH_FAILED',
    'SSH_KEY_UNREADABLE',
    'SSH_KEY_PASSPHRASE_INVALID',
    'SSH_TIMEOUT',
    'SSH_HOST_UNREACHABLE',
    'SSH_HOST_KEY_REJECTED',
    'SSH_HOST_KEY_CHANGED',
    'SSH_CONNECTION_LOST',
    'SSH_PROFILE_INVALID',
    'TUNNEL_PORT_IN_USE',
    'TUNNEL_BIND_FAILED',
    'TUNNEL_FORWARD_REFUSED',
    'TUNNEL_NOT_SUPPORTED',
    'SSH_UNAVAILABLE',
    'SSH_UNKNOWN',
] as const;
export type SshErrorCode = (typeof SSH_ERROR_CODES)[number];

/**
 * An actionable error. `message` is written for the user; `detail` may carry sanitized technical
 * context for an expandable section and never contains a key, password or passphrase.
 */
export interface SshErrorInfo {
    code: SshErrorCode;
    message: string;
    detail?: string;
}

/** Terminal dimensions, in cells and pixels, for a pty resize. */
export interface TerminalSize {
    cols: number;
    rows: number;
    width: number;
    height: number;
}

export type SshSessionEvent =
    | { type: 'status'; status: SshStatus }
    | { type: 'data'; data: string }
    | { type: 'error'; error: SshErrorInfo }
    | { type: 'closed'; code: number | null; signal: string | null };

/** How a secret reaches the vault. The renderer sends it once and never reads it back. */
export interface SshCredentialInput {
    credentialId: string;
    secret: string;
}

export interface SshConnectOptions {
    /** Session id chosen by the renderer; scoped to the window that created it. */
    sessionId: string;
    /** Profile with `{{variables}}` already resolved. */
    profile: SshProfile;
    /** Initial terminal size, so the remote shell starts at the right dimensions. */
    size: TerminalSize;
}

export type IpcOutcome<T> = { ok: true; value: T } | { ok: false; error: SshErrorInfo };

/** SSH operations the preload exposes. Every call is re-validated in the main process. */
export interface SshBridge {
    listSessions(): Promise<string[]>;
    connect(options: SshConnectOptions): Promise<IpcOutcome<void>>;
    /** Opens a connection, runs the handshake and closes it again. */
    testConnection(profile: SshProfile): Promise<IpcOutcome<{ banner: string }>>;
    disconnect(sessionId: string): Promise<void>;
    write(sessionId: string, data: string): void;
    resize(sessionId: string, size: TerminalSize): void;
    /** Native picker for a `.pem`/OpenSSH key; resolves the chosen path, or null if cancelled. */
    pickPrivateKey(): Promise<string | null>;
    /** Stores or clears (empty `secret`) a password or passphrase in the OS credential vault. */
    setCredential(input: SshCredentialInput): Promise<boolean>;
    hasCredential(credentialId: string): Promise<boolean>;
    deleteCredential(credentialId: string): Promise<void>;
    listKnownHosts(): Promise<KnownHostEntry[]>;
    forgetKnownHost(host: string, port: number): Promise<void>;
    /** Answers a pending host-key prompt raised by `connect` or `testConnection`. */
    resolveHostKey(promptId: string, decision: HostKeyDecision): void;
    onSessionEvent(listener: (sessionId: string, event: SshSessionEvent) => void): () => void;
    onHostKeyPrompt(listener: (promptId: string, prompt: HostKeyPrompt) => void): () => void;
}

/** Tunnel operations the preload exposes. */
export interface TunnelBridge {
    /** Both profiles arrive with `{{variables}}` already resolved. */
    start(profile: TunnelProfile, sshProfile: SshProfile): Promise<IpcOutcome<TunnelRuntimeState>>;
    stop(tunnelId: string): Promise<void>;
    list(): Promise<TunnelRuntimeState[]>;
    /** False when something is already listening on the address and port. */
    isPortAvailable(address: string, port: number): Promise<boolean>;
    onStateChange(listener: (state: TunnelRuntimeState) => void): () => void;
}

export const sshError = (code: SshErrorCode, message: string, detail?: string): SshErrorInfo =>
    detail ? { code, message, detail } : { code, message };

/** User-facing text for every error code, used when a runtime has nothing more specific. */
export const SSH_ERROR_MESSAGES: Record<SshErrorCode, string> = {
    SSH_AUTH_FAILED: 'SSH authentication failed. Check the username and credentials.',
    SSH_KEY_UNREADABLE:
        'Unable to read private key. Check that the file exists and is a valid key.',
    SSH_KEY_PASSPHRASE_INVALID: 'Private-key passphrase is incorrect.',
    SSH_TIMEOUT: 'Connection timed out.',
    SSH_HOST_UNREACHABLE: 'Host could not be resolved, or refused the connection.',
    SSH_HOST_KEY_REJECTED: 'The host key was not trusted, so the connection was closed.',
    SSH_HOST_KEY_CHANGED: 'SSH host fingerprint changed.',
    SSH_CONNECTION_LOST: 'The SSH connection was lost.',
    SSH_PROFILE_INVALID: 'The connection profile is incomplete.',
    TUNNEL_PORT_IN_USE: 'The local port is already in use.',
    TUNNEL_BIND_FAILED: 'The tunnel could not bind to the local address.',
    TUNNEL_FORWARD_REFUSED: 'The SSH server refused to open the forwarded connection.',
    TUNNEL_NOT_SUPPORTED: 'This forwarding mode is not supported yet.',
    SSH_UNAVAILABLE: 'SSH is only available in the HttpReq desktop app.',
    SSH_UNKNOWN: 'The SSH operation failed.',
};

export const sshErrorOf = (code: SshErrorCode, detail?: string): SshErrorInfo =>
    sshError(code, SSH_ERROR_MESSAGES[code], detail);
