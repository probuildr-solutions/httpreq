/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import type { Environment, HttpRequest, RequestBody, Workspace } from '@httpreq/shared';
import { getAuthProvider, resolveEffectiveAuth } from './auth/registry';
import { createVariableResolver } from './variables';

/**
 * The headers a request is sent with that nobody typed into its Headers table: those the
 * authorization and the body add in the pipeline, and those the HTTP client (browser `fetch` or
 * Electron's Chromium network stack) adds on the wire.
 *
 * It is a preview for the editor, so it is synchronous and never exposes a credential: the pipeline
 * itself (`buildRequest`) remains what decides the real request.
 */

export type GeneratedHeaderSource = 'authorization' | 'body' | 'client';

export interface GeneratedHeader {
    name: string;
    /** The value that will be sent, or a description in angle brackets where it cannot be known. */
    value: string;
    source: GeneratedHeaderSource;
    /** An enabled header of the same name in the Headers table is sent instead of this one. */
    overridable: boolean;
    /** Why the header is there. */
    note: string;
    /** What happens to a header typed with the same name, when it is not sent. */
    replacesManual?: string;
    /** Set when an enabled header in the table takes this one's place. */
    overriddenBy?: string;
}

export interface GeneratedHeaderContext {
    /** For authorization inheritance. */
    workspace: Workspace;
    environment: Environment | null;
    runtime: 'browser' | 'electron';
    /** The runtime's own User-Agent (`navigator.userAgent`, which Electron's sessions share). */
    userAgent?: string;
    /** The page's origin, for the headers a browser adds to cross-origin requests. */
    origin?: string;
}

/**
 * The Content-Type the pipeline gives a body when the Headers table sets none, or `null` when it
 * sets none itself (no body, or multipart, whose boundary only the runtime knows).
 */
export const defaultBodyContentType = (body: RequestBody): string | null => {
    switch (body.mode) {
        case 'json':
            return 'application/json';
        case 'text':
            return body.textContentType;
        case 'form-urlencoded':
            return 'application/x-www-form-urlencoded';
        case 'binary':
            return body.binary?.type || 'application/octet-stream';
        default:
            return null;
    }
};

const encoder = typeof TextEncoder === 'undefined' ? null : new TextEncoder();
const byteLength = (text: string) => encoder?.encode(text).byteLength ?? text.length;

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const CALCULATED = '<calculated when the request is sent>';

export const previewGeneratedHeaders = (
    request: HttpRequest,
    context: GeneratedHeaderContext,
): GeneratedHeader[] => {
    const resolver = createVariableResolver(context.environment);
    const browser = context.runtime === 'browser';
    const client = browser ? 'the browser' : 'the HTTP client';
    const Client = browser ? 'The browser' : 'The HTTP client';
    const headers: GeneratedHeader[] = [];

    // 1. Authorization, following inheritance. It replaces a manual header of the same name.
    const effective = resolveEffectiveAuth(context.workspace, request);
    const provider = getAuthProvider(effective.auth);
    for (const [name, value] of Object.entries(provider.previewHeaders(effective.auth))) {
        headers.push({
            name,
            value,
            source: 'authorization',
            overridable: false,
            note:
                effective.source.kind === 'request'
                    ? `From ${provider.label} on the Authorization tab.`
                    : `From ${provider.label}, inherited from “${effective.source.name}”.`,
            replacesManual: `Replaced by the ${provider.label} authorization, so it is not sent twice.`,
        });
    }

    // 2. The body: its type and length.
    const { body } = request;
    const bodyless = request.method === 'GET' || request.method === 'HEAD';
    const text = (): string | null => {
        switch (body.mode) {
            case 'json':
                return resolver.resolve(body.json);
            case 'text':
                return resolver.resolve(body.text);
            case 'form-urlencoded': {
                const form = new URLSearchParams();
                for (const item of body.formUrlEncoded) {
                    if (item.enabled && item.key.trim()) {
                        form.append(resolver.resolve(item.key), resolver.resolve(item.value));
                    }
                }
                return form.toString();
            }
            default:
                return null;
        }
    };
    const content = bodyless || body.mode === 'none' ? null : text();
    // An empty JSON body is not sent at all.
    const sendsBody =
        !bodyless && body.mode !== 'none' && !(body.mode === 'json' && !content?.trim());
    if (sendsBody) {
        if (body.mode === 'multipart') {
            headers.push({
                name: 'Content-Type',
                value: 'multipart/form-data; boundary=<calculated when the request is sent>',
                source: 'body',
                overridable: false,
                note: 'The multipart body needs a boundary that only the HTTP client knows.',
                replacesManual: 'Replaced by multipart/form-data with its boundary.',
            });
        } else {
            headers.push({
                name: 'Content-Type',
                value: defaultBodyContentType(body) ?? CALCULATED,
                source: 'body',
                overridable: true,
                note: `From the ${body.mode === 'form-urlencoded' ? 'form' : body.mode} body.`,
            });
        }
        headers.push({
            name: 'Content-Length',
            value:
                content !== null
                    ? String(byteLength(content))
                    : body.mode === 'binary' && body.binary
                      ? String(body.binary.size)
                      : CALCULATED,
            source: 'body',
            overridable: false,
            note: `Measured by ${client} from the body.`,
            replacesManual: `${Client} measures the body itself; this value is not sent.`,
        });
    } else if (request.method === 'POST' || request.method === 'PUT') {
        // Chromium announces an empty body for these methods.
        headers.push({
            name: 'Content-Length',
            value: '0',
            source: 'client',
            overridable: false,
            note: `Sent by ${client} for a ${request.method} without a body.`,
            replacesManual: `${Client} measures the body itself; this value is not sent.`,
        });
    }

    // 3. What the HTTP client adds on the wire.
    let url: URL | null = null;
    const urlText = resolver.resolve(request.url.trim());
    try {
        url = urlText ? new URL(SCHEME.test(urlText) ? urlText : `http://${urlText}`) : null;
    } catch {
        url = null;
    }
    const clientSets = (name: string) => `${Client} sets ${name} itself; this value is not sent.`;
    headers.push(
        {
            name: 'Host',
            value: url && !url.host.includes('{{') ? url.host : '<from the URL>',
            source: 'client',
            overridable: false,
            note: 'Taken from the URL.',
            replacesManual: clientSets('Host'),
        },
        {
            name: 'User-Agent',
            value: context.userAgent || `<${client}’s user agent>`,
            source: 'client',
            // Browsers do not let a page change it; the desktop app's network stack does.
            overridable: !browser,
            note: browser ? 'Sent by the browser.' : 'The desktop app’s default.',
            ...(browser
                ? {
                      replacesManual:
                          'The browser sends its own User-Agent; this value is not sent.',
                  }
                : {}),
        },
        {
            name: 'Accept',
            value: '*/*',
            source: 'client',
            overridable: true,
            note: `Added by ${client} when no Accept header is set.`,
        },
        {
            name: 'Accept-Encoding',
            value: 'gzip, deflate, br, zstd',
            source: 'client',
            overridable: false,
            note: `The compressions ${client} can decode; responses are decompressed automatically.`,
            replacesManual: clientSets('Accept-Encoding'),
        },
        {
            name: 'Connection',
            value: 'keep-alive',
            source: 'client',
            overridable: false,
            note: `Connections are reused by ${client}.`,
            replacesManual: clientSets('Connection'),
        },
    );
    if (request.settings.sendCookies) {
        headers.push({
            name: 'Cookie',
            value: '<cookies stored for this host, if any>',
            source: 'client',
            overridable: !browser,
            note: browser
                ? 'The browser’s cookies for this site (Settings › Send cookies).'
                : 'From the app’s cookie jar (Settings › Send cookies).',
            ...(browser
                ? {
                      replacesManual:
                          'Browsers do not let a page set Cookie; this value is not sent.',
                  }
                : {}),
        });
    }
    if (browser && context.origin && url && url.origin !== context.origin) {
        headers.push(
            {
                name: 'Origin',
                value: context.origin,
                source: 'client',
                overridable: false,
                note: 'Added by the browser to cross-origin requests (CORS).',
                replacesManual: clientSets('Origin'),
            },
            {
                name: 'Referer',
                value: `${context.origin}/`,
                source: 'client',
                overridable: false,
                note: 'The page’s origin, under the browser’s default referrer policy.',
                replacesManual: clientSets('Referer'),
            },
        );
    }

    // 4. Which of them a header in the table takes the place of.
    const manual = new Map<string, string>();
    for (const item of request.headers) {
        const key = item.key.trim();
        if (item.enabled && key) manual.set(resolver.resolve(key).toLowerCase(), key);
    }
    return headers.map((header) => {
        const typed = manual.get(header.name.toLowerCase());
        return typed && header.overridable ? { ...header, overriddenBy: typed } : header;
    });
};
