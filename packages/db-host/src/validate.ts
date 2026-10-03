/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { DbError, type ConnectionConfig, type TlsConfig, type TlsMode } from '@httpreq/db-core';

/** Everything the host receives is data from another process: shapes are checked here, once. */

export const record = (value: unknown, what = 'The request'): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new DbError('INVALID_REQUEST', `${what} is malformed.`);
    }
    return value as Record<string, unknown>;
};

export const text = (value: unknown, name: string, max = 4096, optional = false): string => {
    if (value === undefined || value === null) {
        if (optional) return '';
        throw new DbError('INVALID_REQUEST', `${name} is required.`);
    }
    if (typeof value !== 'string' || value.length > max) {
        throw new DbError('INVALID_REQUEST', `${name} is invalid.`);
    }
    return value;
};

export const optionalText = (value: unknown, name: string, max = 4096): string | undefined =>
    value === undefined || value === null || value === '' ? undefined : text(value, name, max);

export const integer = (value: unknown, name: string, min: number, max: number): number => {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
        throw new DbError(
            'INVALID_REQUEST',
            `${name} must be a whole number from ${min} to ${max}.`,
        );
    }
    return value;
};

const TLS_MODES: readonly TlsMode[] = ['disable', 'prefer', 'require', 'verify-ca', 'verify-full'];

const parseTls = (value: unknown): TlsConfig => {
    if (value === undefined || value === null) return { mode: 'prefer' };
    const tls = record(value, 'The TLS settings');
    if (!TLS_MODES.includes(tls.mode as TlsMode)) {
        throw new DbError('INVALID_REQUEST', 'The TLS mode is not recognised.');
    }
    const pem = (name: string) => optionalText(tls[name], `The TLS ${name}`, 256 * 1024);
    return {
        mode: tls.mode as TlsMode,
        ca: pem('ca'),
        cert: pem('cert'),
        key: pem('key'),
        serverName: optionalText(tls.serverName, 'The TLS server name', 255),
    };
};

/**
 * Checks a connection configuration. The password comes only from the main process (the
 * renderer's copy of a profile has none), and is accepted here for the one connection it is for.
 */
export const parseConnectionConfig = (value: unknown): ConnectionConfig => {
    const config = record(value, 'The connection');
    const options: Record<string, string> = {};
    if (config.options !== undefined) {
        const raw = record(config.options, 'The connection options');
        const entries = Object.entries(raw);
        if (entries.length > 32)
            throw new DbError('INVALID_REQUEST', 'There are too many connection options.');
        for (const [key, item] of entries) {
            if (key.length > 64 || typeof item !== 'string' || item.length > 1024) {
                throw new DbError('INVALID_REQUEST', 'A connection option is invalid.');
            }
            options[key] = item;
        }
    }
    return {
        engine: text(config.engine, 'The engine', 32),
        host: text(config.host, 'The host', 255),
        port: integer(config.port, 'The port', 1, 65535),
        database: optionalText(config.database, 'The database', 256),
        username: optionalText(config.username, 'The user name', 256),
        password: optionalText(config.password, 'The password', 1024),
        tls: parseTls(config.tls),
        connectTimeoutMs:
            config.connectTimeoutMs === undefined
                ? 10_000
                : integer(config.connectTimeoutMs, 'The connect timeout', 1_000, 120_000),
        queryTimeoutMs:
            config.queryTimeoutMs === undefined
                ? 0
                : integer(config.queryTimeoutMs, 'The query timeout', 0, 86_400_000),
        options,
    };
};
