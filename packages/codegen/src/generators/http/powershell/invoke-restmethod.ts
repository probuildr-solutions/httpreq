/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { defineHttpGenerator } from '../../../core/define';
import { literalOrBlock, powershellDialect } from '../../../core/dialects';
import { bodyText, wholeSeconds, type HttpModel } from '../../../core/model';
import type { CodeWriter } from '../../../core/writer';

const str = powershellDialect.literal;

/** Declares `$headers`, `$body` and `$form` as needed; returns the parameters that carry them. */
const writeBody = (out: CodeWriter, model: HttpModel): [string, string][] => {
    const { body } = model;
    const parameters: [string, string][] = [];
    switch (body.kind) {
        case 'json':
        case 'markup':
        case 'text':
            out.line(
                `$body = ${literalOrBlock(powershellDialect, body.text, '', body.kind !== 'text')}`,
            ).blank();
            parameters.push(['Body', '$body']);
            break;
        case 'form':
            out.line(`$body = ${str(bodyText(body) ?? '')}`).blank();
            parameters.push(['Body', '$body']);
            break;
        case 'file':
            parameters.push(['InFile', str(body.fileName)]);
            break;
        case 'multipart':
            out.block('$form = @{', '}', () =>
                body.parts.forEach((part) =>
                    out.line(
                        `${str(part.name)} = ${'fileName' in part ? `Get-Item -Path ${str(part.fileName)}` : str(part.value)}`,
                    ),
                ),
            ).blank();
            parameters.push(['Form', '$form']);
            break;
        default:
            break;
    }
    return parameters;
};

export const powershellGenerator = defineHttpGenerator({
    id: 'powershell',
    label: 'PowerShell – Invoke-RestMethod',
    language: 'PowerShell',
    editorLanguage: 'powershell',
    fileExtension: 'ps1',
    render(model, out) {
        const contentType = model.contentType;
        const headers = model.headersWithout('Content-Type');
        if (headers.length > 0) {
            out.block('$headers = @{', '}', () =>
                headers.forEach((header) => out.line(`${str(header.name)} = ${str(header.value)}`)),
            ).blank();
        }
        const bodyParameters = writeBody(out, model);

        const parameters: [string, string][] = [
            ['Uri', str(model.url)],
            ['Method', str(model.method)],
        ];
        if (headers.length > 0) parameters.push(['Headers', '$headers']);
        if (contentType) parameters.push(['ContentType', str(contentType)]);
        parameters.push(...bodyParameters);
        if (!model.followRedirects) parameters.push(['MaximumRedirection', '0']);
        if (model.timeoutMs > 0)
            parameters.push(['TimeoutSec', String(wholeSeconds(model.timeoutMs))]);
        if (!model.verifyTls) parameters.push(['SkipCertificateCheck', '$true']);

        if (model.body.kind === 'multipart' || !model.verifyTls) {
            out.line('# -Form and -SkipCertificateCheck need PowerShell 7 or later.');
        }
        const width = Math.max(...parameters.map(([name]) => name.length));
        out.block('$params = @{', '}', () =>
            parameters.forEach(([name, value]) => out.line(`${name.padEnd(width)} = ${value}`)),
        );
        out.blank();
        out.line('$response = Invoke-RestMethod @params');
        out.line('$response');
    },
});
