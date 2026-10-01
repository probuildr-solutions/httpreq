/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import type { CodegenBody, CodegenHeader, HttpCodegenRequest } from '@httpreq/shared';

/** Joins non-empty lines; falsy entries are dropped so optional lines need no conditionals. */
export const lines = (...parts: (string | false | null | undefined)[]): string =>
    parts.filter((part): part is string => typeof part === 'string').join('\n');

/** A double-quoted literal with JSON escapes, valid in JavaScript, Java, C#, Go and Python. */
export const dq = (text: string): string => JSON.stringify(text);

/** A single-quoted literal for PHP and Ruby: only `\` and `'` are special. */
export const sqBackslash = (text: string): string =>
    `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/** A PowerShell single-quoted literal: only `'` is special, and is doubled. */
export const sqDouble = (text: string): string => `'${text.replace(/'/g, "''")}'`;

/** POSIX-shell single quoting. */
export const shellQuote = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`;

/** A Swift string literal, which writes unicode escapes as `\u{…}`. */
export const swiftString = (text: string): string =>
    `"${[...text]
        .map((char) => {
            const code = char.codePointAt(0)!;
            if (char === '"' || char === '\\') return `\\${char}`;
            if (char === '\n') return '\\n';
            if (char === '\r') return '\\r';
            if (char === '\t') return '\\t';
            return code < 0x20 ? `\\u{${code.toString(16)}}` : char;
        })
        .join('')}"`;

export const pad = (level: number, size = 4) => ' '.repeat(level * size);

export const methodAllowsBody = (method: string) => !['GET', 'HEAD'].includes(method.toUpperCase());

/** The header value, looked up case-insensitively. */
export const headerValue = (headers: CodegenHeader[], name: string): string | undefined =>
    headers.find((header) => header.name.toLowerCase() === name.toLowerCase())?.value;

/** Splits `host:port` of a gRPC target; the port is empty when absent. */
export const splitTarget = (target: string): { host: string; port: string } => {
    const match = /^(.*):(\d+)$/.exec(target);
    return { host: match?.[1] ?? target, port: match?.[2] ?? '' };
};

/** The body as one string where a generator can only send text (form fields re-encoded). */
export const bodyAsText = (body: CodegenBody): string | null => {
    switch (body.kind) {
        case 'text':
            return body.text;
        case 'form': {
            const params = new URLSearchParams();
            body.fields.forEach((field) => params.append(field.name, field.value));
            return params.toString();
        }
        default:
            return null;
    }
};

/** A header-list copy that excludes the headers a generator sets itself. */
export const withoutHeaders = (request: HttpCodegenRequest, names: string[]): CodegenHeader[] => {
    const skip = new Set(names.map((name) => name.toLowerCase()));
    return request.headers.filter((header) => !skip.has(header.name.toLowerCase()));
};

/** Comment line markers per language family. */
export const NOTE = {
    hash: (text: string) => `# ${text}`,
    slash: (text: string) => `// ${text}`,
};
