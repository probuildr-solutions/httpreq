/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import {
    app,
    dialog,
    ipcMain,
    type IpcMainEvent,
    type IpcMainInvokeEvent,
    webContents,
} from 'electron';
import {
    createId,
    parseSshProfile,
    parseTunnelProfile,
    redact,
    sshError,
    sshErrorOf,
    type HostKeyDecision,
    type HostKeyPrompt,
    type IpcOutcome,
    type IpcResult,
    type SshSessionEvent,
    type TerminalSize,
    type TunnelRuntimeState,
    type WebSocketEvent,
} from '@httpreq/shared';
import { CredentialStore, credentialStorePath } from './ssh/credentials';
import { KnownHostsStore, knownHostsPath } from './ssh/knownHosts';
import { SshSessionManager } from './ssh/sessions';
import { isPortAvailable, TunnelManager } from './ssh/tunnels';
import { toSshError } from './ssh/connection';
import { parsePreparedWebSocket, WebSocketManager } from './websocket';

/**
 * The privileged half of the WebSocket, SSH and tunnel features.
 *
 * Everything the renderer can reach arrives here as an unvalidated IPC payload, so each handler
 * re-checks the sender, re-parses the payload with the shared validators, and only then touches a
 * socket, a key file or the credential vault. Nothing in this file ever returns a secret, and the
 * only logging goes through {@link logFailure}, which redacts before it writes.
 */

export interface ServiceDeps {
    /** Only the app's own top-level renderer may call these channels. */
    isTrustedSender: (event: IpcMainEvent | IpcMainInvokeEvent) => boolean;
}

/** Counts shown in the desktop status bar. */
export interface ServiceCounts {
    webSockets: number;
    sshSessions: number;
    tunnels: number;
}

const isTerminalSize = (value: unknown): value is TerminalSize =>
    !!value &&
    typeof value === 'object' &&
    ['cols', 'rows', 'width', 'height'].every((key) => {
        const item = (value as Record<string, unknown>)[key];
        return typeof item === 'number' && Number.isFinite(item) && item >= 0;
    });

const clampSize = (size: TerminalSize): TerminalSize => ({
    cols: Math.min(500, Math.max(1, Math.round(size.cols))),
    rows: Math.min(300, Math.max(1, Math.round(size.rows))),
    width: Math.min(10_000, Math.max(0, Math.round(size.width))),
    height: Math.min(10_000, Math.max(0, Math.round(size.height))),
});

/** The one place a failure is written to the console, always through the redactor. */
const logFailure = (scope: string, error: unknown) => {
    console.error(`[${scope}]`, redact(error));
};

const sendTo = (senderId: number, channel: string, ...args: unknown[]) => {
    const contents = webContents.fromId(senderId);
    if (contents && !contents.isDestroyed()) contents.send(channel, ...args);
};

export const registerServices = ({ isTrustedSender }: ServiceDeps) => {
    const userData = app.getPath('userData');
    const credentials = new CredentialStore(credentialStorePath(userData));
    const knownHosts = new KnownHostsStore(knownHostsPath(userData));

    /* ---------- Host-key prompts ---------- */

    const pendingPrompts = new Map<string, (decision: HostKeyDecision) => void>();

    /**
     * Asks the renderer that started the connection. A window that goes away without answering
     * resolves as a rejection, so a handshake can never hang on a prompt nobody can see.
     */
    const approveHostKeyFor = (senderId: number) => (prompt: HostKeyPrompt) =>
        new Promise<boolean>((resolve) => {
            const contents = webContents.fromId(senderId);
            if (!contents || contents.isDestroyed()) {
                resolve(false);
                return;
            }
            const promptId = createId();
            const settle = (decision: HostKeyDecision) => {
                if (!pendingPrompts.delete(promptId)) return;
                contents.off('destroyed', onGone);
                resolve(decision === 'trust');
            };
            const onGone = () => settle('reject');
            pendingPrompts.set(promptId, settle);
            contents.once('destroyed', onGone);
            contents.send('ssh:host-key-prompt', promptId, prompt);
        });

    ipcMain.on('ssh:host-key-decision', (event, promptId: unknown, decision: unknown) => {
        if (!isTrustedSender(event) || typeof promptId !== 'string') return;
        if (decision !== 'trust' && decision !== 'reject') return;
        pendingPrompts.get(promptId)?.(decision);
    });

    /* ---------- Managers ---------- */

    const sockets = new WebSocketManager((senderId, socketId, event: WebSocketEvent) =>
        sendTo(senderId, 'ws:event', socketId, event),
    );

    const sessions = new SshSessionManager(
        { credentials, knownHosts },
        (senderId, sessionId, event: SshSessionEvent) =>
            sendTo(senderId, 'ssh:event', sessionId, event),
    );

    const tunnels = new TunnelManager({ credentials, knownHosts }, (state: TunnelRuntimeState) => {
        for (const contents of webContents.getAllWebContents()) {
            if (!contents.isDestroyed()) contents.send('tunnel:state', state);
        }
    });

    const counts = (): ServiceCounts => ({
        webSockets: sockets.size,
        sshSessions: sessions.size,
        tunnels: tunnels.activeCount,
    });

    /* ---------- WebSocket ---------- */

    ipcMain.handle(
        'ws:open',
        async (event, socketId: unknown, prepared: unknown): Promise<IpcResult<void>> => {
            if (!isTrustedSender(event) || typeof socketId !== 'string' || !socketId) {
                return {
                    ok: false,
                    error: { code: 'INVALID_REQUEST', message: 'Invalid socket request.' },
                };
            }
            const parsed = parsePreparedWebSocket(prepared);
            if (!parsed) {
                return {
                    ok: false,
                    error: {
                        code: 'INVALID_REQUEST',
                        message: 'Enter a valid ws:// or wss:// URL.',
                    },
                };
            }
            try {
                sockets.open(event.sender.id, socketId, parsed);
                return { ok: true, value: undefined };
            } catch (error) {
                logFailure('ws:open', error);
                return {
                    ok: false,
                    error: { code: 'NETWORK_ERROR', message: 'The WebSocket could not be opened.' },
                };
            }
        },
    );

    ipcMain.on('ws:send-text', (event, socketId: unknown, data: unknown) => {
        if (!isTrustedSender(event) || typeof socketId !== 'string' || typeof data !== 'string')
            return;
        sockets.sendText(event.sender.id, socketId, data);
    });

    ipcMain.on('ws:send-binary', (event, socketId: unknown, data: unknown) => {
        if (!isTrustedSender(event) || typeof socketId !== 'string') return;
        if (!(data instanceof Uint8Array)) return;
        sockets.sendBinary(event.sender.id, socketId, data);
    });

    ipcMain.on('ws:close', (event, socketId: unknown, code: unknown, reason: unknown) => {
        if (!isTrustedSender(event) || typeof socketId !== 'string') return;
        sockets.close(
            event.sender.id,
            socketId,
            typeof code === 'number' ? code : undefined,
            typeof reason === 'string' ? reason : undefined,
        );
    });

    /* ---------- SSH sessions ---------- */

    ipcMain.handle('ssh:list', (event): string[] =>
        isTrustedSender(event) ? sessions.list(event.sender.id) : [],
    );

    ipcMain.handle('ssh:connect', async (event, options: unknown): Promise<IpcOutcome<void>> => {
        if (!isTrustedSender(event) || !options || typeof options !== 'object') {
            return { ok: false, error: sshErrorOf('SSH_PROFILE_INVALID') };
        }
        const raw = options as Record<string, unknown>;
        const profile = parseSshProfile(raw.profile);
        const sessionId = typeof raw.sessionId === 'string' ? raw.sessionId : '';
        if (!profile || !sessionId || !isTerminalSize(raw.size)) {
            return { ok: false, error: sshErrorOf('SSH_PROFILE_INVALID') };
        }
        try {
            await sessions.connect(
                event.sender.id,
                { sessionId, profile, size: clampSize(raw.size) },
                approveHostKeyFor(event.sender.id),
            );
            return { ok: true, value: undefined };
        } catch (error) {
            logFailure('ssh:connect', error);
            return { ok: false, error: toSshError(error) };
        }
    });

    ipcMain.handle(
        'ssh:test',
        async (event, value: unknown): Promise<IpcOutcome<{ banner: string }>> => {
            if (!isTrustedSender(event)) {
                return { ok: false, error: sshErrorOf('SSH_UNAVAILABLE') };
            }
            const profile = parseSshProfile(value);
            if (!profile) return { ok: false, error: sshErrorOf('SSH_PROFILE_INVALID') };
            try {
                const banner = await sessions.test(profile, approveHostKeyFor(event.sender.id));
                return { ok: true, value: banner };
            } catch (error) {
                logFailure('ssh:test', error);
                return { ok: false, error: toSshError(error) };
            }
        },
    );

    ipcMain.handle('ssh:disconnect', async (event, sessionId: unknown) => {
        if (!isTrustedSender(event) || typeof sessionId !== 'string') return;
        await sessions.disconnect(event.sender.id, sessionId);
    });

    ipcMain.on('ssh:write', (event, sessionId: unknown, data: unknown) => {
        if (!isTrustedSender(event) || typeof sessionId !== 'string' || typeof data !== 'string')
            return;
        sessions.write(event.sender.id, sessionId, data);
    });

    ipcMain.on('ssh:resize', (event, sessionId: unknown, size: unknown) => {
        if (!isTrustedSender(event) || typeof sessionId !== 'string' || !isTerminalSize(size))
            return;
        sessions.resize(event.sender.id, sessionId, clampSize(size));
    });

    /* ---------- Keys, credentials and known hosts ---------- */

    ipcMain.handle('ssh:pick-key', async (event): Promise<string | null> => {
        if (!isTrustedSender(event)) return null;
        const result = await dialog.showOpenDialog({
            title: 'Select a private key',
            properties: ['openFile', 'dontAddToRecent'],
            filters: [
                { name: 'Private keys', extensions: ['pem', 'key', 'ppk', 'id_rsa', 'id_ed25519'] },
                { name: 'All files', extensions: ['*'] },
            ],
        });
        // Only the path crosses back; the key itself is read in the main process at connect time.
        return result.canceled ? null : (result.filePaths[0] ?? null);
    });

    ipcMain.handle('ssh:set-credential', async (event, input: unknown): Promise<boolean> => {
        if (!isTrustedSender(event) || !input || typeof input !== 'object') return false;
        const { credentialId, secret } = input as Record<string, unknown>;
        if (typeof credentialId !== 'string' || typeof secret !== 'string') return false;
        try {
            return await credentials.set(credentialId, secret);
        } catch (error) {
            logFailure('ssh:set-credential', error);
            return false;
        }
    });

    ipcMain.handle('ssh:has-credential', async (event, credentialId: unknown): Promise<boolean> => {
        if (!isTrustedSender(event) || typeof credentialId !== 'string') return false;
        return credentials.has(credentialId);
    });

    ipcMain.handle('ssh:delete-credential', async (event, credentialId: unknown) => {
        if (!isTrustedSender(event) || typeof credentialId !== 'string') return;
        await credentials.delete(credentialId);
    });

    ipcMain.handle('ssh:known-hosts', async (event) =>
        isTrustedSender(event) ? knownHosts.list() : [],
    );

    ipcMain.handle('ssh:forget-host', async (event, host: unknown, port: unknown) => {
        if (!isTrustedSender(event) || typeof host !== 'string' || typeof port !== 'number') return;
        await knownHosts.forget(host, port);
    });

    /* ---------- Tunnels ---------- */

    ipcMain.handle(
        'tunnel:start',
        async (
            event,
            value: unknown,
            sshValue: unknown,
        ): Promise<IpcOutcome<TunnelRuntimeState>> => {
            if (!isTrustedSender(event)) return { ok: false, error: sshErrorOf('SSH_UNAVAILABLE') };
            const profile = parseTunnelProfile(value);
            const sshProfile = parseSshProfile(sshValue);
            if (!profile || !sshProfile || profile.sshProfileId !== sshProfile.id) {
                return {
                    ok: false,
                    error: sshError(
                        'SSH_PROFILE_INVALID',
                        'The tunnel configuration is incomplete. Check the SSH profile, ports and remote host.',
                    ),
                };
            }
            try {
                const state = await tunnels.start(
                    profile,
                    sshProfile,
                    approveHostKeyFor(event.sender.id),
                );
                return { ok: true, value: state };
            } catch (error) {
                logFailure('tunnel:start', error);
                return { ok: false, error: toSshError(error) };
            }
        },
    );

    ipcMain.handle('tunnel:stop', async (event, tunnelId: unknown) => {
        if (!isTrustedSender(event) || typeof tunnelId !== 'string') return;
        await tunnels.stop(tunnelId);
    });

    ipcMain.handle('tunnel:list', (event): TunnelRuntimeState[] =>
        isTrustedSender(event) ? tunnels.list() : [],
    );

    ipcMain.handle(
        'tunnel:port-available',
        async (event, address: unknown, port: unknown): Promise<boolean> => {
            if (
                !isTrustedSender(event) ||
                typeof address !== 'string' ||
                typeof port !== 'number'
            ) {
                return false;
            }
            return isPortAvailable(address, port);
        },
    );

    /* ---------- Lifecycle ---------- */

    /** Everything a window owns goes away with it, so no orphan socket or shell survives. */
    const releaseSender = (senderId: number) => {
        sockets.disposeForSender(senderId);
        sessions.disposeForSender(senderId);
    };

    const disposeAll = async () => {
        sockets.disposeAll();
        sessions.disposeAll();
        await tunnels.stopAll();
    };

    return { counts, releaseSender, disposeAll, credentials, knownHosts };
};
