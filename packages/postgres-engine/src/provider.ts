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
import { PostgresSession } from './session';

class PostgresConnector implements Connector {
    constructor(private readonly config: ConnectionConfig) {}

    async connect(signal?: AbortSignal): Promise<Session> {
        const { config } = this;
        if (!config.username) throw new DbError('INVALID_REQUEST', 'A user name is required.');
        return PostgresSession.open(
            {
                host: config.host,
                port: config.port,
                user: config.username,
                password: config.password,
                database: config.database,
                applicationName: config.options.application_name,
                tls: config.tls,
                connectTimeoutMs: config.connectTimeoutMs,
            },
            config,
            signal,
        );
    }
}

const CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>([
    'sql',
    'explain',
    'transactions',
    'routines',
    'triggers',
    'sequences',
    'extensions',
    'materializedViews',
    'sessions',
    'serverStatus',
    'indexes',
]);

/** PostgreSQL and its wire-compatible servers, through the in-house protocol driver. */
export const postgresProvider: DatabaseProvider = {
    id: 'postgresql',
    displayName: 'PostgreSQL',
    defaultPort: 5432,
    capabilities: CAPABILITIES,
    createConnector: (config) => new PostgresConnector(config),
};
