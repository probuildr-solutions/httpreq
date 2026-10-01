/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { StringDecoder } from 'node:string_decoder';
import type { Client, ClientChannel } from 'ssh2';
import {
    sshErrorOf,
    type SshConnectOptions,
    type SshProfile,
    type SshSessionEvent,
    type TerminalSize,
} from '@httpreq/shared';
import {
    openConnection,
    toSshError,
    type ConnectionDeps,
    type HostKeyApprover,
} from './connection';

/**
 * Interactive SSH shells.
 *
 * Sessions are keyed by the window that created them as well as by their own id, so one renderer
 * can never read from or write to another's shell. Every exit path — the user disconnecting, the
 * window closing, the app quitting — runs {@link Session.dispose}, so no orphan channel or socket
 * is left behind.
 *
 * A handshake takes seconds, and the user can disconnect or close the tab during it. Each attempt
 * therefore carries a generation: one that is no longer current when the connection finally opens
 * is torn down on the spot rather than registered as a session nothing in the UI knows about.
 *
 * Two details are what make a remote shell render correctly rather than approximately:
 *
 * - Output is decoded with a {@link StringDecoder} per stream. An SSH channel splits at whatever
 *   byte boundary the network gave it, so a multi-byte character — a box-drawing glyph
 *   from htop, an accented character in a login banner, anything outside ASCII — routinely
 *   straddles two chunks. Decoding each chunk on its own turns the halves into replacement
 *   characters, which is why a remote host garbles where a fast local one happens never to.
 * - The terminal size is remembered per session and applied when the shell is opened. The window
 *   is laid out in the renderer while the handshake is still running, so its resize arrives
 *   before there is a channel to resize; dropping it left the remote pty at its default 80x24
 *   while xterm drew a wider grid, and the shell then wrapped and redrew against the wrong width.
 */

const sessionKey = (senderId: number, sessionId: string) => `${senderId}:${sessionId}`;

interface Session {
    client: Client;
    channel: ClientChannel | null;
    dispose: () => void;
}

/** A pty has to have at least one cell; a zero-sized terminal is a measurement, not a size. */
const MIN_COLS = 1;
const MIN_ROWS = 1;

const sameSize = (a: TerminalSize, b: TerminalSize) =>
    a.cols === b.cols && a.rows === b.rows && a.width === b.width && a.height === b.height;

export type SessionEmitter = (senderId: number, sessionId: string, event: SshSessionEvent) => void;

export class SshSessionManager {
    private readonly sessions = new Map<string, Session>();
    /** Current connect attempt per session key; anything older has been abandoned. */
    private readonly generations = new Map<string, number>();
    /**
     * The size each session's terminal last reported. Kept whether or not a channel exists yet, so
     * a resize that arrives mid-handshake still reaches the pty — as the size it opens at.
     */
    private readonly sizes = new Map<string, TerminalSize>();

    constructor(
        private readonly deps: ConnectionDeps,
        private readonly emit: SessionEmitter,
    ) {}

    list(senderId: number): string[] {
        const prefix = `${senderId}:`;
        return [...this.sessions.keys()]
            .filter((key) => key.startsWith(prefix))
            .map((key) => key.slice(prefix.length));
    }

    get size(): number {
        return this.sessions.size;
    }

    has(senderId: number, sessionId: string): boolean {
        return this.sessions.has(sessionKey(senderId, sessionId));
    }

    /** Retires whatever is running or connecting under this key and returns the new attempt's id. */
    private nextGeneration(key: string): number {
        const generation = (this.generations.get(key) ?? 0) + 1;
        this.generations.set(key, generation);
        return generation;
    }

    /** Opens a connection and an interactive shell. Reports progress through session events. */
    async connect(
        senderId: number,
        options: SshConnectOptions,
        approveHostKey: HostKeyApprover,
    ): Promise<void> {
        const { sessionId, profile, size } = options;
        const key = sessionKey(senderId, sessionId);
        if (this.sessions.has(key)) await this.disconnect(senderId, sessionId);
        // The size the caller opened with is the starting point; a resize during the handshake
        // replaces it, and whichever is newest is what the shell is actually opened at.
        this.sizes.set(key, size);
        const generation = this.nextGeneration(key);
        const isCurrent = () => this.generations.get(key) === generation;

        const send = (event: SshSessionEvent) => this.emit(senderId, sessionId, event);
        send({ type: 'status', status: 'connecting' });

        let client: Client;
        try {
            ({ client } = await openConnection(profile, this.deps, approveHostKey));
        } catch (error) {
            const info = toSshError(error);
            if (isCurrent()) {
                send({ type: 'error', error: info });
                send({ type: 'status', status: 'disconnected' });
            }
            throw info;
        }

        // Disconnected, or the window closed, while the handshake was still running.
        if (!isCurrent()) {
            client.removeAllListeners();
            client.end();
            client.destroy();
            return;
        }

        // The session is registered before the shell opens, so a disconnect during `shell()` still
        // finds something to tear down.
        const session: Session = {
            client,
            channel: null,
            dispose: () => {
                const channel = session.channel;
                if (channel) {
                    // `stderr` is a separate stream with its own listeners, and is missed by a
                    // `removeAllListeners` on the channel alone.
                    channel.stderr.removeAllListeners();
                    channel.removeAllListeners();
                    channel.end();
                    channel.destroy();
                }
                client.removeAllListeners();
                client.end();
                client.destroy();
            },
        };
        this.sessions.set(key, session);

        const teardown = (event: SshSessionEvent) => {
            if (this.sessions.get(key) !== session) return;
            this.sessions.delete(key);
            session.dispose();
            send(event);
            send({ type: 'status', status: 'disconnected' });
        };

        client.on('error', (error: Error) => teardown({ type: 'error', error: toSshError(error) }));
        client.on('close', () => teardown({ type: 'closed', code: null, signal: null }));

        try {
            // Whatever the terminal reported most recently, which may be newer than `options.size`.
            const opening = this.sizes.get(key) ?? size;
            const channel = await new Promise<ClientChannel>((resolve, reject) => {
                // A pty-backed interactive shell, not a raw command stream: the remote side needs the
                // pty to start a login shell with a prompt, job control and line editing, and it reads
                // its cursor, colour and clearing sequences from the terminal type given here.
                client.shell(
                    {
                        term: 'xterm-256color',
                        cols: opening.cols,
                        rows: opening.rows,
                        width: opening.width,
                        height: opening.height,
                    },
                    (error, stream) => (error ? reject(error) : resolve(stream)),
                );
            });
            session.channel = channel;
            // One decoder per stream: it holds back the tail of a split multi-byte character until the
            // rest of it arrives, instead of emitting a replacement character for each half.
            const stdout = new StringDecoder('utf8');
            const stderr = new StringDecoder('utf8');
            channel.on('data', (chunk: Buffer) =>
                send({ type: 'data', data: stdout.write(chunk) }),
            );
            channel.stderr.on('data', (chunk: Buffer) =>
                send({ type: 'data', data: stderr.write(chunk) }),
            );
            channel.on('close', (code: number | null, signal: string | null) => {
                // Anything the decoders still hold is an incomplete character; flushing it keeps the
                // last of the output rather than dropping it with the channel.
                const tail = stdout.end() + stderr.end();
                if (tail) send({ type: 'data', data: tail });
                teardown({ type: 'closed', code: code ?? null, signal: signal ?? null });
            });
            // The terminal may have been resized again while the shell was opening.
            const latest = this.sizes.get(key);
            if (latest && !sameSize(latest, opening)) {
                channel.setWindow(latest.rows, latest.cols, latest.height, latest.width);
            }
            send({ type: 'status', status: 'connected' });
        } catch (error) {
            const info = toSshError(error);
            if (this.sessions.get(key) === session) this.sessions.delete(key);
            session.dispose();
            if (isCurrent()) {
                send({ type: 'error', error: info });
                send({ type: 'status', status: 'disconnected' });
            }
            throw info;
        }
    }

    /** Opens a connection, confirms the handshake, and closes it again. */
    async test(profile: SshProfile, approveHostKey: HostKeyApprover): Promise<{ banner: string }> {
        const { client, banner } = await openConnection(profile, this.deps, approveHostKey);
        client.removeAllListeners();
        client.end();
        client.destroy();
        return { banner };
    }

    write(senderId: number, sessionId: string, data: string): void {
        this.sessions.get(sessionKey(senderId, sessionId))?.channel?.write(data);
    }

    /**
     * Records the terminal's size and, when there is a shell to tell, forwards it as a pty window
     * change. The record is kept either way: a resize during the handshake is not lost, it becomes
     * the size the shell opens at.
     */
    resize(senderId: number, sessionId: string, size: TerminalSize): void {
        const key = sessionKey(senderId, sessionId);
        const next: TerminalSize = {
            cols: Math.max(MIN_COLS, size.cols),
            rows: Math.max(MIN_ROWS, size.rows),
            width: size.width,
            height: size.height,
        };
        const previous = this.sizes.get(key);
        this.sizes.set(key, next);
        const channel = this.sessions.get(key)?.channel;
        // An unchanged size is not forwarded: a window-change makes the remote shell redraw, and a
        // stream of identical ones during a drag is what makes a prompt repeat itself.
        if (!channel || (previous && sameSize(previous, next))) return;
        channel.setWindow(next.rows, next.cols, next.height, next.width);
    }

    async disconnect(senderId: number, sessionId: string): Promise<void> {
        const key = sessionKey(senderId, sessionId);
        const session = this.sessions.get(key);
        // Retired even when nothing is registered yet, so a handshake still in flight is abandoned
        // rather than becoming a session the user believes they have already closed.
        this.nextGeneration(key);
        this.sizes.delete(key);
        if (!session) return;
        this.sessions.delete(key);
        this.emit(senderId, sessionId, { type: 'status', status: 'disconnecting' });
        session.dispose();
        this.emit(senderId, sessionId, { type: 'status', status: 'disconnected' });
    }

    /** Closes every session owned by one window; used when it navigates away or is destroyed. */
    disposeForSender(senderId: number): void {
        const prefix = `${senderId}:`;
        for (const sessionId of this.list(senderId)) {
            const key = sessionKey(senderId, sessionId);
            const session = this.sessions.get(key);
            this.sessions.delete(key);
            session?.dispose();
        }
        // Invalidates any handshake still running for this window, and drops its counters with it.
        for (const key of [...this.generations.keys()]) {
            if (key.startsWith(prefix)) {
                this.nextGeneration(key);
                this.generations.delete(key);
            }
        }
        for (const key of [...this.sizes.keys()]) {
            if (key.startsWith(prefix)) this.sizes.delete(key);
        }
    }

    disposeAll(): void {
        for (const key of [...this.generations.keys()]) this.nextGeneration(key);
        this.generations.clear();
        for (const session of this.sessions.values()) session.dispose();
        this.sessions.clear();
        this.sizes.clear();
    }
}

export { sshErrorOf };
