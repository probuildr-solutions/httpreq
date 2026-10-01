/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { describe, expect, it } from 'vitest';
import { createWorkspace } from '@httpreq/workspace';
import { applyEnvironment, applyImportPlan } from './apply';
import { parseCurl, tokenize } from './curl';
import { importFiles, type ImportSourceFile } from './run';
import { parseImportSource } from './sources';

const file = (path: string, content: string): ImportSourceFile => ({
    path,
    size: content.length,
    read: async () => content,
});

describe('cURL import', () => {
    it('tokenizes quotes, $-strings and line continuations', () => {
        expect(tokenize(`curl 'a b' "c \\"d\\"" $'e\\nf' \\\n  g`)).toEqual([
            'curl',
            'a b',
            'c "d"',
            'e\nf',
            'g',
        ]);
    });

    it('turns a browser "Copy as cURL" command into a request', () => {
        const request = parseCurl(
            `curl 'https://api.example.com/users?page=2' -X POST -H 'Content-Type: application/json' -H 'Accept: */*' --data-raw '{"name":"Ada"}' -u admin:secret --compressed -k`,
        );
        expect(request.method).toBe('POST');
        expect(request.url).toBe('https://api.example.com/users?page=2');
        expect(request.params.map((param) => [param.key, param.value])).toEqual([['page', '2']]);
        expect(request.headers.map((header) => header.key)).toEqual(['Content-Type', 'Accept']);
        expect(request.body.mode).toBe('json');
        expect(request.body.json).toBe('{\n    "name": "Ada"\n}');
        expect(request.auth).toEqual({ type: 'basic', username: 'admin', password: 'secret' });
        expect(request.settings.verifyTls).toBe(false);
    });

    it('defaults to POST for data and reads form fields', () => {
        const form = parseCurl('curl https://x.test/upload -F name=Ada -F file=@photo.png');
        expect(form.method).toBe('POST');
        expect(form.body.mode).toBe('multipart');
        expect(form.body.multipart.map((field) => [field.key, field.kind])).toEqual([
            ['name', 'text'],
            ['file', 'file'],
        ]);
        const urlencoded = parseCurl('curl -d a=1 -d b=two x.test');
        expect(urlencoded.url).toBe('http://x.test');
        expect(urlencoded.body.formUrlEncoded.map((field) => [field.key, field.value])).toEqual([
            ['a', '1'],
            ['b', 'two'],
        ]);
    });

    it('reports what is wrong with an invalid command', () => {
        expect(() => parseCurl('wget https://x.test')).toThrow('must start with “curl”');
        expect(() => parseCurl('curl -H')).toThrow('missing its value');
        expect(() => parseCurl("curl 'https://x.test")).toThrow('unterminated single quote');
        expect(() => parseCurl('curl -X POST')).toThrow('does not contain a URL');
    });
});

const openApi = {
    openapi: '3.0.3',
    info: { title: 'Pets' },
    servers: [{ url: 'https://{region}.pets.test/v1', variables: { region: { default: 'eu' } } }],
    security: [{ bearer: [] }],
    components: {
        securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
        schemas: {
            Pet: {
                type: 'object',
                properties: {
                    id: { type: 'integer', readOnly: true },
                    name: { type: 'string', example: 'Rex' },
                    tags: { type: 'array', items: { type: 'string' } },
                },
            },
        },
    },
    paths: {
        '/pets': {
            get: {
                tags: ['pets'],
                summary: 'List pets',
                parameters: [{ name: 'limit', in: 'query', required: true, example: 10 }],
            },
            post: {
                tags: ['pets'],
                operationId: 'createPet',
                requestBody: {
                    content: {
                        'application/json': { schema: { $ref: '#/components/schemas/Pet' } },
                    },
                },
            },
        },
        '/pets/{petId}': {
            parameters: [
                { name: 'petId', in: 'path', required: true, description: 'Pet id', example: 7 },
            ],
            delete: { summary: 'Delete a pet', security: [] },
        },
        '/files/{name}.json': { get: { summary: 'Get file' } },
    },
};

describe('file import', () => {
    it('converts an OpenAPI document into folders, requests and a base_url environment', () => {
        const plan = parseImportSource('pets.json', JSON.stringify(openApi));
        if (plan.type !== 'collection') throw new Error('expected a collection');
        expect(plan.collection.name).toBe('Pets');
        expect(plan.collection.auth).toEqual({
            type: 'bearer',
            token: '{{bearer_token}}',
            prefix: 'Bearer',
        });
        expect(plan.folders.map((folder) => folder.name)).toEqual(['pets']);
        expect(
            plan.requests.map((request) => `${request.method} ${request.name} ${request.url}`),
        ).toEqual([
            'GET List pets {{base_url}}/pets?limit=10',
            'POST createPet {{base_url}}/pets',
            'DELETE Delete a pet {{base_url}}/pets/:petId',
            'GET Get file {{base_url}}/files/{{name}}.json',
        ]);
        expect(plan.requests[2]!.pathVariables).toMatchObject([
            { key: 'petId', value: '7', description: 'Pet id' },
        ]);
        expect(plan.requests[3]!.pathVariables).toBeUndefined();
        expect(JSON.parse(plan.requests[1]!.body.json)).toEqual({ name: 'Rex', tags: ['string'] });
        expect(plan.requests[2]!.auth).toEqual({ type: 'none' });
        expect(plan.environment?.variables.find((item) => item.key === 'base_url')?.value).toBe(
            'https://eu.pets.test/v1',
        );
    });

    it('reads OpenAPI written in YAML', () => {
        const yaml = `openapi: 3.1.0\ninfo:\n  title: Tiny\npaths:\n  /ping:\n    get:\n      summary: Ping\n`;
        const plan = parseImportSource('tiny.yaml', yaml);
        expect(plan.type === 'collection' && plan.requests[0]!.name).toBe('Ping');
    });

    it('converts a Postman v2.1 collection with folders, bodies and auth', () => {
        const postman = {
            info: {
                name: 'Shop',
                schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
            },
            auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{token}}' }] },
            variable: [{ key: 'host', value: 'https://shop.test' }],
            item: [
                {
                    name: 'Orders',
                    item: [
                        {
                            name: 'Get order',
                            request: {
                                method: 'GET',
                                url: {
                                    raw: '{{host}}/orders/:id',
                                    variable: [{ key: 'id', value: '' }],
                                },
                            },
                        },
                        {
                            name: 'Create order',
                            request: {
                                method: 'POST',
                                header: [{ key: 'X-Trace', value: '1', disabled: true }],
                                body: {
                                    mode: 'raw',
                                    raw: '{"qty":1}',
                                    options: { raw: { language: 'json' } },
                                },
                                url: '{{host}}/orders',
                            },
                        },
                    ],
                },
            ],
        };
        const plan = parseImportSource('shop.postman_collection.json', JSON.stringify(postman));
        if (plan.type !== 'collection') throw new Error('expected a collection');
        expect(plan.collection.auth).toEqual({
            type: 'bearer',
            token: '{{token}}',
            prefix: 'Bearer',
        });
        expect(plan.folders.map((folder) => folder.name)).toEqual(['Orders']);
        expect(plan.requests[0]!.url).toBe('{{host}}/orders/:id');
        expect(plan.requests[0]!.pathVariables).toMatchObject([{ key: 'id', value: '' }]);
        expect(plan.requests[1]!.headers[0]!.enabled).toBe(false);
        expect(plan.requests[1]!.body.json).toBe('{\n    "qty": 1\n}');
        expect(plan.environment).toEqual({
            name: 'Shop',
            variables: [{ key: 'host', value: 'https://shop.test', enabled: true, secret: false }],
        });
    });

    it('detects environments from Postman exports and .env files', () => {
        const postman = parseImportSource(
            'staging.postman_environment.json',
            JSON.stringify({
                name: 'Staging',
                _postman_variable_scope: 'environment',
                values: [
                    { key: 'base_url', value: 'https://staging.test', enabled: true },
                    { key: 'token', value: 'abc', type: 'secret', enabled: true },
                ],
            }),
        );
        expect(postman).toMatchObject({
            type: 'environment',
            environment: {
                name: 'Staging',
                variables: [{ key: 'base_url' }, { key: 'token', secret: true }],
            },
        });
        const dotenv = parseImportSource(
            '.env.production',
            '# comment\nexport API_URL="https://x.test"\nDEBUG=false # inline\n',
        );
        expect(dotenv).toMatchObject({
            type: 'environment',
            environment: {
                name: 'production',
                variables: [
                    { key: 'API_URL', value: 'https://x.test' },
                    { key: 'DEBUG', value: 'false' },
                ],
            },
        });
    });

    it('explains why a file cannot be imported', () => {
        expect(() => parseImportSource('broken.json', '{"openapi": "3.0.0",')).toThrow(
            'not valid JSON',
        );
        expect(() =>
            parseImportSource('old.json', JSON.stringify({ swagger: '1.2', info: {}, paths: {} })),
        ).toThrow('version “1.2” is not supported');
        expect(() =>
            parseImportSource(
                'nopaths.json',
                JSON.stringify({ openapi: '3.0.0', info: { title: 'x' } }),
            ),
        ).toThrow('no “paths” section');
        expect(() => parseImportSource('other.json', JSON.stringify({ hello: 'world' }))).toThrow(
            'not in a supported format',
        );
        expect(() => parseImportSource('empty.json', '   ')).toThrow('empty');
        expect(() => parseImportSource('bad.env', 'not a pair')).toThrow('Line 1');
    });
});

describe('applying imports', () => {
    it('creates, merges, replaces or copies an environment by name', () => {
        const workspace = createWorkspace('W');
        const created = applyEnvironment(
            workspace,
            { name: 'Dev', variables: [{ key: 'a', value: '1', enabled: true, secret: false }] },
            'merge',
        );
        expect(created.message).toBe('Created environment “Dev” with 1 variable');
        // No environment is selected on its own: one is only active through a link or a choice.
        expect(created.workspace.activeEnvironmentId).toBeNull();

        const incoming = {
            name: 'dev',
            variables: [
                { key: 'a', value: '2', enabled: true, secret: false },
                { key: 'b', value: '3', enabled: true, secret: false },
            ],
        };
        const merged = applyEnvironment(created.workspace, incoming, 'merge');
        expect(merged.workspace.environments).toHaveLength(1);
        expect(merged.environment.variables.map((item) => `${item.key}=${item.value}`)).toEqual([
            'a=2',
            'b=3',
        ]);
        expect(merged.message).toBe('Merged into environment “Dev”: 1 added, 1 updated');

        const replaced = applyEnvironment(
            created.workspace,
            { name: 'Dev', variables: [] },
            'replace',
        );
        expect(replaced.environment.variables).toEqual([]);

        const copied = applyEnvironment(created.workspace, incoming, 'copy');
        expect(copied.workspace.environments.map((item) => item.name)).toEqual(['Dev', 'dev (2)']);
    });

    it('adds an imported collection to the workspace', () => {
        const plan = parseImportSource('pets.json', JSON.stringify(openApi));
        const result = applyImportPlan(createWorkspace('W'), plan, 'merge');
        expect(result.kind).toBe('collection');
        expect(result.workspace.collections).toHaveLength(1);
        expect(result.workspace.requests).toHaveLength(4);
        expect(result.workspace.environments.map((item) => item.name)).toEqual(['Pets']);
        expect(result.message).toMatch(
            /^Collection “Pets” with 4 requests in 1 folder; created environment/,
        );
    });

    it('imports every valid file and reports the rest', async () => {
        let workspace = createWorkspace('W');
        const progress: string[] = [];
        const results = await importFiles(
            [
                file('api/pets.json', JSON.stringify(openApi)),
                file('api/broken.json', '{'),
                file('api/readme.md', '# notes'),
                file('api/.env', 'TOKEN=1'),
            ],
            (plan) => {
                const applied = applyImportPlan(workspace, plan, 'merge');
                workspace = applied.workspace;
                return applied.message;
            },
            ({ done, total, current }) => progress.push(`${done}/${total} ${current ?? 'done'}`),
        );
        expect(results.map((result) => [result.path, result.status])).toEqual([
            ['api/pets.json', 'imported'],
            ['api/broken.json', 'failed'],
            ['api/readme.md', 'skipped'],
            ['api/.env', 'imported'],
        ]);
        expect(results[1]!.message).toMatch(/not valid JSON/);
        expect(progress[0]).toBe('0/4 api/pets.json');
        expect(progress.at(-1)).toBe('4/4 done');
        expect(workspace.environments.map((item) => item.name)).toEqual(['Pets', 'Environment']);
    });
});
