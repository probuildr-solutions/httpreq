/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { describe, expect, it } from 'vitest';
import {
    createEmptyRequest,
    createEnvironment,
    type HttpResponse,
    type ScriptRunInput,
} from '@httpreq/shared';
import { QuickJsScriptEngine } from './quickjs';
import { environmentToRecord, ScriptSession } from './runner';

const engine = new QuickJsScriptEngine({ timeoutMs: 400 });

const input = (code: string, patch: Partial<ScriptRunInput> = {}): ScriptRunInput => ({
    stage: 'preRequest',
    code,
    request: {
        method: 'POST',
        url: 'https://api.example.com/items',
        headers: { Accept: 'application/json' },
        body: '{"a":1}',
        bodyEditable: true,
    },
    environment: { token: 'abc' },
    variables: {},
    ...patch,
});

const response = (body: string, status = 200): HttpResponse => ({
    status,
    statusText: 'OK',
    headers: { 'Content-Type': 'application/json' },
    body,
    contentType: 'application/json',
    durationMs: 12,
    sizeBytes: body.length,
});

describe('script engine', () => {
    it('lets a pre-request script change the request and the environment', async () => {
        const result = await engine.run(
            input(`
                httpreq.request.headers.set('X-Token', httpreq.environment.get('token'));
                httpreq.request.headers.remove('accept');
                httpreq.request.url = httpreq.request.url + '?v=2';
                httpreq.request.method = 'PUT';
                httpreq.request.body = JSON.stringify({ signed: true });
                httpreq.environment.set('last', 'yes');
                httpreq.variables.set('tmp', '1');
                console.log('hello', { a: 1 });
            `),
        );
        expect(result.ok).toBe(true);
        expect(result.request).toMatchObject({
            method: 'PUT',
            url: 'https://api.example.com/items?v=2',
            headers: { 'X-Token': 'abc' },
            body: '{"signed":true}',
        });
        expect(result.environment).toEqual({ token: 'abc', last: 'yes' });
        expect(result.variables).toEqual({ tmp: '1' });
        expect(result.logs).toEqual([{ level: 'log', message: 'hello {"a":1}' }]);
    });

    it('records passing and failing tests without stopping at the first failure', async () => {
        const result = await engine.run(
            input(
                `
                const body = httpreq.response.json();
                test('status is 200', () => expect(httpreq.response.status).to.equal(200));
                test('has an id', () => expect(body).to.have.property('id', 7));
                test('wrong on purpose', () => expect(body.name).to.equal('nope'));
                test('negation', () => expect([1, 2]).to.not.include(3));
                test('deep', () => expect({ a: [1, { b: 2 }] }).to.eql({ a: [1, { b: 2 }] }));
            `,
                {
                    stage: 'tests',
                    response: {
                        status: 200,
                        statusText: 'OK',
                        headers: {},
                        body: '{"id":7,"name":"widget"}',
                        durationMs: 1,
                        sizeBytes: 24,
                    },
                },
            ),
        );
        expect(result.ok).toBe(true);
        expect(result.tests.map((t) => [t.name, t.passed])).toEqual([
            ['status is 200', true],
            ['has an id', true],
            ['wrong on purpose', false],
            ['negation', true],
            ['deep', true],
        ]);
        expect(result.tests[2]!.error).toContain('to equal "nope"');
    });

    it('reports an exception and keeps what ran before it', async () => {
        const result = await engine.run(input(`console.log('before'); throw new Error('boom');`));
        expect(result.ok).toBe(false);
        expect(result.error).toMatchObject({ name: 'Error', message: 'boom' });
        expect(result.logs).toEqual([{ level: 'log', message: 'before' }]);
    });

    it('reports a syntax error', async () => {
        const result = await engine.run(input('let = ;'));
        expect(result.ok).toBe(false);
        expect(result.error?.name).toBe('SyntaxError');
    });

    it('stops an endless loop at the deadline', async () => {
        const started = Date.now();
        const result = await engine.run(input('while (true) {}'));
        expect(result.ok).toBe(false);
        expect(result.error?.name).toBe('TimeoutError');
        expect(Date.now() - started).toBeLessThan(3000);
    });

    it('stops a script that exhausts memory', async () => {
        const small = new QuickJsScriptEngine({ memoryBytes: 2 * 1024 * 1024, timeoutMs: 2000 });
        const result = await small.run(
            input('const a = []; while (true) a.push(new Array(10000).fill(1));'),
        );
        expect(result.ok).toBe(false);
        expect(['MemoryError', 'TimeoutError']).toContain(result.error?.name);
    });

    it('stops runaway recursion instead of crashing the host', async () => {
        const result = await engine.run(input('function f() { return f() + 1; } f();'));
        expect(result.ok).toBe(false);
        expect(result.error?.message).toMatch(/call stack/);
        // The interpreter that overflowed is discarded; the next run is unaffected.
        const next = await engine.run(input('1'));
        expect(next.ok).toBe(true);
    });

    it('has no access to the host: no network, files, Electron, Node or the page', async () => {
        const result = await engine.run(
            input(`
                const names = ['fetch', 'XMLHttpRequest', 'WebSocket', 'require', 'process', 'window',
                    'document', 'localStorage', 'indexedDB', 'Worker', 'importScripts', 'setTimeout',
                    'setInterval', 'Buffer', 'module', 'electron', 'httpreq_bridge'];
                const present = names.filter((name) => typeof globalThis[name] !== 'undefined');
                test('no host globals', () => expect(present).to.eql([]));
                test('no host through the Function constructor', () => {
                    const g = (function () { return this; }).constructor('return typeof process')();
                    expect(g).to.equal('undefined');
                });
                `),
        );
        expect(result.ok).toBe(true);
        expect(result.tests[0]).toEqual({ name: 'no host globals', passed: true });
        expect(result.tests[1]?.passed).toBe(true);
    });

    it('cannot read its own input back or leak between runs', async () => {
        await engine.run(input(`globalThis.leaked = 'secret-from-run-1';`));
        const second = await engine.run(
            input(`test('fresh', () => expect(typeof globalThis.leaked).to.equal('undefined'));
                   test('input is gone', () => expect(typeof __input).to.equal('undefined'));`),
        );
        expect(second.tests.every((t) => t.passed)).toBe(true);
    });

    it('refuses an unreadable result instead of trusting it', async () => {
        const result = await engine.run(input(`globalThis.__finish = () => '{"request":1}';`));
        expect(result.ok).toBe(false);
        expect(result.error?.message).toMatch(/unreadable/);
    });

    it('does not replace a body that cannot be edited', async () => {
        const result = await engine.run(
            input(`httpreq.request.body = 'changed';`, {
                request: {
                    method: 'POST',
                    url: 'https://x.test',
                    headers: {},
                    body: null,
                    bodyEditable: false,
                },
            }),
        );
        expect(result.ok).toBe(true);
        expect(result.request.body).toBeNull();
    });

    it('rejects header names and values that could inject headers', async () => {
        const result = await engine.run(
            input(`httpreq.request.headers.set('X-A', 'a\\r\\nX-B: b');`),
        );
        expect(result.ok).toBe(false);
        expect(result.error?.message).toMatch(/line breaks/);
    });

    it('offers pure helpers for encoding and signing', async () => {
        const result = await engine.run(
            input(`
                test('base64', () => {
                    expect(httpreq.utils.base64Encode('héllo')).to.equal('aMOpbGxv');
                    expect(httpreq.utils.base64Decode('aMOpbGxv')).to.equal('héllo');
                });
                test('sha256', () => expect(httpreq.utils.sha256Hex('abc'))
                    .to.equal('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'));
                test('hmac', () => expect(httpreq.utils.hmacSha256Hex('key', 'The quick brown fox jumps over the lazy dog'))
                    .to.equal('f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8'));
            `),
        );
        expect(result.tests).toEqual([
            { name: 'base64', passed: true },
            { name: 'sha256', passed: true },
            { name: 'hmac', passed: true },
        ]);
    });

    it('fails closed when the interpreter cannot be loaded', async () => {
        const broken = new QuickJsScriptEngine({}, () => Promise.reject(new Error('no wasm')));
        const result = await broken.run(input('1'));
        expect(result.ok).toBe(false);
        expect(result.error?.name).toBe('SandboxUnavailable');
    });

    it('rejects an oversized script', async () => {
        const result = await engine.run(input('//'.padEnd(300_000, 'x')));
        expect(result.ok).toBe(false);
        expect(result.error?.message).toMatch(/256 KB/);
    });
});

describe('script session', () => {
    const request = (scripts: Partial<ReturnType<typeof createEmptyRequest>['scripts']>) => ({
        ...createEmptyRequest(),
        url: 'https://example.com',
        scripts: { preRequest: '', postResponse: '', tests: '', ...scripts },
    });

    it('applies the pre-request result to the request view', async () => {
        const environment = { ...createEnvironment('Dev'), variables: [] };
        const session = new ScriptSession(engine, environment);
        const view = {
            method: 'GET',
            url: 'https://example.com',
            headers: {},
            body: null,
            bodyEditable: true,
        };
        await session.preRequest(
            view,
            request({ preRequest: `httpreq.request.headers.set('X-Run', '1');` }),
        );
        expect(view.headers).toEqual({ 'X-Run': '1' });
    });

    it('stops the send when a pre-request script fails', async () => {
        const session = new ScriptSession(engine, null);
        const view = {
            method: 'GET',
            url: 'https://example.com',
            headers: {},
            body: null,
            bodyEditable: true,
        };
        await expect(
            session.preRequest(view, request({ preRequest: 'throw new Error("nope")' })),
        ).rejects.toThrow(/pre-request script failed: nope/);
    });

    it('runs post-response then tests, sharing state, and reports environment changes', async () => {
        const environment = createEnvironment('Dev');
        environment.variables.push({
            id: '1',
            key: 'token',
            value: 'old',
            enabled: true,
            secret: false,
        });
        environment.variables.push({
            id: '2',
            key: 'gone',
            value: 'x',
            enabled: true,
            secret: false,
        });
        const session = new ScriptSession(engine, environment);
        await session.postResponse(
            response('{"token":"new"}'),
            request({
                postResponse: `
                    httpreq.environment.set('token', httpreq.response.json().token);
                    httpreq.environment.unset('gone');
                    httpreq.variables.set('seen', 'yes');
                `,
                tests: `test('token stored', () => {
                    expect(httpreq.environment.get('token')).to.equal('new');
                    expect(httpreq.variables.get('seen')).to.equal('yes');
                });`,
            }),
        );
        const report = session.report();
        expect(report.stages.map((s) => [s.stage, s.ok])).toEqual([
            ['postResponse', true],
            ['tests', true],
        ]);
        expect(report.tests).toEqual([{ name: 'token stored', passed: true }]);
        expect(report.environmentChanges).toEqual({ set: { token: 'new' }, unset: ['gone'] });
    });

    it('reports a failing post-response script without throwing', async () => {
        const session = new ScriptSession(engine, null);
        await session.postResponse(response('x'), request({ postResponse: 'null.x' }));
        expect(session.report().stages[0]).toMatchObject({ stage: 'postResponse', ok: false });
    });

    it('exposes only enabled environment variables', () => {
        const environment = createEnvironment('Dev');
        environment.variables.push(
            { id: '1', key: 'a', value: '1', enabled: true, secret: false },
            { id: '2', key: 'b', value: '2', enabled: false, secret: false },
        );
        expect(environmentToRecord(environment)).toEqual({ a: '1' });
    });
});
