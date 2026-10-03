/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import {
    formatConnectionString,
    parseConnectionString,
    type ConnectionStringEngine,
    type ConnectionStringError,
    type DbConnectionSettings,
    type DbTlsMode,
} from '@httpreq/shared';
import type { ConnectionProfile } from './profiles';

/**
 * The connection form as data, and its two-way link to a connection string. The form is the single
 * source of truth: pasting a string fills it in, and the string shown is always written from it,
 * so the two cannot disagree. Everything the string carries that has no field of its own lives in
 * `options`, which the advanced inputs read and write by key.
 */
export interface ConnectionForm {
    name: string;
    engine: string;
    host: string;
    port: number | string;
    username: string;
    password: string;
    database: string;
    tls: DbTlsMode;
    ca: string;
    queryTimeoutSeconds: number | string;
    connectTimeoutSeconds: number | string;
    options: Record<string, string>;
}

export const DEFAULT_CONNECT_SECONDS = 10;

export const blankForm = (engine: string, port: number): ConnectionForm => ({
    name: '',
    engine,
    host: '127.0.0.1',
    port,
    username: '',
    password: '',
    database: '',
    tls: 'prefer',
    ca: '',
    queryTimeoutSeconds: 0,
    connectTimeoutSeconds: DEFAULT_CONNECT_SECONDS,
    options: {},
});

export const formFromProfile = (profile: ConnectionProfile): ConnectionForm => ({
    name: profile.name,
    engine: profile.settings.engine,
    host: profile.settings.host,
    port: profile.settings.port,
    username: profile.settings.username ?? '',
    password: '',
    database: profile.settings.database ?? '',
    tls: profile.settings.tls.mode,
    ca: profile.settings.tls.ca ?? '',
    queryTimeoutSeconds: Math.round((profile.settings.queryTimeoutMs ?? 0) / 1000),
    connectTimeoutSeconds: Math.round(
        (profile.settings.connectTimeoutMs ?? DEFAULT_CONNECT_SECONDS * 1000) / 1000,
    ),
    options: { ...profile.settings.options },
});

/** Drops empty values, so an option the user cleared is not saved. */
const cleanOptions = (options: Record<string, string>): Record<string, string> =>
    Object.fromEntries(
        Object.entries(options)
            .map(([key, value]) => [key.trim(), value.trim()] as const)
            .filter(([key, value]) => key !== '' && value !== ''),
    );

export const settingsOf = (form: ConnectionForm): DbConnectionSettings => {
    const options = cleanOptions(form.options);
    const connectSeconds = Number(form.connectTimeoutSeconds);
    return {
        engine: form.engine,
        host: form.host.trim(),
        port: Number(form.port),
        ...(form.database.trim() ? { database: form.database.trim() } : {}),
        ...(form.username.trim() ? { username: form.username.trim() } : {}),
        tls: { mode: form.tls, ...(form.ca.trim() ? { ca: form.ca } : {}) },
        ...(connectSeconds > 0 && connectSeconds !== DEFAULT_CONNECT_SECONDS
            ? { connectTimeoutMs: Math.min(120, connectSeconds) * 1000 }
            : {}),
        ...(Number(form.queryTimeoutSeconds) > 0
            ? { queryTimeoutMs: Number(form.queryTimeoutSeconds) * 1000 }
            : {}),
        ...(Object.keys(options).length > 0 ? { options } : {}),
    };
};

export const isSupportedStringEngine = (engine: string): engine is ConnectionStringEngine =>
    engine === 'mysql' || engine === 'postgresql' || engine === 'mongodb' || engine === 'redis';

/** The string for the form. The password is written masked, or left out when there is none. */
export const stringOf = (form: ConnectionForm): string => {
    if (!isSupportedStringEngine(form.engine)) return '';
    const settings = settingsOf(form);
    return (
        formatConnectionString(
            {
                engine: form.engine,
                host: settings.host,
                port: Number.isFinite(settings.port) ? settings.port : 0,
                database: settings.database,
                username: settings.username,
                tls: settings.tls.mode,
                connectTimeoutMs: settings.connectTimeoutMs,
                options: settings.options,
            },
            form.password,
            { mask: true },
        ) ?? ''
    );
};

export type ApplyResult =
    { ok: true; form: ConnectionForm } | { ok: false; error: ConnectionStringError };

/**
 * Applies a pasted string to the form. The string decides every field it mentions; the ones it
 * does not mention are kept (a string without a password does not clear the typed one), except
 * the options, which are replaced as a whole: a parameter that was removed from the string must
 * not linger in the form.
 */
export const applyString = (form: ConnectionForm, text: string): ApplyResult => {
    const result = parseConnectionString(text);
    if (!result.ok) return result;
    const parsed = result.value;
    const changedEngine = parsed.engine !== form.engine;
    const next: ConnectionForm = {
        ...form,
        engine: parsed.engine,
        host: parsed.host,
        port: parsed.port,
        username: parsed.username ?? '',
        database: parsed.database ?? '',
        options: parsed.options,
        // A different engine has different TLS defaults; a string that says nothing resets to prefer.
        tls: parsed.tls ?? (changedEngine ? 'prefer' : form.tls),
        connectTimeoutSeconds:
            parsed.connectTimeoutMs !== undefined
                ? Math.max(1, Math.round(parsed.connectTimeoutMs / 1000))
                : DEFAULT_CONNECT_SECONDS,
    };
    if (parsed.password !== undefined) next.password = parsed.password;
    else if (changedEngine || parsed.username === undefined) next.password = '';
    return { ok: true, form: next };
};

/** Option keys the form has an input for, per engine; the rest go in "Additional parameters". */
export const KNOWN_OPTIONS: Record<string, string[]> = {
    mysql: [],
    postgresql: ['searchPath', 'application_name'],
    mongodb: [
        'srv',
        'seeds',
        'authSource',
        'authMechanism',
        'replicaSet',
        'readPreference',
        'w',
        'wtimeoutMS',
        'journal',
        'retryWrites',
        'retryReads',
        'appName',
        'directConnection',
    ],
    redis: [],
};

/** "key=value" lines for the options with no input of their own. */
export const extraParametersText = (form: ConnectionForm): string =>
    Object.entries(form.options)
        .filter(([key]) => !(KNOWN_OPTIONS[form.engine] ?? []).includes(key))
        .map(([key, value]) => `${key}=${value}`)
        .join('\n');

/** Replaces the options with no input of their own by the lines of `text`. */
export const withExtraParameters = (form: ConnectionForm, text: string): ConnectionForm => {
    const known = KNOWN_OPTIONS[form.engine] ?? [];
    const options: Record<string, string> = {};
    for (const [key, value] of Object.entries(form.options))
        if (known.includes(key)) options[key] = value;
    for (const line of text.split(/\r?\n/)) {
        const eq = line.indexOf('=');
        if (eq <= 0) continue;
        const key = line.slice(0, eq).trim();
        if (key) options[key] = line.slice(eq + 1).trim();
    }
    return { ...form, options };
};
