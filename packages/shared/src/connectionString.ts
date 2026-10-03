/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import type { DbTlsMode } from './dbstudio';

/**
 * Connection strings for every engine Database Studio connects to, in both directions: a pasted
 * string becomes the fields of the connection form, and the form becomes a string again. Pure and
 * free of I/O, so the window, the tests and (later) the main process all use the same rules.
 *
 * Everything an engine's string can carry that the form has no field for is kept in `options`
 * under its original name, so a string survives the round trip, and nothing is silently dropped.
 * `mongodb+srv` is not expanded here: the host stays the cluster name and `options.srv` is set;
 * the driver resolves the SRV and TXT records when it connects.
 */

export type ConnectionStringEngine = 'mysql' | 'postgresql' | 'mongodb' | 'redis';

export interface ParsedConnection {
    engine: ConnectionStringEngine;
    host: string;
    port: number;
    database?: string;
    username?: string;
    password?: string;
    /** Absent when the string does not say; the form keeps its own choice then. */
    tls?: DbTlsMode;
    connectTimeoutMs?: number;
    /** Everything else the string carried, by its own name. */
    options: Record<string, string>;
}

export type ConnectionStringErrorCode =
    'EMPTY' | 'SCHEME' | 'ENGINE_MISMATCH' | 'HOST' | 'PORT' | 'ESCAPE' | 'SRV' | 'PARAMETER';

export interface ConnectionStringError {
    code: ConnectionStringErrorCode;
    message: string;
}

export type ParseResult =
    { ok: true; value: ParsedConnection } | { ok: false; error: ConnectionStringError };

const fail = (code: ConnectionStringErrorCode, message: string): ParseResult => ({
    ok: false,
    error: { code, message },
});

export const DEFAULT_PORTS: Record<ConnectionStringEngine, number> = {
    mysql: 3306,
    postgresql: 5432,
    mongodb: 27017,
    redis: 6379,
};

const SCHEMES: Record<string, ConnectionStringEngine> = {
    mysql: 'mysql',
    mariadb: 'mysql',
    postgres: 'postgresql',
    postgresql: 'postgresql',
    mongodb: 'mongodb',
    'mongodb+srv': 'mongodb',
    redis: 'redis',
    rediss: 'redis',
    valkey: 'redis',
    valkeys: 'redis',
};

/** The scheme to write for an engine. */
const SCHEME_OF: Record<ConnectionStringEngine, string> = {
    mysql: 'mysql',
    postgresql: 'postgresql',
    mongodb: 'mongodb',
    redis: 'redis',
};

const decode = (value: string, what: string): string | ConnectionStringError => {
    try {
        return decodeURIComponent(value);
    } catch {
        return {
            code: 'ESCAPE',
            message: `The ${what} contains a “%” that is not a valid escape. Write special characters as %XX (for example @ as %40).`,
        };
    }
};

const isError = (value: unknown): value is ConnectionStringError =>
    typeof value === 'object' && value !== null && 'code' in value;

/** Splits `?a=b&c=d` into decoded pairs; a repeated key keeps its last value, except lists. */
const queryOf = (query: string): [string, string][] | ConnectionStringError => {
    const pairs: [string, string][] = [];
    for (const part of query.split(/[&;]/)) {
        if (!part) continue;
        const eq = part.indexOf('=');
        const rawKey = eq < 0 ? part : part.slice(0, eq);
        const rawValue = eq < 0 ? '' : part.slice(eq + 1);
        const key = decode(rawKey.replace(/\+/g, ' '), 'parameter name');
        const value = decode(rawValue.replace(/\+/g, ' '), `value of “${rawKey}”`);
        if (isError(key)) return key;
        if (isError(value)) return value;
        pairs.push([key, value]);
    }
    return pairs;
};

const truthy = (value: string) => /^(true|1|yes|on|required|require)$/i.test(value.trim());
const falsy = (value: string) => /^(false|0|no|off|disabled?)$/i.test(value.trim());

/** Reads `host`, `host:port`, `[::1]` and `[::1]:5432`. */
const hostPort = (entry: string): { host: string; port?: number } | ConnectionStringError => {
    const trimmed = entry.trim();
    if (!trimmed) return { code: 'HOST', message: 'The connection string has an empty host.' };
    let host = trimmed;
    let portText: string | undefined;
    if (trimmed.startsWith('[')) {
        const end = trimmed.indexOf(']');
        if (end < 0)
            return { code: 'HOST', message: 'An IPv6 address is missing its closing “]”.' };
        host = trimmed.slice(1, end);
        const rest = trimmed.slice(end + 1);
        if (rest) {
            if (!rest.startsWith(':'))
                return { code: 'HOST', message: `Unexpected text “${rest}” after the host.` };
            portText = rest.slice(1);
        }
    } else {
        const colon = trimmed.lastIndexOf(':');
        if (colon >= 0) {
            host = trimmed.slice(0, colon);
            portText = trimmed.slice(colon + 1);
        }
    }
    const decoded = decode(host, 'host');
    if (isError(decoded)) return decoded;
    if (!decoded) return { code: 'HOST', message: 'The connection string has an empty host.' };
    if (/\s/.test(decoded) || /[/@?#]/.test(decoded))
        return { code: 'HOST', message: `“${decoded}” is not a valid host name.` };
    if (portText === undefined || portText === '') return { host: decoded };
    if (!/^\d+$/.test(portText) || Number(portText) < 1 || Number(portText) > 65535)
        return { code: 'PORT', message: `“${portText}” is not a valid port (1 to 65535).` };
    return { host: decoded, port: Number(portText) };
};

const MYSQL_SSL_MODES: Record<string, DbTlsMode> = {
    disabled: 'disable',
    disable: 'disable',
    preferred: 'prefer',
    prefer: 'prefer',
    required: 'require',
    require: 'require',
    verify_ca: 'verify-ca',
    'verify-ca': 'verify-ca',
    verify_identity: 'verify-full',
    'verify-full': 'verify-full',
};

const POSTGRES_SSL_MODES: Record<string, DbTlsMode> = {
    disable: 'disable',
    allow: 'prefer',
    prefer: 'prefer',
    require: 'require',
    'verify-ca': 'verify-ca',
    'verify-full': 'verify-full',
    // libpq's no-verify, and the common shorthand
    'no-verify': 'require',
};

/** Splits a path into a decoded database name (the part after the first `/`). */
const databaseOf = (path: string): string | undefined | ConnectionStringError => {
    const raw = path.startsWith('/') ? path.slice(1) : path;
    if (!raw) return undefined;
    const decoded = decode(raw, 'database name');
    return isError(decoded) ? decoded : decoded || undefined;
};

/**
 * Reads one connection string. `expected` is the engine chosen in the form: a string for another
 * engine is reported instead of being applied silently over the wrong settings.
 */
export const parseConnectionString = (
    input: string,
    expected?: ConnectionStringEngine,
): ParseResult => {
    const text = input.trim();
    if (!text)
        return fail(
            'EMPTY',
            'Paste a connection string, for example mysql://user:password@host:3306/database.',
        );

    const schemeEnd = text.indexOf('://');
    if (schemeEnd <= 0)
        return fail(
            'SCHEME',
            'A connection string starts with its scheme: mysql://, postgresql://, mongodb://, mongodb+srv:// or redis://.',
        );
    const scheme = text.slice(0, schemeEnd).toLowerCase();
    const engine = SCHEMES[scheme];
    if (!engine)
        return fail('SCHEME', `“${scheme}://” is not a supported connection string scheme.`);
    if (expected && engine !== expected)
        return fail(
            'ENGINE_MISMATCH',
            `This is a ${scheme}:// string, but the connection is set up for ${expected}. Change the database type first.`,
        );

    let rest = text.slice(schemeEnd + 3);
    const hash = rest.indexOf('#');
    if (hash >= 0) rest = rest.slice(0, hash);
    const queryStart = rest.indexOf('?');
    const query = queryStart >= 0 ? rest.slice(queryStart + 1) : '';
    const beforeQuery = queryStart >= 0 ? rest.slice(0, queryStart) : rest;
    const slash = beforeQuery.indexOf('/');
    const authority = slash >= 0 ? beforeQuery.slice(0, slash) : beforeQuery;
    const path = slash >= 0 ? beforeQuery.slice(slash) : '';

    // User info is everything before the last "@" of the authority.
    const at = authority.lastIndexOf('@');
    const userInfo = at >= 0 ? authority.slice(0, at) : '';
    const hostList = at >= 0 ? authority.slice(at + 1) : authority;

    let username: string | undefined;
    let password: string | undefined;
    if (userInfo) {
        const colon = userInfo.indexOf(':');
        const rawUser = colon >= 0 ? userInfo.slice(0, colon) : userInfo;
        const user = decode(rawUser, 'user name');
        if (isError(user)) return { ok: false, error: user };
        username = user || undefined;
        if (colon >= 0) {
            const pass = decode(userInfo.slice(colon + 1), 'password');
            if (isError(pass)) return { ok: false, error: pass };
            password = pass || undefined;
        }
    }

    const hosts: { host: string; port?: number }[] = [];
    for (const entry of hostList.split(',')) {
        // Only MongoDB lists several hosts; an empty entry elsewhere is an error all the same.
        const parsed = hostPort(entry);
        if (isError(parsed)) return { ok: false, error: parsed };
        hosts.push(parsed);
    }
    if (hosts.length === 0) return fail('HOST', 'The connection string has no host.');
    if (engine !== 'mongodb' && hosts.length > 1)
        return fail('HOST', `A ${engine} connection string names one host.`);

    const srv = scheme === 'mongodb+srv';
    if (srv) {
        if (hosts.length !== 1)
            return fail('SRV', 'A mongodb+srv:// string names exactly one cluster host name.');
        if (hosts[0]!.port !== undefined)
            return fail(
                'SRV',
                'A mongodb+srv:// string cannot have a port: the DNS record supplies it.',
            );
        if (!hosts[0]!.host.includes('.'))
            return fail(
                'SRV',
                'A mongodb+srv:// host must be a fully qualified domain name, such as cluster0.example.mongodb.net.',
            );
    }

    const database = databaseOf(path);
    if (isError(database)) return { ok: false, error: database };

    const pairs = queryOf(query);
    if (isError(pairs)) return { ok: false, error: pairs };

    const value: ParsedConnection = {
        engine,
        host: hosts[0]!.host,
        port: hosts[0]!.port ?? DEFAULT_PORTS[engine],
        ...(username !== undefined ? { username } : {}),
        ...(password !== undefined ? { password } : {}),
        options: {},
    };
    if (database) {
        // Redis: the path is the database index.
        if (engine === 'redis' && !/^\d+$/.test(database))
            return fail(
                'PARAMETER',
                'A redis:// database must be a number, such as redis://host:6379/0.',
            );
        value.database = database;
    }
    if (hosts.length > 1)
        value.options.seeds = hosts
            .slice(1)
            .map(
                (h) =>
                    `${h.host.includes(':') ? `[${h.host}]` : h.host}:${h.port ?? DEFAULT_PORTS[engine]}`,
            )
            .join(',');
    if (srv) value.options.srv = 'true';
    if (scheme === 'rediss' || scheme === 'valkeys') value.tls = 'verify-full';

    for (const [key, raw] of pairs) {
        const lower = key.toLowerCase();
        const val = raw;
        switch (engine) {
            case 'mysql':
                if (['ssl-mode', 'sslmode', 'ssl_mode'].includes(lower)) {
                    const mode = MYSQL_SSL_MODES[val.toLowerCase()];
                    if (!mode)
                        return fail(
                            'PARAMETER',
                            `“${val}” is not a MySQL ssl-mode (DISABLED, PREFERRED, REQUIRED, VERIFY_CA or VERIFY_IDENTITY).`,
                        );
                    value.tls = mode;
                } else if (lower === 'ssl' || lower === 'tls' || lower === 'usessl') {
                    if (truthy(val) && !value.tls) value.tls = 'require';
                    else if (falsy(val)) value.tls = 'disable';
                } else if (
                    lower === 'connecttimeout' ||
                    lower === 'connect_timeout' ||
                    lower === 'connect-timeout'
                ) {
                    const n = Number(val);
                    if (!Number.isFinite(n) || n <= 0)
                        return fail('PARAMETER', `“${val}” is not a valid connect timeout.`);
                    // mysql2 and JDBC give milliseconds; the libmysql option is in seconds.
                    value.connectTimeoutMs = lower === 'connect_timeout' ? n * 1000 : n;
                } else value.options[key] = val;
                break;
            case 'postgresql':
                if (lower === 'sslmode') {
                    const mode = POSTGRES_SSL_MODES[val.toLowerCase()];
                    if (!mode)
                        return fail(
                            'PARAMETER',
                            `“${val}” is not a PostgreSQL sslmode (disable, allow, prefer, require, verify-ca or verify-full).`,
                        );
                    value.tls = mode;
                } else if (lower === 'ssl') {
                    if (truthy(val) && !value.tls) value.tls = 'require';
                    else if (falsy(val)) value.tls = 'disable';
                } else if (lower === 'connect_timeout') {
                    const n = Number(val);
                    if (!Number.isFinite(n) || n <= 0)
                        return fail('PARAMETER', `“${val}” is not a valid connect_timeout.`);
                    value.connectTimeoutMs = n * 1000;
                } else if (
                    lower === 'search_path' ||
                    lower === 'schema' ||
                    lower === 'currentschema'
                ) {
                    value.options.searchPath = val;
                } else if (lower === 'options') {
                    // libpq: options=-c search_path=a,b -c statement_timeout=5s
                    const match = /(?:^|\s)-c\s+search_path=([^\s]+)/.exec(val);
                    if (match) value.options.searchPath = match[1]!;
                    else value.options[key] = val;
                } else if (lower === 'application_name') value.options.application_name = val;
                else value.options[key] = val;
                break;
            case 'mongodb':
                if (lower === 'tls' || lower === 'ssl') {
                    if (truthy(val)) value.tls ??= 'verify-full';
                    else if (falsy(val)) value.tls = 'disable';
                    else return fail('PARAMETER', `tls must be true or false, not “${val}”.`);
                } else if (lower === 'tlsinsecure' || lower === 'tlsallowinvalidcertificates') {
                    if (truthy(val)) value.tls = 'require';
                } else if (lower === 'tlsallowinvalidhostnames') {
                    if (truthy(val) && value.tls !== 'require') value.tls = 'verify-ca';
                } else if (lower === 'connecttimeoutms') {
                    const n = Number(val);
                    if (!Number.isFinite(n) || n <= 0)
                        return fail('PARAMETER', `“${val}” is not a valid connectTimeoutMS.`);
                    value.connectTimeoutMs = n;
                } else if (lower === 'authsource') value.options.authSource = val;
                else if (lower === 'authmechanism') value.options.authMechanism = val;
                else if (lower === 'replicaset') value.options.replicaSet = val;
                else if (lower === 'readpreference') value.options.readPreference = val;
                else if (lower === 'w') value.options.w = val;
                else if (lower === 'wtimeoutms') value.options.wtimeoutMS = val;
                else if (lower === 'journal') value.options.journal = val;
                else if (lower === 'retrywrites') value.options.retryWrites = val;
                else if (lower === 'retryreads') value.options.retryReads = val;
                else if (lower === 'appname') value.options.appName = val;
                else if (lower === 'directconnection') value.options.directConnection = val;
                else value.options[key] = val;
                break;
            case 'redis':
                if (lower === 'tls' || lower === 'ssl') {
                    if (truthy(val)) value.tls ??= 'verify-full';
                    else if (falsy(val)) value.tls = 'disable';
                } else if (lower === 'db' && /^\d+$/.test(val)) value.database = val;
                else if (lower === 'connecttimeout' || lower === 'timeout') {
                    const n = Number(val);
                    if (Number.isFinite(n) && n > 0) value.connectTimeoutMs = n;
                } else value.options[key] = val;
                break;
        }
    }

    // mongodb+srv implies TLS unless the string says otherwise.
    if (srv && value.tls === undefined) value.tls = 'verify-full';
    return { ok: true, value };
};

/* ---------- The other direction ---------- */

export interface ConnectionStringSource {
    engine: string;
    host: string;
    port: number;
    database?: string;
    username?: string;
    tls?: DbTlsMode;
    connectTimeoutMs?: number;
    options?: Record<string, string>;
}

const encode = (value: string) =>
    encodeURIComponent(value).replace(
        /[!'()*]/g,
        (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
    );

const hostText = (host: string) =>
    host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;

/** Options that are only part of how the string is written, not parameters of it. */
const STRUCTURAL = new Set(['srv', 'seeds']);

const MYSQL_MODE_NAMES: Record<DbTlsMode, string> = {
    disable: 'DISABLED',
    prefer: 'PREFERRED',
    require: 'REQUIRED',
    'verify-ca': 'VERIFY_CA',
    'verify-full': 'VERIFY_IDENTITY',
};

/**
 * Writes the string for the form's fields. The password is left out unless given; when `mask` is
 * set it is written as `****`, which is what the window shows. A string for a password the window
 * does not hold (a saved one) never contains the real value.
 */
export const formatConnectionString = (
    source: ConnectionStringSource,
    password?: string,
    options: { mask?: boolean } = {},
): string | null => {
    const engine = source.engine as ConnectionStringEngine;
    if (!(engine in SCHEME_OF) || !source.host.trim()) return null;
    const extra = source.options ?? {};
    const srv = engine === 'mongodb' && extra.srv === 'true';
    let scheme = srv ? 'mongodb+srv' : SCHEME_OF[engine];
    if (engine === 'redis' && source.tls && source.tls !== 'disable') scheme = 'rediss';

    let user = '';
    if (source.username) {
        user = encode(source.username);
        if (password !== undefined && password !== '')
            user += `:${options.mask ? '****' : encode(password)}`;
        user += '@';
    }

    const primary = srv ? source.host : `${hostText(source.host)}:${source.port}`;
    const hosts = !srv && extra.seeds ? `${primary},${extra.seeds}` : primary;
    const path = source.database ? `/${encode(source.database)}` : '';

    const params: [string, string][] = [];
    const add = (key: string, value: string | undefined) => {
        if (value !== undefined && value !== '') params.push([key, value]);
    };
    const tls = source.tls;
    switch (engine) {
        case 'mysql':
            if (tls && tls !== 'prefer') add('ssl-mode', MYSQL_MODE_NAMES[tls]);
            if (source.connectTimeoutMs) add('connectTimeout', String(source.connectTimeoutMs));
            break;
        case 'postgresql':
            if (tls && tls !== 'prefer') add('sslmode', tls);
            if (source.connectTimeoutMs)
                add(
                    'connect_timeout',
                    String(Math.max(1, Math.round(source.connectTimeoutMs / 1000))),
                );
            if (extra.searchPath) add('options', `-c search_path=${extra.searchPath}`);
            break;
        case 'mongodb':
            if (tls === 'disable') add('tls', 'false');
            else if (tls === 'require') {
                add('tls', 'true');
                add('tlsAllowInvalidCertificates', 'true');
            } else if (tls === 'verify-ca') {
                add('tls', 'true');
                add('tlsAllowInvalidHostnames', 'true');
            } else if (tls === 'verify-full' && !srv) add('tls', 'true');
            if (source.connectTimeoutMs) add('connectTimeoutMS', String(source.connectTimeoutMs));
            break;
        case 'redis':
            if (source.connectTimeoutMs) add('connectTimeout', String(source.connectTimeoutMs));
            break;
    }
    for (const [key, value] of Object.entries(extra)) {
        if (STRUCTURAL.has(key)) continue;
        if (engine === 'postgresql' && key === 'searchPath') continue;
        add(key, value);
    }
    const query = params.length
        ? `?${params.map(([k, v]) => `${encode(k)}=${encode(v)}`).join('&')}`
        : '';
    const slash = path === '' && query && engine === 'mongodb' ? '/' : path;
    return `${scheme}://${user}${hosts}${slash}${query}`;
};

/** Hides the password of a connection string, for logs and error messages. */
export const redactConnectionString = (text: string): string =>
    text.replace(/(:\/\/[^:/?#@\s]*:)[^@\s]*@/g, '$1****@');
