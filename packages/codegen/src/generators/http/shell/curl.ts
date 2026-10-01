/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { defineHttpGenerator } from '../../../core/define';
import { shellDialect } from '../../../core/dialects';
import { baseName, bodyText, wholeSeconds, type ModelBody } from '../../../core/model';

const quote = shellDialect.literal;

/** `--form` reads `;`, `,` and quotes in a file name as syntax, so such names are quoted. */
const formFile = (name: string, fileName: string) => {
    const file = /[;,"\\]/.test(fileName) ? `"${fileName.replace(/[\\"]/g, '\\$&')}"` : fileName;
    return `--form ${quote(`${name}=@${file}`)}`;
};

/** A name `--data-urlencode name=value` can carry: it encodes the value, not the name. */
const plainName = (name: string) => /^[\w.\-[\]]+$/.test(name);

const bodyArguments = (body: ModelBody): string[] => {
    switch (body.kind) {
        case 'json':
        case 'markup':
        case 'text':
            return [`--data-raw ${quote(body.text)}`];
        case 'form':
            return body.fields.every((field) => plainName(field.name))
                ? body.fields.map(
                      (field) => `--data-urlencode ${quote(`${field.name}=${field.value}`)}`,
                  )
                : [`--data-raw ${quote(bodyText(body) ?? '')}`];
        case 'file':
            return [`--data-binary ${quote(`@${baseName(body.fileName)}`)}`];
        case 'multipart':
            return body.parts.map((part) =>
                'fileName' in part
                    ? formFile(part.name, part.fileName)
                    : // `--form` treats a value starting with `@` or `<` as a file; `--form-string` does not.
                      `--form-string ${quote(`${part.name}=${part.value}`)}`,
            );
        default:
            return [];
    }
};

export const curlGenerator = defineHttpGenerator({
    id: 'curl',
    label: 'cURL',
    language: 'Shell',
    editorLanguage: 'shell',
    fileExtension: 'sh',
    render(model, out) {
        const args = [
            model.method === 'HEAD' ? '--head' : `--request ${model.method}`,
            `--url ${quote(model.url)}`,
            ...model.headers.map(
                (header) => `--header ${quote(`${header.name}: ${header.value}`)}`,
            ),
            ...bodyArguments(model.body),
            ...(model.followRedirects ? ['--location'] : []),
            ...(model.verifyTls ? [] : ['--insecure']),
            ...(model.timeoutMs > 0 ? [`--max-time ${wholeSeconds(model.timeoutMs)}`] : []),
        ];
        const [first, ...rest] = args;
        out.line(['curl ' + first, ...rest.map((arg) => `  ${arg}`)].join(' \\\n'));
    },
});
