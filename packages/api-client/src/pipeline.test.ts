/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { describe, expect, it, vi } from 'vitest';
import {
    createCollection,
    createEmptyRequest,
    createEnvironment,
    createFolder,
    createKeyValue,
    type Environment,
    type HttpRequest,
    type HttpResponse,
    type HttpRuntime,
    type Workspace,
} from '@httpreq/shared';
import { createDefaultWorkspace } from '@httpreq/workspace';
import { buildRequest, executeRequest, findHeaderConflicts } from './pipeline';
import { resolveEffectiveAuth } from './auth/registry';

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
        { id: '2', key: 'accessToken', value: 'tok-123', enabled: true, secret: true },
        { id: '3', key: 'tenantId', value: 't-{{region}}', enabled: true, secret: false },
        { id: '4', key: 'region', value: 'eu', enabled: true, secret: false },
        { id: '5', key: 'disabled', value: 'nope', enabled: false, secret: false },
    ],
};

/** Collection (bearer) → v1 → auth → admin → adminLogin (inherit). */
const tree = () => {
    const workspace = createDefaultWorkspace();
    const collection = {
        ...createCollection('Account API'),
        auth: { type: 'bearer' as const, token: '{{accessToken}}', prefix: 'Bearer' },
    };
    const v1 = createFolder(collection.id, 'v1');
    const auth = createFolder(v1.id, 'auth');
    const admin = createFolder(auth.id, 'admin');
    const request: HttpRequest = {
        ...createEmptyRequest(admin.id),
        name: 'adminLogin',
        method: 'POST',
        url: '{{base_url}}/v1/auth/login/admin?tenant={{tenantId}}',
        params: [createKeyValue({ key: 'tenant', value: '{{tenantId}}' })],
    };
    const next: Workspace = {
        ...workspace,
        collections: [collection],
        folders: [v1, auth, admin],
        requests: [request],
    };
    return { workspace: next, collection, admin, request };
};

describe('buildRequest', () => {
    it('resolves variables (including nested ones) without mutating the saved request', async () => {
        const { workspace, request } = tree();
        const snapshot = structuredClone(request);
        const built = await buildRequest(request, { workspace, environment });
        expect(built.prepared.url).toBe('https://api.example.com/v1/auth/login/admin?tenant=t-eu');
        expect(request).toEqual(snapshot);
    });

    it('inherits authorization from the nearest configured ancestor', async () => {
        const { workspace, request, collection } = tree();
        const built = await buildRequest(request, { workspace, environment });
        expect(built.prepared.headers.Authorization).toBe('Bearer tok-123');
        expect(built.effectiveAuth.source).toMatchObject({ kind: 'collection', id: collection.id });
    });

    it('lets a closer folder override the collection', () => {
        const { workspace, request, admin } = tree();
        const folders = workspace.folders.map((folder) =>
            folder.id === admin.id ? { ...folder, auth: { type: 'none' as const } } : folder,
        );
        const effective = resolveEffectiveAuth({ ...workspace, folders }, request);
        expect(effective).toMatchObject({
            auth: { type: 'none' },
            source: { kind: 'folder', name: 'admin' },
        });
    });

    it('flags a manual Authorization header instead of sending both', async () => {
        const { workspace, request } = tree();
        const withHeader = {
            ...request,
            headers: [createKeyValue({ key: 'authorization', value: 'Basic x' })],
        };
        const built = await buildRequest(withHeader, { workspace, environment });
        expect(findHeaderConflicts(withHeader, built.effectiveAuth)).toEqual(['authorization']);
        expect(
            Object.keys(built.prepared.headers).filter(
                (name) => name.toLowerCase() === 'authorization',
            ),
        ).toHaveLength(1);
        expect(built.prepared.headers.Authorization).toBe('Bearer tok-123');
        expect(built.warnings[0]).toMatch(/replaced the manual authorization header/);
    });

    it('warns when a credential variable resolves to nothing', async () => {
        const { workspace, request } = tree();
        const emptyToken: Environment = {
            ...environment,
            variables: environment.variables.map((variable) =>
                variable.key === 'accessToken' ? { ...variable, value: '' } : variable,
            ),
        };
        const built = await buildRequest(request, { workspace, environment: emptyToken });
        expect(built.warnings.join(' ')).toMatch(/Bearer Token: The token is empty/);
    });

    it('fails clearly when a URL variable is not defined', async () => {
        const { workspace, request } = tree();
        await expect(buildRequest(request, { workspace, environment: null })).rejects.toThrow(
            /\{\{base_url\}\}.*none is selected/,
        );
    });

    it('sends undefined path or query variables as written, with a warning', async () => {
        const request = { ...createEmptyRequest(), url: '{{base_url}}/items?tenant={{missing}}' };
        const built = await buildRequest(request, {
            workspace: createDefaultWorkspace(),
            environment,
        });
        expect(built.prepared.url).toBe('https://api.example.com/items?tenant={{missing}}');
        expect(built.warnings.join(' ')).toMatch(/\{\{missing\}\}/);
    });

    it('adds API keys to the query string and encodes JSON after substitution', async () => {
        const request: HttpRequest = {
            ...createEmptyRequest(),
            method: 'PUT',
            url: '{{base_url}}/items',
            auth: { type: 'api-key', key: 'api_key', value: '{{accessToken}}', location: 'query' },
            body: { ...createEmptyRequest().body, mode: 'json', json: '{"region":"{{region}}"}' },
        };
        const built = await buildRequest(request, {
            workspace: createDefaultWorkspace(),
            environment,
        });
        expect(built.prepared.url).toBe('https://api.example.com/items?api_key=tok-123');
        expect(built.prepared.body).toEqual({ kind: 'text', text: '{"region":"eu"}' });
        expect(built.prepared.headers['Content-Type']).toBe('application/json');
    });

    it('keeps secret variables as references when asked (sharing)', async () => {
        const { workspace, request } = tree();
        const built = await buildRequest(request, {
            workspace,
            environment,
            resolverOptions: { keepSecrets: true },
        });
        expect(built.prepared.headers.Authorization).toBe('Bearer {{accessToken}}');
    });

    it('encodes form bodies and skips disabled rows', async () => {
        const request: HttpRequest = {
            ...createEmptyRequest(),
            method: 'POST',
            url: 'https://example.com',
            body: {
                ...createEmptyRequest().body,
                mode: 'form-urlencoded',
                formUrlEncoded: [
                    createKeyValue({ key: 'a', value: '1 2' }),
                    createKeyValue({ key: 'b', value: 'x', enabled: false }),
                ],
            },
        };
        const built = await buildRequest(request, {
            workspace: createDefaultWorkspace(),
            environment,
        });
        expect(built.prepared.body).toEqual({ kind: 'text', text: 'a=1+2' });
    });
});

const ok = (patch: Partial<HttpResponse> = {}): HttpResponse => ({
    status: 200,
    statusText: 'OK',
    headers: {},
    body: '',
    contentType: 'text/plain',
    durationMs: 1,
    sizeBytes: 0,
    ...patch,
});

describe('executeRequest', () => {
    it('answers a Digest challenge once', async () => {
        const execute = vi
            .fn<HttpRuntime['execute']>()
            .mockResolvedValueOnce(
                ok({
                    status: 401,
                    headers: { 'www-authenticate': 'Digest realm="r", nonce="n", qop="auth"' },
                }),
            )
            .mockResolvedValueOnce(ok());
        const request: HttpRequest = {
            ...createEmptyRequest(),
            url: 'https://example.com/dir',
            auth: { type: 'digest', username: 'u', password: 'p' },
        };
        const result = await executeRequest(
            request,
            { workspace: createDefaultWorkspace(), environment: null },
            { kind: 'browser', execute },
        );
        expect(result.response.status).toBe(200);
        expect(execute).toHaveBeenCalledTimes(2);
        expect(execute.mock.calls[1]![0].headers.Authorization).toMatch(
            /^Digest username="u", realm="r"/,
        );
    });

    it('reports request timeouts as CONNECTION_TIMEOUT', async () => {
        const execute: HttpRuntime['execute'] = (_request, signal) =>
            new Promise((_, reject) =>
                signal?.addEventListener('abort', () =>
                    reject(new DOMException('Aborted', 'AbortError')),
                ),
            );
        const request: HttpRequest = {
            ...createEmptyRequest(),
            url: 'https://example.com',
            settings: { ...createEmptyRequest().settings, timeoutMs: 10 },
        };
        await expect(
            executeRequest(
                request,
                { workspace: createDefaultWorkspace(), environment: null },
                { kind: 'browser', execute },
            ),
        ).rejects.toMatchObject({ code: 'CONNECTION_TIMEOUT' });
    });

    it('does not time out an open event stream, and the user can still stop it', async () => {
        const stop = new AbortController();
        const head = {
            status: 200,
            statusText: 'OK',
            headers: {},
            contentType: 'text/event-stream',
        };
        const execute: HttpRuntime['execute'] = (_request, signal, hooks) =>
            new Promise((resolve, reject) => {
                // Headers arrive, then the stream stays open well past the 10 ms request timeout.
                hooks?.onStreamStart?.(head);
                signal?.addEventListener('abort', () =>
                    signal.reason?.name === 'TimeoutError'
                        ? reject(new DOMException('Timed out', 'TimeoutError'))
                        : resolve(
                              ok({ ...head, stream: { events: [], ended: 'stopped', dropped: 0 } }),
                          ),
                );
            });
        const request: HttpRequest = {
            ...createEmptyRequest(),
            url: 'https://example.com/events',
            settings: { ...createEmptyRequest().settings, timeoutMs: 10 },
        };
        const started = vi.fn();
        const pending = executeRequest(
            request,
            { workspace: createDefaultWorkspace(), environment: null },
            { kind: 'browser', execute },
            stop.signal,
            { onStreamStart: started },
        );
        await new Promise((resolve) => setTimeout(resolve, 60));
        stop.abort();
        const result = await pending;
        expect(started).toHaveBeenCalledWith(head);
        expect(result.response.stream?.ended).toBe('stopped');
    });
});
