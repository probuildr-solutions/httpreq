/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { describe, expect, it } from 'vitest';
import {
    createCollection,
    createEmptyRequest,
    createEnvironment,
    createKeyValue,
    type Environment,
    type HttpRequest,
    type Workspace,
} from '@httpreq/shared';
import { createDefaultWorkspace } from '@httpreq/workspace';
import { previewGeneratedHeaders, type GeneratedHeaderContext } from './generatedHeaders';
import { buildRequest } from './pipeline';

const environment: Environment = {
    ...createEnvironment('Development'),
    variables: [
        {
            id: '1',
            key: 'base_url',
            value: 'https://api.example.com',
            enabled: true,
            secret: false,
        },
        { id: '2', key: 'token', value: 'super-secret-token', enabled: true, secret: true },
        { id: '3', key: 'name', value: 'Zoë', enabled: true, secret: false },
    ],
};

const setup = (patch: Partial<HttpRequest> = {}, runtime: 'browser' | 'electron' = 'electron') => {
    const base = createDefaultWorkspace();
    const collection = createCollection('API');
    const request: HttpRequest = {
        ...createEmptyRequest(collection.id),
        url: '{{base_url}}/items',
        ...patch,
    };
    const workspace: Workspace = { ...base, collections: [collection], requests: [request] };
    const context: GeneratedHeaderContext = {
        workspace,
        environment,
        runtime,
        userAgent: 'Mozilla/5.0 Test',
        origin: 'http://localhost:5173',
    };
    return { request, workspace, context };
};

const byName = (headers: ReturnType<typeof previewGeneratedHeaders>, name: string) =>
    headers.find((header) => header.name.toLowerCase() === name.toLowerCase());

describe('previewGeneratedHeaders', () => {
    it('lists what the HTTP client adds for a plain GET', () => {
        const { request, context } = setup();
        const headers = previewGeneratedHeaders(request, context);
        expect(headers.map((header) => header.name)).toEqual([
            'Host',
            'User-Agent',
            'Accept',
            'Accept-Encoding',
            'Connection',
        ]);
        expect(byName(headers, 'Host')?.value).toBe('api.example.com');
        expect(byName(headers, 'User-Agent')?.value).toBe('Mozilla/5.0 Test');
        // A GET has no body, so nothing describes one.
        expect(byName(headers, 'Content-Length')).toBeUndefined();
    });

    it('describes the authorization header without revealing the credential', () => {
        const literal = setup({
            auth: { type: 'bearer', token: 'literal-secret', prefix: 'Bearer' },
        });
        const literalAuth = byName(
            previewGeneratedHeaders(literal.request, literal.context),
            'Authorization',
        );
        expect(literalAuth).toMatchObject({ source: 'authorization', overridable: false });
        expect(literalAuth?.value).toBe('Bearer ••••••••');

        const variable = setup({ auth: { type: 'bearer', token: '{{token}}', prefix: 'Bearer' } });
        const headers = previewGeneratedHeaders(variable.request, variable.context);
        expect(byName(headers, 'Authorization')?.value).toBe('Bearer {{token}}');
        expect(JSON.stringify(headers)).not.toContain('super-secret-token');
        expect(JSON.stringify(headers)).not.toContain('literal-secret');
    });

    it('follows authorization inheritance and says where it comes from', () => {
        const { request, workspace, context } = setup({ auth: { type: 'inherit' } });
        const collection = {
            ...workspace.collections[0]!,
            auth: { type: 'basic' as const, username: 'ada', password: 'pw' },
        };
        const headers = previewGeneratedHeaders(request, {
            ...context,
            workspace: { ...workspace, collections: [collection] },
        });
        expect(byName(headers, 'Authorization')).toMatchObject({
            value: 'Basic <base64 of username:password>',
        });
        expect(byName(headers, 'Authorization')?.note).toContain('inherited from “API”');
    });

    it('matches the Content-Type and Content-Length the pipeline actually sends', async () => {
        const { request, workspace, context } = setup({
            method: 'POST',
            body: { ...createEmptyRequest().body, mode: 'json', json: '{"name":"{{name}}"}' },
        });
        const headers = previewGeneratedHeaders(request, context);
        const built = await buildRequest(request, { workspace, environment });
        const sent = built.prepared.body;
        expect(sent?.kind).toBe('text');
        expect(byName(headers, 'Content-Type')?.value).toBe(built.prepared.headers['Content-Type']);
        // Bytes, not characters: "ë" takes two.
        const length = new TextEncoder().encode(sent?.kind === 'text' ? sent.text : '').byteLength;
        expect(byName(headers, 'Content-Length')?.value).toBe(String(length));
        expect(length).toBe('{"name":"Zoë"}'.length + 1);
    });

    it('marks a generated header replaced by one typed in the table, when it can be', () => {
        const { request, context } = setup({
            method: 'POST',
            body: { ...createEmptyRequest().body, mode: 'text', text: 'hi' },
            headers: [
                createKeyValue({ key: 'content-type', value: 'text/csv' }),
                createKeyValue({ key: 'Host', value: 'spoofed.example.com' }),
            ],
        });
        const headers = previewGeneratedHeaders(request, context);
        expect(byName(headers, 'Content-Type')?.overriddenBy).toBe('content-type');
        // Host cannot be replaced: it stays, and explains what happens to the typed one.
        expect(byName(headers, 'Host')?.overriddenBy).toBeUndefined();
        expect(byName(headers, 'Host')?.replacesManual).toMatch(/not sent/);
    });

    it('gives multipart bodies a boundary that cannot be overridden', () => {
        const { request, context } = setup({
            method: 'POST',
            body: {
                ...createEmptyRequest().body,
                mode: 'multipart',
                multipart: [{ ...createKeyValue({ key: 'a', value: '1' }), kind: 'text' }],
            },
        });
        const type = byName(previewGeneratedHeaders(request, context), 'Content-Type');
        expect(type?.value).toMatch(/^multipart\/form-data; boundary=/);
        expect(type?.overridable).toBe(false);
    });

    it('announces an empty body for POST without one, as Chromium does', () => {
        const { request, context } = setup({ method: 'POST' });
        expect(byName(previewGeneratedHeaders(request, context), 'Content-Length')?.value).toBe(
            '0',
        );
    });

    it('knows the browser keeps User-Agent and adds CORS headers across origins', () => {
        const { request, context } = setup({}, 'browser');
        const headers = previewGeneratedHeaders(request, context);
        expect(byName(headers, 'User-Agent')?.overridable).toBe(false);
        expect(byName(headers, 'Origin')?.value).toBe('http://localhost:5173');
        const desktop = previewGeneratedHeaders(request, { ...context, runtime: 'electron' });
        expect(byName(desktop, 'User-Agent')?.overridable).toBe(true);
        expect(byName(desktop, 'Origin')).toBeUndefined();
    });

    it('lists cookies only when the request sends them', () => {
        const { request, context } = setup();
        expect(byName(previewGeneratedHeaders(request, context), 'Cookie')).toBeUndefined();
        const withCookies = { ...request, settings: { ...request.settings, sendCookies: true } };
        expect(byName(previewGeneratedHeaders(withCookies, context), 'Cookie')).toBeDefined();
    });
});
