/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
    createCollection,
    createEmptyRequest,
    createEnvironment,
    createFolder,
    createKeyValue,
    type HttpRequest,
    type Workspace,
} from '@httpreq/shared';
import { createWorkspace } from '@httpreq/workspace';
import { parseImportSource } from '../import/sources';
import { buildExport } from './formats';
import { splitUrl } from './openapi';
import { postmanUrl } from './postman';

/** A collection with a folder, variables, a secret, a JSON body and inherited authorization. */
const fixture = () => {
    const workspace: Workspace = createWorkspace('Test');
    const collection = createCollection('Users API');
    collection.description = 'Manage users.';
    collection.auth = { type: 'bearer', token: '{{token}}', prefix: 'Bearer' };
    const folder = createFolder(collection.id, 'Admin');

    const list: HttpRequest = {
        ...createEmptyRequest(collection.id),
        name: 'List users',
        url: '{{base_url}}/users?page=2',
        params: [
            createKeyValue({ key: 'page', value: '2' }),
            createKeyValue({ key: 'limit', value: '10', enabled: false }),
        ],
        headers: [
            createKeyValue({ key: 'X-Trace', value: '{{trace}}' }),
            createKeyValue({ key: 'X-Secret', value: 'literal-secret', secret: true }),
        ],
    };
    const create: HttpRequest = {
        ...createEmptyRequest(folder.id),
        name: 'Create user',
        method: 'POST',
        url: '{{base_url}}/users/{{id}}',
        body: { ...createEmptyRequest().body, mode: 'json', json: '{"name":"Ada"}' },
        auth: { type: 'basic', username: 'admin', password: 'hunter2' },
    };

    const environment = createEnvironment('Dev');
    environment.variables = [
        {
            id: 'v1',
            key: 'base_url',
            value: 'https://api.example.com',
            enabled: true,
            secret: false,
        },
        { id: 'v2', key: 'id', value: '42', enabled: true, secret: false },
        { id: 'v3', key: 'token', value: 'real-token', enabled: true, secret: true },
    ];

    return {
        workspace: {
            ...workspace,
            collections: [collection],
            folders: [folder],
            requests: [list, create],
            environments: [environment],
            activeEnvironmentId: environment.id,
        },
        collection,
        list,
        create,
    };
};

describe('Postman export', () => {
    it('writes a v2.1.0 collection that imports back with the same requests', () => {
        const { workspace, collection } = fixture();
        const result = buildExport(
            workspace,
            { kind: 'collection', id: collection.id },
            'postman',
        )!;
        expect(result.fileName).toBe('Users_API.postman_collection.json');
        const document = JSON.parse(result.text);
        expect(document.info.schema).toBe(
            'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
        );
        expect(document.auth).toEqual({
            type: 'bearer',
            bearer: [{ key: 'token', value: '{{token}}', type: 'string' }],
        });
        // Secret variable values never leave the app; references and plain values do.
        expect(document.variable).toEqual([
            { key: 'base_url', value: 'https://api.example.com', type: 'string' },
            { key: 'id', value: '42', type: 'string' },
            { key: 'token', value: '', type: 'secret' },
        ]);

        const plan = parseImportSource(result.fileName, result.text);
        if (plan.type !== 'collection') throw new Error('expected a collection');
        expect(plan.collection.name).toBe('Users API');
        expect(plan.collection.auth).toEqual(collection.auth);
        expect(plan.folders.map((folder) => folder.name)).toEqual(['Admin']);

        const list = plan.requests.find((request) => request.name === 'List users')!;
        expect(list.url).toBe('{{base_url}}/users?page=2');
        expect(list.auth).toEqual({ type: 'inherit' });
        expect(list.params.map((param) => [param.key, param.value, param.enabled])).toEqual([
            ['page', '2', true],
            ['limit', '10', false],
        ]);
        // The literal secret header value is removed, the header itself kept.
        expect(list.headers.map((header) => [header.key, header.value])).toEqual([
            ['X-Trace', '{{trace}}'],
            ['X-Secret', ''],
        ]);

        const create = plan.requests.find((request) => request.name === 'Create user')!;
        expect(create.method).toBe('POST');
        expect(create.url).toBe('{{base_url}}/users/{{id}}');
        expect(create.body.mode).toBe('json');
        expect(JSON.parse(create.body.json)).toEqual({ name: 'Ada' });
        expect(create.auth).toEqual({ type: 'basic', username: 'admin', password: '' });
    });

    it('splits URLs into parts without breaking variables', () => {
        expect(postmanUrl('https://api.example.com:8443/v1/users?x=1', [])).toMatchObject({
            protocol: 'https',
            host: ['api', 'example', 'com'],
            port: '8443',
            path: ['v1', 'users'],
        });
        expect(postmanUrl('{{base_url}}/users/{{id}}', [])).toMatchObject({
            host: ['{{base_url}}'],
            path: ['users', '{{id}}'],
        });
    });
});

describe('OpenAPI export', () => {
    it('writes an OpenAPI 3.1 document with servers, parameters, bodies and security', () => {
        const { workspace, collection } = fixture();
        const result = buildExport(
            workspace,
            { kind: 'collection', id: collection.id },
            'openapi-json',
        )!;
        const document = JSON.parse(result.text);
        expect(document.openapi).toBe('3.1.0');
        expect(document.servers).toEqual([
            { url: '{base_url}', variables: { base_url: { default: 'https://api.example.com' } } },
        ]);
        expect(document.components.securitySchemes).toEqual({
            bearerAuth: { type: 'http', scheme: 'bearer' },
            basicAuth: { type: 'http', scheme: 'basic' },
        });
        expect(document.security).toEqual([{ bearerAuth: [] }]);

        const list = document.paths['/users'].get;
        expect(list.security).toBeUndefined();
        expect(list.parameters).toEqual([
            { name: 'page', in: 'query', required: true, schema: { type: 'string' }, example: '2' },
            { name: 'limit', in: 'query', schema: { type: 'string' }, example: '10' },
            {
                name: 'X-Trace',
                in: 'header',
                required: true,
                schema: { type: 'string' },
                example: '{{trace}}',
            },
            { name: 'X-Secret', in: 'header', required: true, schema: { type: 'string' } },
        ]);

        const create = document.paths['/users/{id}'].post;
        expect(create.tags).toEqual(['Admin']);
        expect(create.security).toEqual([{ basicAuth: [] }]);
        expect(create.parameters).toEqual([
            { name: 'id', in: 'path', required: true, schema: { type: 'string' }, example: '42' },
        ]);
        expect(create.requestBody.content['application/json'].example).toEqual({ name: 'Ada' });
        expect(result.text).not.toContain('hunter2');
        expect(result.text).not.toContain('real-token');
    });

    it('imports back into HttpReq, as JSON and as YAML', () => {
        const { workspace, collection } = fixture();
        for (const format of ['openapi-json', 'openapi-yaml'] as const) {
            const result = buildExport(
                workspace,
                { kind: 'collection', id: collection.id },
                format,
            )!;
            if (format === 'openapi-yaml') expect(parseYaml(result.text).openapi).toBe('3.1.0');
            const plan = parseImportSource(result.fileName, result.text);
            if (plan.type !== 'collection') throw new Error('expected a collection');
            expect(plan.requests.map((request) => [request.method, request.url]).sort()).toEqual([
                ['GET', '{{base_url}}/users?page=2'],
                ['POST', '{{base_url}}/users/{{id}}'],
            ]);
            expect(plan.environment?.variables.find((item) => item.key === 'base_url')?.value).toBe(
                'https://api.example.com',
            );
        }
    });

    it('exports a lone request with the authorization it inherits', () => {
        const { workspace, list } = fixture();
        const result = buildExport(workspace, { kind: 'request', request: list }, 'openapi-json')!;
        const document = JSON.parse(result.text);
        expect(document.info.title).toBe('List users');
        expect(document.paths['/users'].get.security).toEqual([{ bearerAuth: [] }]);
    });

    it('splits absolute and variable URLs into a server and a path', () => {
        expect(splitUrl('https://api.example.com/v1/users/{{id}}?x=1')).toEqual({
            server: 'https://api.example.com',
            serverVariables: [],
            path: '/v1/users/{id}',
            pathParameters: ['id'],
        });
        expect(splitUrl('{{base_url}}')).toMatchObject({ server: '{base_url}', path: '/' });
    });
});

describe('HttpReq export', () => {
    it('keeps the native format', () => {
        const { workspace, collection } = fixture();
        const result = buildExport(
            workspace,
            { kind: 'collection', id: collection.id },
            'httpreq',
        )!;
        expect(result.fileName).toBe('Users_API.httpreq.json');
        expect(JSON.parse(result.text).format).toBe('httpreq.collection');
    });
});
