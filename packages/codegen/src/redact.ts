/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { SECRET_PLACEHOLDER, type CodegenBody, type CodegenHeader } from '@httpreq/shared';

/**
 * Keeping credentials out of generated code. Generated code is meant to be pasted into chats,
 * tickets and repositories, so secrets are replaced by a placeholder unless the user explicitly
 * asks for them. Two complementary rules apply:
 *
 * - by name: headers that carry credentials (`Authorization`, `Cookie`, the header an API-key
 *   scheme writes, headers marked secret) and query parameters an authorization scheme adds;
 * - by value: every secret known to the request (authorization secret fields, secret environment
 *   variables, secret header values) is replaced wherever it appears, including inside a body.
 */

export interface SecretRules {
    /** Lower-case header names whose whole value is sensitive. */
    headerNames: Set<string>;
    /** Query parameter names whose value is sensitive. */
    queryNames: Set<string>;
    /** Literal secret strings, replaced wherever they occur. */
    values: string[];
}

export const ALWAYS_SENSITIVE_HEADERS = [
    'authorization',
    'proxy-authorization',
    'cookie',
    'set-cookie',
    'x-api-key',
    'x-auth-token',
    'x-csrf-token',
];

export const emptyRules = (): SecretRules => ({
    headerNames: new Set(ALWAYS_SENSITIVE_HEADERS),
    queryNames: new Set(),
    values: [],
});

/** Secrets shorter than this are not replaced by value: they would mangle unrelated text. */
const MIN_SECRET_LENGTH = 4;

export const replaceSecretValues = (text: string, values: string[]): string => {
    let result = text;
    for (const value of [...values].sort((a, b) => b.length - a.length)) {
        if (value.length >= MIN_SECRET_LENGTH)
            result = result.split(value).join(SECRET_PLACEHOLDER);
    }
    return result;
};

export const redactHeader = (header: CodegenHeader, rules: SecretRules): CodegenHeader => {
    const name = header.name.toLowerCase();
    if (rules.headerNames.has(name)) {
        // `Bearer abc` keeps its scheme so the shape of the header stays readable.
        const space = header.value.indexOf(' ');
        const scheme = name === 'authorization' || name === 'proxy-authorization';
        return {
            name: header.name,
            value:
                scheme && space > 0
                    ? `${header.value.slice(0, space)} ${SECRET_PLACEHOLDER}`
                    : SECRET_PLACEHOLDER,
        };
    }
    return { name: header.name, value: replaceSecretValues(header.value, rules.values) };
};

export const redactUrl = (url: string, rules: SecretRules): string => {
    let result = url;
    try {
        const parsed = new URL(url);
        if (parsed.username) parsed.username = SECRET_PLACEHOLDER;
        if (parsed.password) parsed.password = SECRET_PLACEHOLDER;
        let changed = false;
        for (const name of rules.queryNames) {
            if (parsed.searchParams.has(name)) {
                parsed.searchParams.set(name, SECRET_PLACEHOLDER);
                changed = true;
            }
        }
        // `URL` would percent-encode the placeholder's angle brackets; keep it readable.
        result = parsed.toString();
        if (changed || parsed.username || parsed.password) {
            result = result.split(encodeURIComponent(SECRET_PLACEHOLDER)).join(SECRET_PLACEHOLDER);
        }
    } catch {
        // Not an absolute URL (it contains an unresolved variable): fall back to value rules.
    }
    return replaceSecretValues(result, rules.values);
};

export const redactBody = (body: CodegenBody, rules: SecretRules): CodegenBody => {
    const sub = (text: string) => replaceSecretValues(text, rules.values);
    switch (body.kind) {
        case 'text':
            return { kind: 'text', text: sub(body.text) };
        case 'form':
            return {
                kind: 'form',
                fields: body.fields.map((field) => ({ name: field.name, value: sub(field.value) })),
            };
        case 'multipart':
            return {
                kind: 'multipart',
                parts: body.parts.map((part) =>
                    'value' in part ? { name: part.name, value: sub(part.value) } : part,
                ),
            };
        default:
            return body;
    }
};
