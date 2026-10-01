/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { describe, expect, it } from 'vitest';
import { createEmptyRequest, type HttpRequest } from '@httpreq/shared';
import { QuickJsScriptEngine } from '@httpreq/scripting';
import { collectJsonKeys, propertyNameAt } from './jsonKeys';
import { firstJsonError, jsonDiagnostics, lineAndColumn } from './jsonDiagnostics';
import {
    formValueSuggestions,
    headerValueSuggestions,
    pathVariableSuggestions,
    queryValueSuggestions,
} from './requestHints';
import { API_TYPES, GLOBALS, membersOf, signatureOf } from './scriptApi';
import { callSiteAt, memberAccessAt, memberAt, resolveType } from './scriptContext';
import { matchNames, previewValue, variableAt, variablesIn, variableTrigger } from './variables';
import { elementNames, elementToClose, openElements } from './xml';

const errors = (text: string) => jsonDiagnostics(text).filter((d) => d.severity === 'error');

describe('JSON diagnostics', () => {
    it('accepts valid JSON of every shape, and an empty body', () => {
        for (const text of [
            '',
            '   ',
            '{}',
            '[]',
            '{"a":1,"b":[true,false,null,"x\\n\\u00e9"],"c":{"d":-1.5e+3}}',
            '"just a string"',
            '42',
            '[1,\n 2,\n 3]',
        ]) {
            expect(jsonDiagnostics(text), text).toEqual([]);
        }
    });

    it('accepts {{variables}} as a value and inside strings', () => {
        expect(
            jsonDiagnostics('{"id": {{user_id}}, "name": "{{name}}", "tags": [{{a}}, {{b}}]}'),
        ).toEqual([]);
        expect(jsonDiagnostics('{{payload}}')).toEqual([]);
        expect(jsonDiagnostics('{ "token": "Bearer {{token}}" }')).toEqual([]);
    });

    it.each([
        ['{"a":1,}', /trailing comma/i, 6],
        ['[1,2,]', /trailing comma/i, 4],
        ['{"a":1 "b":2}', /Expected ',' or '}'/, 7],
        ['{"a" 1}', /':' after the property name/, 5],
        ['{a: 1}', /Property names must be in double quotes/, 1],
        ["{'a': 1}", /double quotes/, 1],
        ['{"a": undefined}', /“undefined” is not valid/, 6],
        ['{"a": 01}', /Expected ',' or '}'/, 7],
        ['{"a": "x', /not closed/, 6],
        ['{"a": 1', /never closed/, 0],
        ['[1, 2', /never closed/, 0],
        ['{"a":', /ends unexpectedly/, 4],
        ['{"a": 1} extra', /after the end/, 9],
        ['{"a": 1 // note\n}', /Comments are not allowed/, 8],
        ['{"a": "\\q"}', /Invalid escape/, 7],
        ['{"a": "\\u12"}', /four hexadecimal/, 7],
    ])('reports %j', (text, message, offset) => {
        const [error] = errors(text);
        expect(error?.message).toMatch(message);
        expect(error?.offset).toBe(offset);
    });

    it('warns about duplicate keys without calling the body invalid', () => {
        const diagnostics = jsonDiagnostics('{"a":1,"a":2}');
        expect(diagnostics).toEqual([
            expect.objectContaining({
                severity: 'warning',
                offset: 7,
                message: expect.stringContaining('Duplicate key "a"'),
            }),
        ]);
        expect(firstJsonError('{"a":1,"a":2}')).toBeNull();
    });

    it('describes the first error with its line and column', () => {
        expect(firstJsonError('{\n    "a": 1,\n    "b": }\n}')).toBe(
            'Expected a value. (line 3, column 10)',
        );
        expect(lineAndColumn('ab\ncd', 4)).toEqual({ line: 2, column: 2 });
        expect(firstJsonError('{"ok": true}')).toBeNull();
    });
});

describe('variable context', () => {
    it('finds an unfinished {{name before the cursor and the range to replace', () => {
        expect(variableTrigger('{"id": {{us', 11)).toEqual({
            query: 'us',
            start: 9,
            end: 11,
            closed: false,
        });
        expect(variableTrigger('{{ us', 5)).toEqual({
            query: 'us',
            start: 3,
            end: 5,
            closed: false,
        });
        expect(variableTrigger('x {{', 4)).toEqual({ query: '', start: 4, end: 4, closed: false });
        // An auto-closed `}}` after the cursor is part of what gets replaced.
        expect(variableTrigger('{{us}}', 4)).toEqual({
            query: 'us',
            start: 2,
            end: 6,
            closed: true,
        });
        expect(variableTrigger('{{user_id}} x', 13)).toBeNull();
        expect(variableTrigger('plain text', 5)).toBeNull();
    });

    it('finds the variable under the cursor and every variable in a text', () => {
        expect(variableAt('a {{host}} b', 5)).toEqual({ name: 'host', start: 2, end: 10 });
        expect(variableAt('a {{host}} b', 11)).toBeNull();
        expect(variablesIn('{{a}} and {{b}}').map((v) => v.name)).toEqual(['a', 'b']);
    });

    it('ranks names that start with the query first and never shows a secret', () => {
        expect(matchNames(['base_url', 'user_id', 'url_suffix', 'token'], 'url')).toEqual([
            'url_suffix',
            'base_url',
        ]);
        expect(matchNames(['a', 'b'], '')).toEqual(['a', 'b']);
        const definition = { name: 't', value: 'abc', secret: true, source: 'Dev', dynamic: false };
        expect(previewValue(definition)).toBe('••••••••');
        expect(previewValue({ ...definition, secret: false })).toBe('abc');
        expect(previewValue({ ...definition, secret: false, value: '' })).toBe('(empty)');
        expect(previewValue({ ...definition, dynamic: true })).toMatch(/generated/);
    });
});

describe('JSON property names', () => {
    const jsonRequest = (json: string): HttpRequest => ({
        ...createEmptyRequest(),
        body: { ...createEmptyRequest().body, mode: 'json', json },
    });

    it('collects the keys the workspace uses, most used first, from readable bodies only', () => {
        const keys = collectJsonKeys([
            jsonRequest('{"id": {{id}}, "name": "a", "address": {"city": "x"}}'),
            jsonRequest('[{"id": 1, "email": "e"}]'),
            jsonRequest('not json'),
            {
                ...createEmptyRequest(),
                body: { ...createEmptyRequest().body, mode: 'text', text: '{"ignored":1}' },
            },
        ]);
        expect(keys[0]).toBe('id');
        expect(keys).toEqual(expect.arrayContaining(['name', 'address', 'city', 'email']));
        expect(keys).not.toContain('ignored');
    });

    it('recognises where a property name is being typed', () => {
        expect(propertyNameAt('{"na')).toEqual({ partial: 'na', start: 2 });
        expect(propertyNameAt('{\n    "a": 1,\n    "')).toEqual({ partial: '', start: 19 });
        // A value, an array element and a closed string are not property names.
        expect(propertyNameAt('{"a": "va')).toBeNull();
        expect(propertyNameAt('["x", "y')).toBeNull();
        expect(propertyNameAt('{"a": 1, "b": [1, "c')).toBeNull();
        expect(propertyNameAt('{"a"')).toBeNull();
    });
});

describe('script API context', () => {
    it('reads the receiver of a member access', () => {
        expect(memberAccessAt('httpreq.request.headers.')).toEqual({
            path: ['httpreq', 'request', 'headers'],
            partial: '',
            partialStart: 24,
        });
        expect(memberAccessAt('const a = httpreq.resp')?.path).toEqual(['httpreq']);
        expect(memberAccessAt('expect(httpreq.response.json()).to.')?.path).toEqual([
            'expect()',
            'to',
        ]);
        expect(memberAccessAt('httpreq.environment\n    .se')?.path).toEqual([
            'httpreq',
            'environment',
        ]);
        expect(memberAccessAt('httpreq?.request.')?.path).toEqual(['httpreq', 'request']);
        expect(memberAccessAt('resp')).toBeNull();
        expect(memberAccessAt('"text".')).toBeNull();
    });

    it('resolves a receiver to the API type it has', () => {
        expect(resolveType(['httpreq'], 'tests')).toBe('Httpreq');
        expect(resolveType(['httpreq', 'request', 'headers'], 'preRequest')).toBe('RequestHeaders');
        expect(resolveType(['httpreq', 'response', 'headers'], 'postResponse')).toBe(
            'ResponseHeaders',
        );
        expect(resolveType(['expect()', 'to', 'have'], 'tests')).toBe('Assertion');
        expect(resolveType(['httpreq', 'expect()'], 'tests')).toBe('Assertion');
        // The response does not exist before the request is sent.
        expect(resolveType(['httpreq', 'response'], 'preRequest')).toBeUndefined();
        // A function must be called, a property must not.
        expect(resolveType(['expect'], 'tests')).toBeUndefined();
        expect(resolveType(['httpreq()'], 'tests')).toBeUndefined();
        expect(resolveType(['nothing'], 'tests')).toBeUndefined();
    });

    it('offers the members of the type, per stage', () => {
        const names = (type: string, stage: 'preRequest' | 'postResponse') =>
            membersOf(type, stage).map((member) => member.name);
        expect(names('Httpreq', 'preRequest')).not.toContain('response');
        expect(names('Httpreq', 'postResponse')).toContain('response');
        expect(names('RequestHeaders', 'preRequest')).toEqual([
            'get',
            'has',
            'set',
            'remove',
            'toObject',
        ]);
    });

    it('finds the member a name refers to, for hover', () => {
        expect(
            memberAt(['httpreq', 'request', 'headers'], 'set', 'preRequest')?.params?.map(
                (p) => p.name,
            ),
        ).toEqual(['name', 'value']);
        expect(memberAt([], 'httpreq', 'tests')?.returns).toBe('Httpreq');
        expect(memberAt(['httpreq'], 'nope', 'tests')).toBeUndefined();
    });

    it('finds the call the cursor is in and the argument it is on', () => {
        expect(callSiteAt('httpreq.request.headers.set(')).toEqual({
            path: ['httpreq', 'request', 'headers'],
            name: 'set',
            argument: 0,
        });
        expect(callSiteAt("httpreq.request.headers.set('X-A', ")?.argument).toBe(1);
        expect(callSiteAt("test('name', () => { expect(")).toEqual({
            path: [],
            name: 'expect',
            argument: 0,
        });
        expect(callSiteAt('foo(a, [1, 2], ')?.argument).toBe(2);
        expect(callSiteAt('const x = 1;')).toBeNull();
        expect(signatureOf(memberAt(['httpreq', 'request', 'headers'], 'get', 'tests')!)).toBe(
            'get(name): string | undefined',
        );
    });
});

describe('the documented script API matches the sandbox', () => {
    // A script run in the real sandbox lists what exists; the table must say the same, so the
    // editor never suggests something that does not work or hides something that does.
    const probe = `
        const keys = (o) => Object.keys(o).sort();
        const chain = ['to','be','been','is','that','which','and','has','have','with','at','of','same','does','still','not','deep'];
        const a = httpreq.expect(1);
        console.log(JSON.stringify({
            httpreq: keys(httpreq),
            info: keys(httpreq.info),
            request: keys(httpreq.request),
            requestHeaders: keys(httpreq.request.headers),
            response: keys(httpreq.response),
            responseHeaders: keys(httpreq.response.headers),
            environment: keys(httpreq.environment),
            utils: keys(httpreq.utils),
            console: keys(console),
            globals: ['httpreq','console','expect','test','btoa','atob'].filter((n) => typeof globalThis[n] !== 'undefined'),
            assertion: Object.getOwnPropertyNames(Object.getPrototypeOf(a)).filter((n) => n !== 'constructor').sort(),
        }));
    `;

    it('lists the same members', async () => {
        const engine = new QuickJsScriptEngine({ timeoutMs: 2000 });
        const result = await engine.run({
            stage: 'postResponse',
            code: probe,
            request: {
                method: 'GET',
                url: 'https://x.test',
                headers: { A: 'b' },
                body: null,
                bodyEditable: false,
            },
            response: {
                status: 200,
                statusText: 'OK',
                headers: { A: 'b' },
                body: '{}',
                durationMs: 1,
                sizeBytes: 2,
            },
            environment: {},
            variables: {},
        });
        expect(result.ok, result.error?.message).toBe(true);
        const actual = JSON.parse(result.logs[0]!.message) as Record<string, string[]>;
        const documented = (type: string) =>
            membersOf(type, 'postResponse')
                .map((member) => member.name)
                .sort();

        expect(documented('Httpreq')).toEqual(actual.httpreq);
        expect(documented('Info')).toEqual(actual.info);
        expect(documented('Request')).toEqual(actual.request);
        expect(documented('RequestHeaders')).toEqual(actual.requestHeaders);
        expect(documented('Response')).toEqual(actual.response);
        expect(documented('ResponseHeaders')).toEqual(actual.responseHeaders);
        expect(documented('Store')).toEqual(actual.environment);
        expect(documented('Utils')).toEqual(actual.utils);
        expect(documented('Console')).toEqual(actual.console);
        expect(documented('Assertion')).toEqual(actual.assertion);
        expect(
            GLOBALS.filter((g) => g.kind !== 'class')
                .map((g) => g.name)
                .sort(),
        ).toEqual([...(actual.globals ?? [])].sort());
        expect(Object.keys(API_TYPES)).toEqual(expect.arrayContaining(['Httpreq', 'Assertion']));
    });
});

describe('XML helpers', () => {
    it('tracks the elements that are still open', () => {
        expect(openElements('<a><b><c/></b>')).toEqual(['a']);
        expect(openElements('<?xml version="1.0"?><!-- <x> --><a x="1>2"><b>')).toEqual(['a', 'b']);
        expect(openElements('<a><![CDATA[ <b> ]]><b></b>')).toEqual(['a']);
        expect(openElements('<a><b></c>')).toEqual(['a', 'b']);
        expect(openElements('<soap:Envelope><soap:Body>')).toEqual(['soap:Envelope', 'soap:Body']);
    });

    it('says which element a typed `</` closes', () => {
        expect(elementToClose('<a><b>text</')).toEqual({ name: 'b', partial: '' });
        expect(elementToClose('<a><b>text</b></')).toEqual({ name: 'a', partial: '' });
        // Letters typed after `</` are kept so the suggestion can complete them.
        expect(elementToClose('<a><b>x</b')).toEqual({ name: 'b', partial: 'b' });
        // Nothing is open, so there is nothing to close.
        expect(elementToClose('</')).toBeNull();
        expect(elementToClose('<a></a></')).toBeNull();
        expect(elementToClose('<a><b/>')).toBeNull();
        expect(elementToClose('<ns:a><ns:b></ns')).toEqual({ name: 'ns:b', partial: 'ns' });
    });

    it('lists the element names a document uses', () => {
        expect(elementNames('<a><b x="1"/><a></a></a>').sort()).toEqual(['a', 'b']);
    });
});

describe('request hints', () => {
    it('suggests header values by name in any casing, and nothing for free-form headers', () => {
        expect(headerValueSuggestions('content-type')).toContain('application/json');
        expect(headerValueSuggestions(' Accept ')).toContain('*/*');
        expect(headerValueSuggestions('X-Custom')).toEqual([]);
        expect(queryValueSuggestions('Sort')).toEqual(['asc', 'desc']);
        expect(formValueSuggestions('grant_type')).toContain('client_credentials');
    });

    it('suggests the environment variable that matches a path variable', () => {
        expect(pathVariableSuggestions('userId', ['user_id', 'token'])).toEqual(['{{user_id}}']);
        expect(pathVariableSuggestions('id', ['ID', 'x'])).toEqual(['{{ID}}']);
        expect(pathVariableSuggestions('order-id', ['orderId', 'order_id'])).toEqual([
            '{{order_id}}',
            '{{orderId}}',
        ]);
        expect(pathVariableSuggestions('id', ['other'])).toEqual([]);
    });
});
