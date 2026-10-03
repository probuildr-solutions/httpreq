/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { redactConnectionString } from './connectionString';

/**
 * Turns what a failed connection attempt reported into something a person can act on: which
 * stage failed, what it usually means and what to check. The original message is kept as
 * `detail` for diagnosis, with any connection string password hidden; the classification itself
 * only reads error codes and wording, so it never needs, and never repeats, a secret.
 */
export type ConnectionFailureKind =
    | 'invalid-string'
    | 'dns'
    | 'srv'
    | 'timeout'
    | 'unreachable'
    | 'refused'
    | 'tls'
    | 'certificate'
    | 'auth'
    | 'unsupported-auth'
    | 'unavailable'
    | 'unknown';

export interface ConnectionFailure {
    kind: ConnectionFailureKind;
    title: string;
    hint: string;
    /** The server's or system's own words, without secrets. */
    detail: string;
}

const RULES: { kind: ConnectionFailureKind; test: RegExp; title: string; hint: string }[] = [
    {
        kind: 'srv',
        test: /SRV lookup|SRV record|TXT record/i,
        title: 'The MongoDB cluster address could not be resolved',
        hint: 'Check the cluster host name in the mongodb+srv:// string, that your DNS can resolve SRV records, and that a VPN or firewall is not blocking DNS.',
    },
    {
        kind: 'dns',
        test: /ENOTFOUND|EAI_AGAIN|getaddrinfo|could not be resolved/i,
        title: 'The host name could not be found',
        hint: 'Check the spelling of the host and that you are online. A name that only exists inside a company network needs its VPN.',
    },
    {
        kind: 'certificate',
        test: /CERT_|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS_CERT|certificate|ALTNAME/i,
        title: 'The server’s certificate was not accepted',
        hint: 'The certificate may be expired, self-signed, issued by an authority that is not trusted, or for a different host name. Add the CA certificate, or lower the encryption setting only if you trust the network.',
    },
    {
        kind: 'tls',
        test: /\bTLS\b|\bSSL\b|EPROTO|handshake|ERR_SSL|wrong version number/i,
        title: 'A secure connection could not be set up',
        hint: 'The server may not offer TLS on this port, or requires a different version. Try “No TLS” for a local server, or check the port.',
    },
    {
        kind: 'unsupported-auth',
        test: /login method|authentication (plugin|method|mechanism)|auth(entication)? mechanism|not supported \(use SCRAM|unsupported auth/i,
        title: 'The server’s login method is not supported',
        hint: 'This client supports password logins (SCRAM, caching_sha2_password, mysql_native_password, md5). Check the user’s authentication method on the server.',
    },
    {
        kind: 'auth',
        test: /AUTH_FAILED|authentication failed|access denied|password authentication|invalid password|auth failed|not authorized|WRONGPASS|NOAUTH/i,
        title: 'The user name or password was rejected',
        hint: 'Check the user and password. For MongoDB the user is looked up in the Auth source database (often admin).',
    },
    {
        kind: 'timeout',
        test: /ETIMEDOUT|timed? ?out|TIMEOUT/i,
        title: 'The server did not answer in time',
        hint: 'The address may be wrong, the server busy, or a firewall may be dropping the connection. The connect timeout can be raised in the advanced settings.',
    },
    {
        kind: 'refused',
        test: /ECONNREFUSED/i,
        title: 'The server refused the connection',
        hint: 'Nothing is listening on that host and port. Check the port, and that the database server is running and accepts network connections.',
    },
    {
        kind: 'unreachable',
        test: /EHOSTUNREACH|ENETUNREACH|ECONNRESET|EPIPE|network is unreachable|no route/i,
        title: 'The server could not be reached',
        hint: 'There is no network route to the server, or the connection was cut. Check your network, VPN and firewall.',
    },
    {
        kind: 'unavailable',
        test: /unknown database|does not exist|too many connections|shutting down|starting up|not accepting|no primary|not the primary|unavailable/i,
        title: 'The database is not available',
        hint: 'The database may not exist, the server may be starting or shutting down, or it may have reached its connection limit.',
    },
];

export const explainConnectionFailure = (error: unknown, code?: string): ConnectionFailure => {
    const raw = error instanceof Error ? error.message : String(error ?? '');
    const detail = redactConnectionString(raw).slice(0, 500);
    const text = `${code ?? ''} ${raw}`;
    for (const rule of RULES) {
        if (rule.test.test(text)) {
            return { kind: rule.kind, title: rule.title, hint: rule.hint, detail };
        }
    }
    return {
        kind: 'unknown',
        title: 'The connection failed',
        hint: 'Check the host, port and credentials, then try again.',
        detail,
    };
};

/** The failure for a connection string that could not be read. */
export const invalidStringFailure = (message: string): ConnectionFailure => ({
    kind: 'invalid-string',
    title: 'The connection string is not valid',
    hint: message,
    detail: '',
});
