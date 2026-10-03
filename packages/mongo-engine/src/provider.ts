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
import type { MongoConnectOptions } from '@httpreq/db-protocol-mongo';
import { MongoSession } from './session';
import { connectToTopology, resolveTopology, type DnsResolver } from './topology';

const writeConcernOf = (
    options: Record<string, string>,
): MongoConnectOptions['writeConcern'] | undefined => {
    const concern: NonNullable<MongoConnectOptions['writeConcern']> = {};
    if (options.w !== undefined && options.w !== '')
        concern.w = /^\d+$/.test(options.w) ? Number(options.w) : options.w;
    if (options.wtimeoutMS && /^\d+$/.test(options.wtimeoutMS))
        concern.wtimeoutMS = Number(options.wtimeoutMS);
    if (options.journal) concern.journal = options.journal === 'true';
    return Object.keys(concern).length > 0 ? concern : undefined;
};

class MongoConnector implements Connector {
    constructor(
        private readonly config: ConnectionConfig,
        private readonly resolver?: DnsResolver,
    ) {}

    async connect(signal?: AbortSignal): Promise<Session> {
        const { config } = this;
        // `mongodb+srv` and multi-host strings are resolved to a seed list here, by the driver.
        const topology = await resolveTopology(config, this.resolver);
        const explicitAuthSource = topology.options.authSource;
        // As in a connection string, the user is looked up in the database named in the connection
        // unless `authSource` says otherwise (in the string or a DNS TXT record), and in `admin`
        // when there is none.
        const authSource = explicitAuthSource || config.database || 'admin';
        const base = {
            username: config.username,
            password: config.password,
            authSource,
            authMechanism: topology.options.authMechanism,
            appName: topology.options.appName,
            tls: config.tls,
            connectTimeoutMs: config.connectTimeoutMs,
            readPreference: topology.options.readPreference,
            writeConcern: writeConcernOf(topology.options),
        };
        try {
            const { connection, target } = await connectToTopology(topology, base, signal);
            return await MongoSession.open(
                { ...base, host: target.host, port: target.port },
                config,
                signal,
                connection,
            );
        } catch (error) {
            if (error instanceof DbError && error.code === 'AUTH_FAILED' && !explicitAuthSource) {
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

/** A provider that resolves DNS through the given resolver, for tests. */
export const createMongoProvider = (resolver: DnsResolver): DatabaseProvider => ({
    ...mongoProvider,
    createConnector: (config) => new MongoConnector(config, resolver),
});
