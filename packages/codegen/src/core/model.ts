/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import type { CodegenHeader, HttpCodegenRequest } from '@httpreq/shared';
import { parseLosslessJson, type JsonValue } from './json';

/**
 * What an HTTP generator works from. It is the resolved request (`HttpCodegenRequest`) plus the
 * decisions every generator would otherwise repeat: whether the method carries a body, what kind
 * of text the body is, and whether a JSON body can be shown as data. A generator reads this
 * model and writes code; it never inspects the raw request.
 */

export type ModelBody =
    | { kind: 'none' }
    /** `value` is set when the document can be shown as data without changing it. */
    | { kind: 'json'; text: string; value: JsonValue | undefined }
    /** XML, SOAP envelopes and HTML: readable as lines, but written as text. */
    | { kind: 'markup'; text: string }
    | { kind: 'text'; text: string }
    | { kind: 'form'; fields: { name: string; value: string }[] }
    | {
          kind: 'multipart';
          parts: ({ name: string; value: string } | { name: string; fileName: string })[];
      }
    | { kind: 'file'; fileName: string };

export interface HttpModel {
    method: string;
    url: string;
    /** Every header to send. A multipart request has no `Content-Type`: the client adds its boundary. */
    headers: CodegenHeader[];
    body: ModelBody;
    /** The `Content-Type` header, when there is one. */
    contentType: string | undefined;
    followRedirects: boolean;
    verifyTls: boolean;
    timeoutMs: number;
    /** The header value, looked up case-insensitively. */
    header(name: string): string | undefined;
    /** The headers except the named ones (a library that sets them itself). */
    headersWithout(...names: string[]): CodegenHeader[];
}

const BODYLESS_METHODS = new Set(['GET', 'HEAD']);

/** Whether a request with this method is sent with a body. */
export const methodAllowsBody = (method: string) => !BODYLESS_METHODS.has(method.toUpperCase());

const isMarkup = (text: string) => {
    const trimmed = text.trim();
    return trimmed.startsWith('<') && trimmed.endsWith('>');
};

const textBody = (text: string, contentType: string | undefined): ModelBody => {
    if (contentType ? /json/i.test(contentType) : isJson(text)) {
        return { kind: 'json', text, value: parseLosslessJson(text) };
    }
    if (contentType ? /(xml|html)/i.test(contentType) : isMarkup(text)) {
        return { kind: 'markup', text };
    }
    return { kind: 'text', text };
};

const isJson = (text: string) => {
    try {
        const value: unknown = JSON.parse(text);
        return value !== null && typeof value === 'object';
    } catch {
        return false;
    }
};

export const toHttpModel = (request: HttpCodegenRequest): HttpModel => {
    const lookup = (name: string) =>
        request.headers.find((header) => header.name.toLowerCase() === name.toLowerCase())?.value;
    const contentType = lookup('Content-Type');
    const source = request.body;
    let body: ModelBody = { kind: 'none' };
    if (methodAllowsBody(request.method)) {
        if (source.kind === 'text') body = textBody(source.text, contentType);
        else if (source.kind !== 'none') body = source;
    }
    return {
        method: request.method.toUpperCase(),
        url: request.url,
        headers: request.headers,
        body,
        contentType,
        followRedirects: request.followRedirects,
        verifyTls: request.verifyTls,
        timeoutMs: request.timeoutMs,
        header: lookup,
        headersWithout: (...names) => {
            const skip = new Set(names.map((name) => name.toLowerCase()));
            return request.headers.filter((header) => !skip.has(header.name.toLowerCase()));
        },
    };
};

/** The body as one string, for libraries that can only send text (a form is re-encoded). */
export const bodyText = (body: ModelBody): string | undefined => {
    switch (body.kind) {
        case 'json':
        case 'markup':
        case 'text':
            return body.text;
        case 'form': {
            const params = new URLSearchParams();
            body.fields.forEach((field) => params.append(field.name, field.value));
            return params.toString();
        }
        default:
            return undefined;
    }
};

/** Text bodies readable as lines, which generators write as multi-line literals. */
export const isLineOriented = (body: ModelBody): body is ModelBody & { text: string } =>
    (body.kind === 'json' || body.kind === 'markup') && body.text.includes('\n');

/** Seconds for a library that takes them: `2.5`, or `5` when whole. */
export const seconds = (ms: number) => String(ms / 1000);

/** Whole seconds, rounded up, for options that only accept integers. */
export const wholeSeconds = (ms: number) => Math.ceil(ms / 1000);

/** Whether a name is usable bare as an object key or identifier (letters, digits, `_`, `$`). */
export const isIdentifier = (name: string) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name);

/** Where a file name's path ends: the name multipart parts should carry. */
export const baseName = (path: string) => path.split(/[\\/]/).pop() || path;

/** A multipart field or file name for use inside quotes, escaped the way browsers do. */
export const mimeQuoted = (name: string) =>
    name.replace(/"/g, '%22').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

/** The media type a file part is sent with when nothing says otherwise. */
export const DEFAULT_FILE_TYPE = 'application/octet-stream';
