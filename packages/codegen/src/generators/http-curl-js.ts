/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import type { CodeGenerator, HttpCodegenRequest } from '@httpreq/shared';
import { bodyAsText, dq, lines, methodAllowsBody, pad, shellQuote } from '../util';

const HTTP_PROTOCOLS = ['http', 'soap'] as const;

const headerEntries = (request: HttpCodegenRequest, level: number, size: number) =>
    request.headers.map((header) => `${pad(level, size)}${dq(header.name)}: ${dq(header.value)},`);

export const curlGenerator: CodeGenerator<HttpCodegenRequest> = {
    id: 'curl',
    label: 'cURL',
    language: 'Shell',
    editorLanguage: 'shell',
    protocols: HTTP_PROTOCOLS,
    generate: (request) => {
        const parts = [`curl --request ${request.method} ${shellQuote(request.url)}`];
        for (const header of request.headers) {
            parts.push(`--header ${shellQuote(`${header.name}: ${header.value}`)}`);
        }
        const { body } = request;
        if (body.kind === 'text') parts.push(`--data-raw ${shellQuote(body.text)}`);
        if (body.kind === 'form') {
            body.fields.forEach((field) =>
                parts.push(`--data-urlencode ${shellQuote(`${field.name}=${field.value}`)}`),
            );
        }
        if (body.kind === 'file') parts.push(`--data-binary ${shellQuote(`@${body.fileName}`)}`);
        if (body.kind === 'multipart') {
            for (const part of body.parts) {
                parts.push(
                    'fileName' in part
                        ? `--form ${shellQuote(`${part.name}=@${part.fileName}`)}`
                        : `--form ${shellQuote(`${part.name}=${part.value}`)}`,
                );
            }
        }
        if (request.followRedirects) parts.push('--location');
        if (!request.verifyTls) parts.push('--insecure');
        if (request.timeoutMs > 0) parts.push(`--max-time ${Math.ceil(request.timeoutMs / 1000)}`);
        return parts.join(' \\\n  ');
    },
};

export const javascriptFetchGenerator: CodeGenerator<HttpCodegenRequest> = {
    id: 'javascript-fetch',
    label: 'JavaScript – fetch',
    language: 'JavaScript',
    editorLanguage: 'javascript',
    protocols: HTTP_PROTOCOLS,
    generate: (request, { indent }) => {
        const text = bodyAsText(request.body);
        const { body } = request;
        const formData = body.kind === 'multipart';
        return lines(
            formData && 'const form = new FormData();',
            formData &&
                body.kind === 'multipart' &&
                lines(
                    ...body.parts.map((part) =>
                        'fileName' in part
                            ? `form.append(${dq(part.name)}, new Blob([/* contents of ${part.fileName} */]), ${dq(part.fileName)});`
                            : `form.append(${dq(part.name)}, ${dq(part.value)});`,
                    ),
                ),
            formData && '',
            `const response = await fetch(${dq(request.url)}, {`,
            `${pad(1, indent)}method: ${dq(request.method)},`,
            request.headers.length > 0 && `${pad(1, indent)}headers: {`,
            ...(request.headers.length > 0 ? headerEntries(request, 2, indent) : []),
            request.headers.length > 0 && `${pad(1, indent)}},`,
            methodAllowsBody(request.method) &&
                (formData
                    ? `${pad(1, indent)}body: form,`
                    : body.kind === 'file'
                      ? `${pad(1, indent)}body: /* contents of ${body.fileName} */ undefined,`
                      : text !== null && `${pad(1, indent)}body: ${dq(text)},`),
            !request.followRedirects && `${pad(1, indent)}redirect: "manual",`,
            request.timeoutMs > 0 &&
                `${pad(1, indent)}signal: AbortSignal.timeout(${request.timeoutMs}),`,
            '});',
            !request.verifyTls &&
                '// Certificate verification is off for this request; in Node.js set NODE_TLS_REJECT_UNAUTHORIZED=0.',
            '',
            'console.log(response.status);',
            'console.log(await response.text());',
        );
    },
};

export const nodeAxiosGenerator: CodeGenerator<HttpCodegenRequest> = {
    id: 'node-axios',
    label: 'Node.js – axios',
    language: 'JavaScript',
    editorLanguage: 'javascript',
    protocols: HTTP_PROTOCOLS,
    generate: (request, { indent }) => {
        const { body } = request;
        const text = bodyAsText(body);
        const formData = body.kind === 'multipart';
        return lines(
            "import axios from 'axios';",
            formData && "import FormData from 'form-data';",
            formData && "import fs from 'node:fs';",
            !request.verifyTls && "import https from 'node:https';",
            '',
            formData && 'const form = new FormData();',
            formData &&
                body.kind === 'multipart' &&
                lines(
                    ...body.parts.map((part) =>
                        'fileName' in part
                            ? `form.append(${dq(part.name)}, fs.createReadStream(${dq(part.fileName)}));`
                            : `form.append(${dq(part.name)}, ${dq(part.value)});`,
                    ),
                ),
            formData && '',
            'const response = await axios.request({',
            `${pad(1, indent)}method: ${dq(request.method.toLowerCase())},`,
            `${pad(1, indent)}url: ${dq(request.url)},`,
            request.headers.length > 0 && `${pad(1, indent)}headers: {`,
            ...(request.headers.length > 0 ? headerEntries(request, 2, indent) : []),
            request.headers.length > 0 && `${pad(1, indent)}},`,
            methodAllowsBody(request.method) &&
                (formData
                    ? `${pad(1, indent)}data: form,`
                    : body.kind === 'file'
                      ? `${pad(1, indent)}data: fs.createReadStream(${dq(body.fileName)}),`
                      : text !== null && `${pad(1, indent)}data: ${dq(text)},`),
            !request.followRedirects && `${pad(1, indent)}maxRedirects: 0,`,
            request.timeoutMs > 0 && `${pad(1, indent)}timeout: ${request.timeoutMs},`,
            !request.verifyTls &&
                `${pad(1, indent)}httpsAgent: new https.Agent({ rejectUnauthorized: false }),`,
            '});',
            '',
            'console.log(response.status);',
            'console.log(response.data);',
        );
    },
};
