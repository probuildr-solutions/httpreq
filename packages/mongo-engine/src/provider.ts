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
import { MongoSession } from './session';

class MongoConnector implements Connector {
    constructor(private readonly config: ConnectionConfig) {}

    async connect(signal?: AbortSignal): Promise<Session> {
        const { config } = this;
        // As in a connection string, the user is looked up in the database named in the connection
        // unless `authSource` says otherwise, and in `admin` when there is none.
        const authSource = config.options.authSource || config.database || 'admin';
        try {
            return await MongoSession.open(
                {
                    host: config.host,
                    port: config.port,
                    username: config.username,
                    password: config.password,
                    authSource,
                    authMechanism: config.options.authMechanism,
                    appName: config.options.appName,
                    tls: config.tls,
                    connectTimeoutMs: config.connectTimeoutMs,
                },
                config,
                signal,
            );
        } catch (error) {
            if (
                error instanceof DbError &&
                error.code === 'AUTH_FAILED' &&
                !config.options.authSource
            ) {
                throw new DbError(
                    'AUTH_FAILED',
                    `${error.message} The login was checked against the “${authSource}” database; if the user is defined elsewhere (usually admin), set Auth source in the connection’s options.`,
                    { cause: error },
                );
            }
            throw error;
        }
    }
}

const CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>([
    'documents',
    'explain',
    'transactions',
    'sessions',
    'serverStatus',
    'indexes',
    'aggregation',
    'schemaInference',
]);

/** MongoDB (and compatible servers), through the in-house wire protocol driver. */
export const mongoProvider: DatabaseProvider = {
    id: 'mongodb',
    displayName: 'MongoDB',
    defaultPort: 27017,
    capabilities: CAPABILITIES,
    createConnector: (config) => new MongoConnector(config),
};
