/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { describe, expect, it } from 'vitest';
import {
    createEmptyRequest,
    createEnvironment,
    createGrpcConfig,
    createMqttConfig,
    createSoapConfig,
    type CodegenRequest,
    type HttpCodegenRequest,
    type HttpRequest,
} from '@httpreq/shared';
import { createWorkspace } from '@httpreq/workspace';
import type { PipelineContext } from '@httpreq/api-client';
import {
    buildCodegenRequest,
    CodeGeneratorRegistry,
    createDefaultCodegenRegistry,
    defaultCodegen,
    generateCodeForRequest,
} from './index';
import { UnsupportedCombination } from './errors';

const environment = createEnvironment('Dev');
environment.variables.push(
    { id: '1', key: 'host', value: 'https://api.example.com', enabled: true, secret: false },
    { id: '2', key: 'api_secret', value: 's3cr3t-value', enabled: true, secret: true },
);

const context = (): PipelineContext => ({ workspace: createWorkspace('Test'), environment });

const postJson = (patch: Partial<HttpRequest> = {}): HttpRequest => ({
    ...createEmptyRequest(),
    method: 'POST',
    url: '{{host}}/users?active=true',
    headers: [
        { id: 'h1', key: 'Accept', value: 'application/json', enabled: true },
        { id: 'h2', key: 'X-Trace', value: 'it\'s "quoted"', enabled: true },
    ],
    body: {
        ...createEmptyRequest().body,
        mode: 'json',
        json: '{"name":"Ada","note":"line1\\nline2","token":"{{api_secret}}"}',
    },
    ...patch,
});

const PROTO = `syntax = "proto3"; package acme; service Svc { rpc Get (Req) returns (Res); rpc Watch (Req) returns (stream Res); }
message Req { string id = 1; } message Res { string name = 1; }`;

describe('building a codegen request', () => {
    it('resolves variables, authorization and the body like a real send', async () => {
        const request = postJson({
            auth: { type: 'bearer', token: 'tok-123456', prefix: 'Bearer' },
        });
        const input = (await buildCodegenRequest(request, context(), {
            includeSecrets: true,
        })) as HttpCodegenRequest;
        expect(input).toMatchObject({
            protocol: 'http',
            method: 'POST',
            url: 'https://api.example.com/users?active=true',
        });
        expect(input.headers).toContainEqual({ name: 'Authorization', value: 'Bearer tok-123456' });
        expect(input.body).toMatchObject({ kind: 'text' });
    });

    it('replaces secrets with a placeholder by default, by name and by value', async () => {
        const request = postJson({
            auth: { type: 'basic', username: 'ada', password: 'hunter2hunter2' },
            headers: [
                { id: 'h1', key: 'X-Session', value: 'abcdef123456', enabled: true, secret: true },
                { id: 'h2', key: 'Cookie', value: 'sid=zzz', enabled: true },
            ],
        });
        const input = (await buildCodegenRequest(request, context())) as HttpCodegenRequest;
        const text = JSON.stringify(input);
        expect(text).not.toContain('hunter2');
        expect(text).not.toContain('s3cr3t-value');
        expect(text).not.toContain('abcdef123456');
        expect(text).not.toContain('sid=zzz');
        expect(input.headers.find((h) => h.name === 'Authorization')?.value).toBe('Basic <SECRET>');
        expect((input.body as { text: string }).text).toContain('<SECRET>');
    });

    it('redacts API keys sent in the query string', async () => {
        const request = postJson({
            url: 'https://api.example.com/x?other=1',
            auth: { type: 'api-key', key: 'api_key', value: 'key-value-1234', location: 'query' },
        });
        const input = (await buildCodegenRequest(request, context())) as HttpCodegenRequest;
        expect(input.url).not.toContain('key-value-1234');
        expect(input.url).toContain('api_key=<SECRET>');
        expect(input.url).toContain('other=1');
    });

    it('includes secrets only when asked to', async () => {
        const request = postJson({
            auth: { type: 'bearer', token: 'tok-123456', prefix: 'Bearer' },
        });
        const input = (await buildCodegenRequest(request, context(), {
            includeSecrets: true,
        })) as HttpCodegenRequest;
        expect(JSON.stringify(input)).toContain('tok-123456');
        expect(JSON.stringify(input)).toContain('s3cr3t-value');
    });

    it('splits a form body into fields', async () => {
        const request = postJson({
            body: {
                ...createEmptyRequest().body,
                mode: 'form-urlencoded',
                formUrlEncoded: [{ id: 'f', key: 'a b', value: 'c&d', enabled: true }],
            },
        });
        const input = (await buildCodegenRequest(request, context())) as HttpCodegenRequest;
        expect(input.body).toEqual({ kind: 'form', fields: [{ name: 'a b', value: 'c&d' }] });
    });

    it('does not run scripts', async () => {
        let ran = false;
        const scripts = {
            preRequest: () => {
                ran = true;
            },
        };
        await buildCodegenRequest(postJson(), { ...context(), scripts });
        expect(ran).toBe(false);
    });

    it('maps SOAP to its HTTP form', async () => {
        const request: HttpRequest = {
            ...createEmptyRequest(),
            protocol: 'soap',
            url: 'https://example.com/svc',
            soap: { ...createSoapConfig(), action: 'urn:Do' },
            body: { ...createEmptyRequest().body, text: '<Do/>' },
        };
        const input = (await buildCodegenRequest(request, context())) as HttpCodegenRequest;
        expect(input.protocol).toBe('soap');
        expect(input.method).toBe('POST');
        expect(input.headers).toContainEqual({ name: 'SOAPAction', value: '"urn:Do"' });
    });
});

const http = async (patch: Partial<HttpRequest> = {}) =>
    (await buildCodegenRequest(postJson(patch), context())) as HttpCodegenRequest;

describe('HTTP generators', () => {
    const registry = createDefaultCodegenRegistry();
    const expectations: Record<string, RegExp[]> = {
        curl: [
            /curl --request POST \\\n {2}--url 'https:\/\/api\.example\.com\/users\?active=true'/,
            /--header 'Accept: application\/json'/,
            /--data-raw/,
        ],
        'javascript-fetch': [
            /await fetch\("https:\/\/api\.example\.com\/users\?active=true"/,
            /method: "POST"/,
            /body: JSON\.stringify\(\{/,
        ],
        'typescript-fetch': [/const options: RequestInit = \{/, /await fetch\(url, options\)/],
        'node-axios': [/axios\.request/, /method: "post"/, /data: \{/],
        'python-requests': [/import requests/, /requests\.post\(/, /json=payload/],
        'java-httpclient': [
            /HttpClient\.newBuilder/,
            /\.method\("POST", BodyPublishers\.ofString\(/,
        ],
        'csharp-httpclient': [/new HttpClient\(/, /HttpMethod\.Post/, /new StringContent\(/],
        'go-nethttp': [/http\.NewRequest\(http\.MethodPost/, /strings\.NewReader/, /\.Do\(req\)/],
        'php-curl': [/curl_init\(\)/, /CURLOPT_CUSTOMREQUEST => 'POST'/, /CURLOPT_POSTFIELDS/],
        'ruby-nethttp': [/Net::HTTP::Post\.new/, /request\.body = /],
        powershell: [/Invoke-RestMethod/, /Method\s+= 'POST'/, /Body\s+= \$body/],
        'swift-urlsession': [/URLRequest\(url:/, /httpMethod = "POST"/, /httpBody/],
    };

    it.each(Object.entries(expectations))(
        '%s generates a faithful request',
        async (id, patterns) => {
            const result = registry.generate(await http(), id);
            expect(result.supported).toBe(true);
            const code = result.supported ? result.code : '';
            for (const pattern of patterns) expect(code).toMatch(pattern);
            // The secret is a placeholder in every language.
            expect(code).not.toContain('s3cr3t-value');
            expect(code).toContain('<SECRET>');
        },
    );

    it('lists generators for every language the task names', () => {
        const languages = new Set(registry.forProtocol('http').map((g) => g.language));
        for (const language of ['Shell', 'Java', 'JavaScript', 'Python', 'C#', 'Go']) {
            expect(languages).toContain(language);
        }
    });

    it('escapes quotes safely in each language', async () => {
        const input = await http();
        const curl = registry.generate(input, 'curl');
        expect(curl.supported && curl.code).toContain(`'X-Trace: it'\\''s "quoted"'`);
        const py = registry.generate(input, 'python-requests');
        expect(py.supported && py.code).toContain('"it\'s \\"quoted\\""');
        const php = registry.generate(input, 'php-curl');
        expect(php.supported && php.code).toContain(`'X-Trace: it\\'s "quoted"'`);
        const ps = registry.generate(input, 'powershell');
        expect(ps.supported && ps.code).toContain(`'it''s "quoted"'`);
    });

    it('does not send a body with GET', async () => {
        const input = await http({ method: 'GET' });
        const fetchCode = registry.generate(input, 'javascript-fetch');
        expect(fetchCode.supported && fetchCode.code).not.toContain('body:');
    });

    it('reflects redirect, TLS and timeout settings', async () => {
        const request = postJson();
        request.settings = {
            ...request.settings,
            followRedirects: false,
            verifyTls: false,
            timeoutMs: 5000,
        };
        const input = (await buildCodegenRequest(request, context())) as HttpCodegenRequest;
        const curl = registry.generate(input, 'curl');
        expect(curl.supported && curl.code).toContain('--insecure');
        expect(curl.supported && curl.code).not.toContain('--location');
        expect(curl.supported && curl.code).toContain('--max-time 5');
        const python = registry.generate(input, 'python-requests');
        expect(python.supported && python.code).toMatch(
            /allow_redirects=False[\s\S]*verify=False[\s\S]*timeout=5/,
        );
    });

    it('generates code with real credentials only on request', async () => {
        const request = postJson({
            auth: { type: 'bearer', token: 'tok-123456', prefix: 'Bearer' },
        });
        const result = await generateCodeForRequest(request, context(), 'curl', {
            includeSecrets: true,
        });
        expect(result.supported && result.code).toContain('Bearer tok-123456');
        const masked = await generateCodeForRequest(request, context(), 'curl');
        expect(masked.supported && masked.code).not.toContain('tok-123456');
    });

    it('turns a request that cannot be built into a clear reason', async () => {
        const result = await generateCodeForRequest(
            { ...createEmptyRequest(), url: '' },
            context(),
            'curl',
        );
        expect(result).toEqual({
            supported: false,
            reason: expect.stringContaining('Enter a URL'),
        });
    });
});

const grpcRequest = (patch: Partial<HttpRequest> = {}): HttpRequest => ({
    ...createEmptyRequest(),
    protocol: 'grpc',
    url: 'grpcs://api.example.com:443',
    grpc: {
        ...createGrpcConfig(),
        protoFiles: [{ name: 'svc.proto', content: PROTO }],
        service: 'acme.Svc',
        method: 'Get',
    },
    body: { ...createEmptyRequest().body, mode: 'json', json: '{"id":"1"}' },
    auth: { type: 'bearer', token: 'grpc-token-123', prefix: 'Bearer' },
    ...patch,
});

describe('gRPC generators', () => {
    it('generates grpcurl and Node.js, with metadata and without the token', async () => {
        const input = await buildCodegenRequest(grpcRequest(), context());
        const curl = defaultCodegen.generate(input, 'grpcurl');
        expect(curl.supported && curl.code).toMatch(
            /grpcurl[\s\S]*-proto 'svc\.proto'[\s\S]*'api\.example\.com:443'[\s\S]*'acme\.Svc\/Get'/,
        );
        expect(curl.supported && curl.code).toContain('authorization: Bearer <SECRET>');
        expect(curl.supported && curl.code).not.toContain('grpc-token-123');
        const node = defaultCodegen.generate(input, 'node-grpc');
        expect(node.supported && node.code).toContain('loadPackageDefinition(definition).acme.Svc');
        expect(node.supported && node.code).toContain('client.Get(message, metadata, options');
    });

    it('uses a stream handler for server-streaming methods', async () => {
        const request = grpcRequest();
        request.grpc!.method = 'Watch';
        const node = defaultCodegen.generate(
            await buildCodegenRequest(request, context()),
            'node-grpc',
        );
        expect(node.supported && node.code).toContain('call.on("data"');
    });

    it('says clearly when a language has no gRPC generator', async () => {
        const input = await buildCodegenRequest(grpcRequest(), context());
        const result = defaultCodegen.generate(input, 'python-requests');
        expect(result.supported).toBe(false);
        expect(!result.supported && result.reason).toMatch(
            /cannot generate code for gRPC.*grpcurl/,
        );
    });
});

describe('MQTT generators', () => {
    const mqttRequest = (patch: Partial<HttpRequest> = {}): HttpRequest => {
        const config = createMqttConfig();
        config.publishTopic = 'sensors/1';
        config.publishQos = 1;
        config.subscriptions = [{ id: 's', topic: 'cmd/#', qos: 1, enabled: true }];
        return {
            ...createEmptyRequest(),
            protocol: 'mqtt',
            url: 'mqtts://broker.example.com',
            mqtt: config,
            auth: { type: 'basic', username: 'ada', password: 'broker-pass-1' },
            body: { ...createEmptyRequest().body, text: 'hello' },
            ...patch,
        };
    };

    it('generates Mosquitto, Node.js and Python without the password', async () => {
        const input = await buildCodegenRequest(mqttRequest(), context());
        for (const id of ['mosquitto', 'node-mqtt', 'python-paho']) {
            const result = defaultCodegen.generate(input, id);
            expect(result.supported).toBe(true);
            const code = result.supported ? result.code : '';
            expect(code).not.toContain('broker-pass-1');
            expect(code).toContain('<SECRET>');
            expect(code).toContain('sensors/1');
            expect(code).toContain('cmd/#');
        }
        const mosquitto = defaultCodegen.generate(input, 'mosquitto');
        expect(mosquitto.supported && mosquitto.code).toMatch(
            /mosquitto_sub \\\n {2}-h 'broker\.example\.com' \\\n {2}-p 8883/,
        );
    });

    it('never embeds certificate contents', async () => {
        const request = mqttRequest();
        request.mqtt!.tls.clientKey =
            '-----BEGIN PRIVATE KEY-----\nSECRETKEY\n-----END PRIVATE KEY-----';
        request.mqtt!.tls.clientCertificate =
            '-----BEGIN CERTIFICATE-----\nCERT\n-----END CERTIFICATE-----';
        const input = await buildCodegenRequest(request, context());
        const node = defaultCodegen.generate(input, 'node-mqtt');
        expect(node.supported && node.code).toContain('fs.readFileSync("client.key")');
        expect(node.supported && node.code).not.toContain('SECRETKEY');
    });

    it('reports a combination a generator cannot express', async () => {
        const input = await buildCodegenRequest(
            mqttRequest({ url: 'wss://broker.example.com/mqtt' }),
            context(),
        );
        const result = defaultCodegen.generate(input, 'mosquitto');
        expect(result).toEqual({ supported: false, reason: expect.stringContaining('WebSockets') });
        expect(defaultCodegen.generate(input, 'python-paho').supported).toBe(true);
    });
});

describe('the registry', () => {
    const fake = {
        id: 'fake',
        label: 'Fake',
        language: 'Fake',
        editorLanguage: 'plaintext',
        fileExtension: 'txt',
        protocols: ['http'] as const,
        generate: () => 'fake code',
    };

    it('accepts new generators without changes to the existing ones', async () => {
        const registry = createDefaultCodegenRegistry().register(fake);
        const result = registry.generate(await http(), 'fake');
        expect(result).toEqual({ supported: true, code: 'fake code' });
    });

    it('rejects a duplicate id and an unknown generator', async () => {
        const registry = new CodeGeneratorRegistry().register(fake);
        expect(() => registry.register(fake)).toThrow(/already registered/);
        const unknown = registry.generate(await http(), 'nope');
        expect(unknown.supported).toBe(false);
    });

    it('turns an UnsupportedCombination into an unsupported result and rethrows other errors', async () => {
        const registry = new CodeGeneratorRegistry()
            .register({
                ...fake,
                id: 'picky',
                generate: () => {
                    throw new UnsupportedCombination('not today');
                },
            })
            .register({
                ...fake,
                id: 'broken',
                generate: () => {
                    throw new Error('bug');
                },
            });
        const input: CodegenRequest = await http();
        expect(registry.generate(input, 'picky')).toEqual({
            supported: false,
            reason: 'not today',
        });
        expect(() => registry.generate(input, 'broken')).toThrow('bug');
    });
});
