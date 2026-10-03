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
import { MysqlSession } from './session';

class MysqlConnector implements Connector {
    constructor(private readonly config: ConnectionConfig) {}

    async connect(signal?: AbortSignal): Promise<Session> {
        const { config } = this;
        if (!config.username) throw new DbError('INVALID_REQUEST', 'A user name is required.');
        return MysqlSession.open(
            {
                host: config.host,
                port: config.port,
                user: config.username,
                password: config.password ?? '',
                database: config.database,
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
    'events',
    'sessions',
    'serverStatus',
    'indexes',
]);

/** MySQL and MariaDB, through the in-house wire protocol driver. */
export const mysqlProvider: DatabaseProvider = {
    id: 'mysql',
    displayName: 'MySQL / MariaDB',
    defaultPort: 3306,
    capabilities: CAPABILITIES,
    createConnector: (config) => new MysqlConnector(config),
};
