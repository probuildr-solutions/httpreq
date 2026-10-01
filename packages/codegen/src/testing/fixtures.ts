/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import type { HttpCodegenRequest } from '@httpreq/shared';

/**
 * Resolved requests that exercise what generators get wrong: bodies full of quotes, backslashes
 * and line separators, every body kind, and every setting that changes the call. Tests run each
 * generator over all of them.
 */

const base: HttpCodegenRequest = {
    protocol: 'http',
    method: 'GET',
    url: 'https://api.example.com/items',
    headers: [],
    body: { kind: 'none' },
    followRedirects: true,
    verifyTls: true,
    timeoutMs: 0,
};

const request = (patch: Partial<HttpCodegenRequest>): HttpCodegenRequest => ({ ...base, ...patch });

const PRETTY_JSON = `{
    "name": "Ada Lovelace",
    "age": 36,
    "active": true,
    "tags": ["math", "poetry"],
    "address": { "city": "London", "geo": null },
    "note": "line1\\nline2 \\"quoted\\" \\\\ back\\\\slash é 😀",
    "price": 12.5
}`;

const SOAP = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
    <soap:Body>
        <Add xmlns="http://tempuri.org/">
            <a>1</a>
            <label>it's "fine" \\ ]]> é</label>
        </Add>
    </soap:Body>
</soap:Envelope>
`;

export const FIXTURES: Record<string, HttpCodegenRequest> = {
    'json-post': request({
        method: 'POST',
        url: 'https://api.example.com/users?active=true&limit=10',
        headers: [
            { name: 'Accept', value: 'application/json' },
            { name: 'Authorization', value: 'Bearer <SECRET>' },
            { name: 'Content-Type', value: 'application/json' },
            { name: 'X-Trace', value: 'it\'s "quoted"' },
        ],
        body: { kind: 'text', text: PRETTY_JSON },
    }),
    'json-minified': request({
        method: 'PUT',
        url: 'https://api.example.com/users/42',
        headers: [{ name: 'Content-Type', value: 'application/json; charset=utf-8' }],
        body: { kind: 'text', text: '{"id":42,"roles":["admin","ops"],"meta":{}}' },
    }),
    'json-lossy': request({
        method: 'POST',
        url: 'https://api.example.com/numbers',
        headers: [{ name: 'Content-Type', value: 'application/json' }],
        body: { kind: 'text', text: '{\n    "price": 1.0,\n    "id": 12345678901234567890\n}' },
    }),
    'json-array': request({
        method: 'PATCH',
        url: 'https://api.example.com/batch',
        headers: [{ name: 'Content-Type', value: 'application/json' }],
        body: {
            kind: 'text',
            text: '[\n    { "op": "add", "path": "/a/b", "value": [1, 2, 3] }\n]\n',
        },
    }),
    soap: request({
        protocol: 'soap',
        method: 'POST',
        url: 'https://example.com/calc.asmx',
        headers: [
            { name: 'Content-Type', value: 'text/xml; charset=utf-8' },
            { name: 'SOAPAction', value: '"http://tempuri.org/Add"' },
        ],
        body: { kind: 'text', text: SOAP },
    }),
    form: request({
        method: 'POST',
        url: 'https://api.example.com/login',
        headers: [{ name: 'Content-Type', value: 'application/x-www-form-urlencoded' }],
        body: {
            kind: 'form',
            fields: [
                { name: 'user name', value: 'ada & co' },
                { name: 'scope', value: 'read' },
                { name: 'scope', value: 'write' },
            ],
        },
    }),
    multipart: request({
        method: 'POST',
        url: 'https://api.example.com/upload',
        headers: [{ name: 'Accept', value: '*/*' }],
        body: {
            kind: 'multipart',
            parts: [
                { name: 'title', value: 'Hello "world"' },
                { name: 'avatar', fileName: 'photo.png' },
                { name: 'note', value: '@not-a-file' },
                { name: 'report', fileName: 'q1 report.pdf' },
            ],
        },
    }),
    binary: request({
        method: 'PUT',
        url: 'https://api.example.com/blobs/1',
        headers: [{ name: 'Content-Type', value: 'application/octet-stream' }],
        body: { kind: 'file', fileName: 'data.bin' },
    }),
    'get-settings': request({
        url: 'https://api.example.com/search?q=a%20b&tag=x&tag=y',
        headers: [
            { name: 'Accept', value: 'text/html' },
            { name: 'X-Request-Id', value: '4f6c' },
        ],
        followRedirects: false,
        verifyTls: false,
        timeoutMs: 2500,
    }),
    delete: request({ method: 'DELETE', url: 'https://api.example.com/items/7' }),
    head: request({ method: 'HEAD', url: 'https://api.example.com/items' }),
    'post-empty': request({ method: 'POST', url: 'https://api.example.com/jobs/1/start' }),
    'plain-text': request({
        method: 'POST',
        url: 'https://api.example.com/echo',
        headers: [{ name: 'Content-Type', value: 'text/plain' }],
        body: { kind: 'text', text: "héllo wörld — “quotes”, it's \\ back\ttab\nsecond line\n" },
    }),
    hostile: request({
        method: 'POST',
        url: 'https://api.example.com/a?b="c"&d=\'e\'',
        headers: [
            { name: 'Content-Type', value: 'text/plain' },
            { name: 'X-Weird', value: 'back`tick ${x} "$y" \\ \u2018smart\u2019 \u2028' },
        ],
        body: {
            kind: 'text',
            text: 'back`tick ${x} """triple""" \'\'\'single\'\'\' \u2028 \u0085 \ud83d\ude00 \\u0041 \\n',
        },
    }),
    'xml-hostile': request({
        method: 'POST',
        url: 'https://api.example.com/xml',
        headers: [{ name: 'Content-Type', value: 'application/xml' }],
        body: {
            kind: 'text',
            text: '<a>\n  <b attr="x">back`tick ${x}</b>\n  <c>"""</c>\n  <d>\\u0041 \\n</d>\n  <e>BODY</e>\n  <f>\'@</f>\n</a>',
        },
    }),
};

export type FixtureName = keyof typeof FIXTURES;
