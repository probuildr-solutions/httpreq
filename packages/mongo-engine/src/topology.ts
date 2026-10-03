/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { promises as dns } from 'node:dns';
import { DbError, type ConnectionConfig } from '@httpreq/db-core';
import { MongoConnection, type MongoConnectOptions } from '@httpreq/db-protocol-mongo';

/**
 * Finding the servers a MongoDB connection string names, and the one to talk to.
 *
 * `mongodb+srv://` is resolved the way the MongoDB driver specification says (the "Initial DNS
 * Seedlist Discovery" rules): the SRV records of `_mongodb._tcp.<host>` are the seed list, every
 * target must sit under the host's parent domain, and at most one TXT record may add `authSource`,
 * `replicaSet` and `loadBalanced`. The string is never rewritten into a plain `mongodb://` one.
 */

export interface MongoTarget {
    host: string;
    port: number;
}

/** The part of Node's resolver used here, injectable so lookups can be tested without a network. */
export interface DnsResolver {
    resolveSrv(name: string): Promise<{ name: string; port: number }[]>;
    resolveTxt(name: string): Promise<string[][]>;
}

export const systemDns: DnsResolver = {
    resolveSrv: (name) => dns.resolveSrv(name),
    resolveTxt: (name) => dns.resolveTxt(name),
};

export interface MongoTopology {
    seeds: MongoTarget[];
    /** The connection's options with the TXT record's added (the string's own take precedence). */
    options: Record<string, string>;
    srv: boolean;
}

/** TXT options a deployment may publish; anything else is refused, as the specification requires. */
const TXT_OPTIONS = new Set(['authsource', 'replicaset', 'loadbalanced']);

const dnsCode = (error: unknown) => (error as NodeJS.ErrnoException | null)?.code;

const dnsFailure = (what: string, host: string, error: unknown): DbError => {
    const code = dnsCode(error);
    const reason =
        code === 'ENOTFOUND' || code === 'ENODATA'
            ? `there are no ${what} records for “${host}”`
            : code === 'ETIMEOUT' || code === 'ETIMEDOUT'
              ? 'the DNS server did not answer in time'
              : code === 'ECONNREFUSED'
                ? 'the DNS server refused the request'
                : `DNS error ${code ?? 'unknown'}`;
    return new DbError(
        'CONNECTION_FAILED',
        `MongoDB SRV lookup failed: ${reason}. Check the cluster host name and your network or DNS settings.`,
        { cause: error },
    );
};

const parseHostPort = (entry: string): MongoTarget | null => {
    const text = entry.trim();
    if (!text) return null;
    if (text.startsWith('[')) {
        const end = text.indexOf(']');
        if (end < 0) return null;
        const port = text.slice(end + 2);
        return { host: text.slice(1, end), port: port ? Number(port) : 27017 };
    }
    const colon = text.lastIndexOf(':');
    if (colon < 0) return { host: text, port: 27017 };
    return { host: text.slice(0, colon), port: Number(text.slice(colon + 1)) };
};

/** The parent domain every SRV target must share: the host without its first label. */
const parentDomain = (host: string): string => host.slice(host.indexOf('.') + 1).toLowerCase();

export const resolveTopology = async (
    config: ConnectionConfig,
    resolver: DnsResolver = systemDns,
): Promise<MongoTopology> => {
    const options = { ...config.options };
    if (options.srv !== 'true') {
        const seeds: MongoTarget[] = [{ host: config.host, port: config.port }];
        for (const entry of (options.seeds ?? '').split(',')) {
            const target = parseHostPort(entry);
            if (target) seeds.push(target);
        }
        return { seeds, options, srv: false };
    }

    const host = config.host.toLowerCase().replace(/\.$/, '');
    if (!host.includes('.'))
        throw new DbError(
            'INVALID_REQUEST',
            'A mongodb+srv host must be a fully qualified domain name.',
        );
    let records: { name: string; port: number }[];
    try {
        records = await resolver.resolveSrv(`_mongodb._tcp.${host}`);
    } catch (error) {
        throw dnsFailure('SRV', host, error);
    }
    if (records.length === 0)
        throw new DbError(
            'CONNECTION_FAILED',
            `MongoDB SRV lookup failed: the SRV record for “${host}” lists no servers.`,
        );
    const parent = parentDomain(host);
    const seeds: MongoTarget[] = [];
    for (const record of records) {
        const target = record.name.toLowerCase().replace(/\.$/, '');
        if (target !== parent && !target.endsWith(`.${parent}`)) {
            throw new DbError(
                'CONNECTION_FAILED',
                `MongoDB SRV lookup returned a server (“${target}”) outside “${parent}”. It was refused, because a DNS answer must not send the connection to another domain.`,
            );
        }
        seeds.push({ host: target, port: record.port });
    }

    let txt: string[][] = [];
    try {
        txt = await resolver.resolveTxt(host);
    } catch (error) {
        const code = dnsCode(error);
        // A cluster without TXT records is fine; a failing DNS server is not.
        if (code !== 'ENOTFOUND' && code !== 'ENODATA') throw dnsFailure('TXT', host, error);
    }
    if (txt.length > 1)
        throw new DbError(
            'CONNECTION_FAILED',
            `MongoDB SRV lookup found more than one TXT record for “${host}”, which is not allowed.`,
        );
    if (txt.length === 1) {
        const text = txt[0]!.join('');
        for (const part of text.split('&')) {
            if (!part) continue;
            const eq = part.indexOf('=');
            const key = eq < 0 ? part : part.slice(0, eq);
            const value = eq < 0 ? '' : decodeURIComponent(part.slice(eq + 1));
            if (!TXT_OPTIONS.has(key.toLowerCase()))
                throw new DbError(
                    'CONNECTION_FAILED',
                    `The TXT record for “${host}” sets “${key}”, which a DNS record may not set.`,
                );
            const canonical =
                key.toLowerCase() === 'authsource'
                    ? 'authSource'
                    : key.toLowerCase() === 'replicaset'
                      ? 'replicaSet'
                      : 'loadBalanced';
            // Options written in the connection string win over the ones DNS supplies.
            options[canonical] ??= value;
        }
    }
    return { seeds, options, srv: true };
};

const hostKey = (target: MongoTarget) => `${target.host.toLowerCase()}:${target.port}`;

/**
 * Connects to a member of the topology. Seeds are tried in order. With the default read
 * preference (primary) a member that is not the primary is only used to learn where the primary
 * is, and the connection moves there; with any other preference the first reachable member is used.
 */
export const connectToTopology = async (
    topology: MongoTopology,
    base: Omit<MongoConnectOptions, 'host' | 'port'>,
    signal?: AbortSignal,
    connect: (options: MongoConnectOptions, signal?: AbortSignal) => Promise<MongoConnection> = (
        o,
        s,
    ) => MongoConnection.connect(o, s),
): Promise<{ connection: MongoConnection; target: MongoTarget }> => {
    const wantsPrimary = !base.readPreference || base.readPreference === 'primary';
    const direct = topology.options.directConnection === 'true';
    const expectedSet = topology.options.replicaSet;
    const tried = new Set<string>();
    const queue = [...topology.seeds];
    let lastError: unknown;

    while (queue.length > 0) {
        const target = queue.shift()!;
        if (tried.has(hostKey(target))) continue;
        tried.add(hostKey(target));
        let connection: MongoConnection;
        try {
            connection = await connect({ ...base, ...target }, signal);
        } catch (error) {
            // A wrong password will be wrong on every member; do not hide it behind the others.
            if (
                error instanceof DbError &&
                (error.code === 'AUTH_FAILED' || error.code === 'CANCELLED')
            )
                throw error;
            lastError = error;
            continue;
        }
        const hello = connection.hello;
        if (expectedSet && hello.setName && hello.setName !== expectedSet) {
            await connection.close().catch(() => undefined);
            lastError = new DbError(
                'CONNECTION_FAILED',
                `${target.host} belongs to the replica set “${hello.setName}”, not “${expectedSet}”.`,
            );
            continue;
        }
        if (!direct && wantsPrimary && !hello.writable && hello.process !== 'mongos') {
            const primary = hello.primary ? parseHostPort(hello.primary) : null;
            await connection.close().catch(() => undefined);
            if (primary && !tried.has(hostKey(primary))) queue.unshift(primary);
            else if (!primary)
                lastError = new DbError(
                    'CONNECTION_FAILED',
                    `${target.host} is not the primary and no primary is currently elected.`,
                );
            continue;
        }
        return { connection, target };
    }
    if (lastError instanceof DbError) throw lastError;
    throw new DbError('CONNECTION_FAILED', 'No MongoDB server could be reached.', {
        cause: lastError,
    });
};
