/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import type {
    Capability,
    ConnectionConfig,
    Connector,
    DatabaseProvider,
    Session,
} from '@httpreq/db-core';
import { DbError } from '@httpreq/db-core';
import { RedisSession } from './session';

class RedisConnector implements Connector {
    constructor(private readonly config: ConnectionConfig) {}

    async connect(signal?: AbortSignal): Promise<Session> {
        const { config } = this;
        // The database is `db3`, `3` or empty.
        let database: number | undefined;
        if (config.database) {
            const match = /^(?:db)?(\d+)$/i.exec(config.database.trim());
            if (!match) {
                throw new DbError(
                    'INVALID_REQUEST',
                    'The database must be a number such as 0 or 3.',
                );
            }
            database = Number(match[1]);
        }
        return RedisSession.open(
            {
                host: config.host,
                port: config.port,
                username: config.username,
                password: config.password,
                database,
                tls: config.tls,
                connectTimeoutMs: config.connectTimeoutMs,
            },
            config,
            signal,
        );
    }
}

const CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>([
    'transactions',
    'sessions',
    'serverStatus',
]);

/** Redis and Valkey, through the in-house RESP driver. */
export const redisProvider: DatabaseProvider = {
    id: 'redis',
    displayName: 'Redis / Valkey',
    defaultPort: 6379,
    capabilities: CAPABILITIES,
    createConnector: (config) => new RedisConnector(config),
};
