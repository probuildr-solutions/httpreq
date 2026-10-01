/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { defineHttpGenerator } from '../../../core/define';
import { jsDialect, literalOrBlock } from '../../../core/dialects';
import { renderJson } from '../../../core/json';
import type { ModelBody } from '../../../core/model';
import type { CodeWriter } from '../../../core/writer';
import { jsonStyle, readsFiles, str, writeFormData, writeHeaders } from './shared';

/** axios serialises a plain object as JSON and a `URLSearchParams` as a form on its own. */
const dataExpression = (out: CodeWriter, body: ModelBody): string | undefined => {
    switch (body.kind) {
        case 'json':
            return body.value
                ? renderJson(body.value, out.indentation, jsonStyle(out.unit))
                : literalOrBlock(jsDialect, body.text, out.indentation, true);
        case 'markup':
            return literalOrBlock(jsDialect, body.text, out.indentation, true);
        case 'text':
            return str(body.text);
        case 'form': {
            const pairs = body.fields.map((field) => `[${str(field.name)}, ${str(field.value)}]`);
            return `new URLSearchParams([${pairs.join(', ')}])`;
        }
        case 'multipart':
            return 'form';
        case 'file':
            return `createReadStream(${str(body.fileName)})`;
        default:
            return undefined;
    }
};

export const axiosGenerator = defineHttpGenerator({
    id: 'node-axios',
    label: 'Node.js – axios',
    language: 'JavaScript',
    editorLanguage: 'javascript',
    fileExtension: 'mjs',
    requirements: 'Node.js 20+, axios 1.x',
    render(model, out) {
        const { body } = model;
        out.line('import axios from "axios";');
        if (body.kind === 'file') out.line('import { createReadStream } from "node:fs";');
        if (body.kind === 'multipart' && readsFiles(body)) {
            out.line('import { openAsBlob } from "node:fs";');
        }
        if (!model.verifyTls) out.line('import https from "node:https";');
        out.blank();
        writeFormData(out, body);

        out.block('const response = await axios.request({', '});', () => {
            out.line(`method: ${str(model.method.toLowerCase())},`);
            out.line(`url: ${str(model.url)},`);
            if (model.headers.length > 0) {
                out.block('headers: {', '},', () => writeHeaders(out, model));
            }
            const data = dataExpression(out, body);
            if (data !== undefined) out.line(`data: ${data},`);
            if (!model.followRedirects) out.line('maxRedirects: 0,');
            if (model.timeoutMs > 0) out.line(`timeout: ${model.timeoutMs},`);
            if (!model.verifyTls) {
                out.line('httpsAgent: new https.Agent({ rejectUnauthorized: false }),');
            }
        });
        out.blank();
        out.line('console.log(response.status);');
        out.line('console.log(response.data);');
    },
});
