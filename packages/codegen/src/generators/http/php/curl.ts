/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { defineHttpGenerator } from '../../../core/define';
import { literalOrBlock, phpDialect } from '../../../core/dialects';
import { bodyText, type ModelBody } from '../../../core/model';
import type { CodeWriter } from '../../../core/writer';

const str = phpDialect.literal;

/** The `CURLOPT_POSTFIELDS` value, or `undefined` when the request has no body. */
const postFields = (out: CodeWriter, body: ModelBody): string | undefined => {
    switch (body.kind) {
        case 'json':
        case 'markup':
        case 'text':
            return literalOrBlock(phpDialect, body.text, out.indentation, body.kind !== 'text');
        case 'form':
            return str(bodyText(body) ?? '');
        case 'file':
            return `file_get_contents(${str(body.fileName)})`;
        case 'multipart': {
            const inner = out.indentation + out.unit;
            const entries = body.parts.map(
                (part) =>
                    `${inner}${str(part.name)} => ${'fileName' in part ? `new CURLFile(${str(part.fileName)})` : str(part.value)},`,
            );
            return ['[', ...entries, `${out.indentation}]`].join('\n');
        }
        default:
            return undefined;
    }
};

export const phpCurlGenerator = defineHttpGenerator({
    id: 'php-curl',
    label: 'PHP – cURL',
    language: 'PHP',
    editorLanguage: 'php',
    fileExtension: 'php',
    requirements: 'PHP 7.3+, ext-curl',
    render(model, out) {
        out.line('<?php').blank();
        out.line('$curl = curl_init();').blank();
        out.block('curl_setopt_array($curl, [', ']);', () => {
            out.line(`CURLOPT_URL => ${str(model.url)},`);
            out.line('CURLOPT_RETURNTRANSFER => true,');
            if (model.method === 'HEAD') {
                out.line('CURLOPT_NOBODY => true,');
            } else if (model.method !== 'GET') {
                out.line(`CURLOPT_CUSTOMREQUEST => ${str(model.method)},`);
            }
            out.line(`CURLOPT_FOLLOWLOCATION => ${model.followRedirects ? 'true' : 'false'},`);
            if (!model.verifyTls) {
                out.line('CURLOPT_SSL_VERIFYPEER => false,');
                out.line('CURLOPT_SSL_VERIFYHOST => 0,');
            }
            if (model.timeoutMs > 0) out.line(`CURLOPT_TIMEOUT_MS => ${model.timeoutMs},`);
            const fields = postFields(out, model.body);
            if (fields !== undefined) out.line(`CURLOPT_POSTFIELDS => ${fields},`);
            if (model.headers.length > 0) {
                out.block('CURLOPT_HTTPHEADER => [', '],', () =>
                    model.headers.forEach((header) =>
                        out.line(`${str(`${header.name}: ${header.value}`)},`),
                    ),
                );
            }
        });
        out.blank();
        out.line('$response = curl_exec($curl);').blank();
        out.block('if ($response === false) {', '}', () =>
            out.line('throw new RuntimeException(curl_error($curl));'),
        );
        out.blank();
        out.line('echo curl_getinfo($curl, CURLINFO_HTTP_CODE), PHP_EOL;');
        out.line('echo $response, PHP_EOL;');
    },
});
