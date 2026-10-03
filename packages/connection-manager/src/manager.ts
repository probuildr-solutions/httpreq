/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import {
    DbError,
    toDbError,
    type ConnectionConfig,
    type DatabaseProvider,
    type DbErrorInfo,
    type PermissionSet,
    type ServerInfo,
    type Session,
    type TestResult,
} from '@httpreq/db-core';

/** Engines the host can talk to, registered by id. Adding one is one `register` call. */
export class ProviderRegistry {
    private readonly providers = new Map<string, DatabaseProvider>();

    register(provider: DatabaseProvider): this {
        if (this.providers.has(provider.id)) {
            throw new DbError('INTERNAL', `The engine “${provider.id}” is already registered.`);
        }
        this.providers.set(provider.id, provider);
        return this;
    }

    get(id: string): DatabaseProvider {
        const provider = this.providers.get(id);
        if (!provider) throw new DbError('UNSUPPORTED', `There is no driver for “${id}”.`);
        return provider;
    }

    list(): DatabaseProvider[] {
        return [...this.providers.values()];
    }
}

export type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'failed';

export interface ConnectionStatus {
    id: string;
    state: ConnectionState;
    server?: ServerInfo;
    permissions?: PermissionSet;
    error?: DbErrorInfo;
    /** How many times the connection was re-established after dropping. */
    reconnects: number;
}

interface Entry {
    config: ConnectionConfig;
    session: Session | null;
    status: ConnectionStatus;
    /** A reconnect already under way, so concurrent callers share it. */
    reconnecting: Promise<Session> | null;
    timer?: ReturnType<typeof setInterval>;
    closing: boolean;
}

export interface ConnectionManagerOptions {
    /** How often an idle connection is pinged; 0 turns it off. */
    keepAliveMs?: number;
    /** Attempts made to re-establish a dropped connection before giving up. */
    reconnectAttempts?: number;
    /** First wait between attempts; it doubles each time. */
    reconnectDelayMs?: number;
}

/**
 * The connections a window has open, any number at once.
 *
 * It knows engines only through `DatabaseProvider`. A connection that drops (the server
 * restarted, an idle timeout, a network change) is noticed by a periodic ping or by the next
 * statement, and is re-established on demand with back-off, using the settings it was opened with
 * (kept in this process's memory only). Anything running on the old connection has failed, and
 * says so; nothing is silently re-sent, because a statement that may have half-run is not safe to
 * repeat.
 */
export class ConnectionManager {
    private readonly entries = new Map<string, Entry>();
    private readonly listeners = new Set<(status: ConnectionStatus) => void>();

    constructor(
        private readonly registry: ProviderRegistry,
        private readonly options: ConnectionManagerOptions = {},
    ) {}

    onStatus(listener: (status: ConnectionStatus) => void): () => void {
        this.listeners.add(listener);
        return () => void this.listeners.delete(listener);
    }

    /** Connects, checks what the account may do, and disconnects: for a "Test connection" button. */
    async test(config: ConnectionConfig, signal?: AbortSignal): Promise<TestResult> {
        const started = Date.now();
        const provider = this.registry.get(config.engine);
        const session = await provider.createConnector(config).connect(signal);
        try {
            const permissions = await session.getPermissions().catch(() => undefined);
            return {
                ok: true,
                server: session.info,
                elapsedMs: Date.now() - started,
                ...(permissions ? { permissions } : {}),
            };
        } finally {
            await session.close().catch(() => undefined);
        }
    }

    /** Opens a connection under `id`, replacing one that was already open there. */
    async open(
        id: string,
        config: ConnectionConfig,
        signal?: AbortSignal,
    ): Promise<ConnectionStatus> {
        await this.close(id);
        const entry: Entry = {
            config,
            session: null,
            reconnecting: null,
            closing: false,
            status: { id, state: 'connecting', reconnects: 0 },
        };
        this.entries.set(id, entry);
        this.publish(entry);
        try {
            const session = await this.connect(entry, signal);
            await this.attach(entry, session);
        } catch (error) {
            entry.status = { ...entry.status, state: 'failed', error: toDbError(error).toInfo() };
            this.publish(entry);
            throw error;
        }
        return entry.status;
    }

    /** The live session for a connection, re-establishing it first if it dropped. */
    async acquire(id: string): Promise<Session> {
        const entry = this.entries.get(id);
        if (!entry) throw new DbError('NOT_FOUND', 'That connection is not open.');
        if (entry.session?.alive) return entry.session;
        return this.reconnect(entry);
    }

    /**
     * A new session on the settings a connection was opened with, for work that must not share the
     * connection's one session (a long export or import, which would otherwise make every query tab
     * on that connection wait). The caller closes it; the manager does not track it.
     */
    async openDedicated(id: string, signal?: AbortSignal): Promise<Session> {
        const entry = this.entries.get(id);
        if (!entry) throw new DbError('NOT_FOUND', 'That connection is not open.');
        return this.connect(entry, signal);
    }

    /** The engine a connection was opened for. */
    engineOf(id: string): string | undefined {
        return this.entries.get(id)?.config.engine;
    }

    status(id: string): ConnectionStatus | undefined {
        return this.entries.get(id)?.status;
    }

    list(): ConnectionStatus[] {
        return [...this.entries.values()].map((entry) => entry.status);
    }

    async close(id: string): Promise<void> {
        const entry = this.entries.get(id);
        if (!entry) return;
        entry.closing = true;
        clearInterval(entry.timer);
        this.entries.delete(id);
        await entry.session?.close().catch(() => undefined);
        entry.status = { ...entry.status, state: 'disconnected' };
        this.publish(entry);
    }

    async closeAll(): Promise<void> {
        await Promise.all([...this.entries.keys()].map((id) => this.close(id)));
    }

    /* ---------- Internals ---------- */

    private connect(entry: Entry, signal?: AbortSignal): Promise<Session> {
        return this.registry.get(entry.config.engine).createConnector(entry.config).connect(signal);
    }

    private async attach(entry: Entry, session: Session): Promise<void> {
        entry.session = session;
        entry.status = {
            ...entry.status,
            state: 'connected',
            server: session.info,
            error: undefined,
        };
        entry.status.permissions = await session.getPermissions().catch(() => undefined);
        this.publish(entry);
        const every = this.options.keepAliveMs ?? 60_000;
        clearInterval(entry.timer);
        if (every > 0) {
            entry.timer = setInterval(() => void this.check(entry), every);
            entry.timer.unref?.();
        }
    }

    /** Pings an idle connection; one that does not answer is marked dropped. */
    private async check(entry: Entry): Promise<void> {
        if (entry.closing || !entry.session) return;
        try {
            if (!entry.session.alive)
                throw new DbError('CONNECTION_FAILED', 'The connection dropped.');
            await entry.session.ping();
        } catch (error) {
            if (entry.closing) return;
            entry.status = {
                ...entry.status,
                state: 'disconnected',
                error: toDbError(error).toInfo(),
            };
            this.publish(entry);
        }
    }

    private reconnect(entry: Entry): Promise<Session> {
        entry.reconnecting ??= (async () => {
            const attempts = this.options.reconnectAttempts ?? 3;
            let delay = this.options.reconnectDelayMs ?? 250;
            let last: unknown;
            entry.status = { ...entry.status, state: 'connecting' };
            this.publish(entry);
            for (let attempt = 0; attempt < attempts; attempt++) {
                if (entry.closing) throw new DbError('CANCELLED', 'The connection was closed.');
                try {
                    const session = await this.connect(entry);
                    entry.status = { ...entry.status, reconnects: entry.status.reconnects + 1 };
                    await this.attach(entry, session);
                    return session;
                } catch (error) {
                    last = error;
                    // A wrong password will not get better by trying again.
                    if (toDbError(error).code === 'AUTH_FAILED') break;
                    await new Promise((resolve) => setTimeout(resolve, delay));
                    delay *= 2;
                }
            }
            entry.status = { ...entry.status, state: 'failed', error: toDbError(last).toInfo() };
            this.publish(entry);
            throw toDbError(last);
        })().finally(() => {
            entry.reconnecting = null;
        });
        return entry.reconnecting;
    }

    private publish(entry: Entry): void {
        for (const listener of this.listeners) listener(entry.status);
    }
}
