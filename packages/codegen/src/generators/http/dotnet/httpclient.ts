/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { defineHttpGenerator } from '../../../core/define';
import { csharpDialect, literalOrBlock } from '../../../core/dialects';
import { baseName, type HttpModel } from '../../../core/model';
import type { CodeWriter } from '../../../core/writer';

const str = csharpDialect.literal;

const METHODS: Record<string, string> = {
    GET: 'Get',
    POST: 'Post',
    PUT: 'Put',
    PATCH: 'Patch',
    DELETE: 'Delete',
    HEAD: 'Head',
    OPTIONS: 'Options',
};

/** Headers .NET keeps on the content object rather than on the request message. */
const CONTENT_HEADERS = new Set([
    'allow',
    'content-disposition',
    'content-encoding',
    'content-language',
    'content-length',
    'content-location',
    'content-md5',
    'content-range',
    'content-type',
    'expires',
    'last-modified',
]);

/** Writes `request.Content = …` and returns whether the request has content. */
const writeContent = (out: CodeWriter, model: HttpModel): boolean => {
    const { body } = model;
    const mediaType = model.contentType;
    switch (body.kind) {
        case 'json':
        case 'markup':
        case 'text': {
            const text = literalOrBlock(
                csharpDialect,
                body.text,
                out.indentation + out.unit,
                body.kind !== 'text',
            );
            out.line(`request.Content = new StringContent(${text}, Encoding.UTF8);`);
            // Replaces the default `text/plain` while keeping the header exactly as written.
            if (mediaType) {
                out.line(
                    `request.Content.Headers.ContentType = MediaTypeHeaderValue.Parse(${str(mediaType)});`,
                );
            }
            return true;
        }
        case 'form':
            out.line('request.Content = new FormUrlEncodedContent(new[]');
            out.block('{', '});', () =>
                body.fields.forEach((field) =>
                    out.line(
                        `new KeyValuePair<string, string>(${str(field.name)}, ${str(field.value)}),`,
                    ),
                ),
            );
            return true;
        case 'file':
            out.line(`request.Content = new StreamContent(File.OpenRead(${str(body.fileName)}));`);
            if (mediaType) {
                out.line(
                    `request.Content.Headers.ContentType = MediaTypeHeaderValue.Parse(${str(mediaType)});`,
                );
            }
            return true;
        case 'multipart':
            out.line('var form = new MultipartFormDataContent();');
            for (const part of body.parts) {
                out.line(
                    'fileName' in part
                        ? `form.Add(new StreamContent(File.OpenRead(${str(part.fileName)})), ${str(part.name)}, ${str(baseName(part.fileName))});`
                        : `form.Add(new StringContent(${str(part.value)}), ${str(part.name)});`,
                );
            }
            out.line('request.Content = form;');
            return true;
        default:
            return false;
    }
};

export const csharpHttpClientGenerator = defineHttpGenerator({
    id: 'csharp-httpclient',
    label: 'C# – HttpClient',
    language: 'C#',
    editorLanguage: 'csharp',
    fileExtension: 'cs',
    requirements: '.NET 7+',
    render(model, out) {
        const { body } = model;
        const hasText = body.kind === 'json' || body.kind === 'markup' || body.kind === 'text';
        const usings = [
            'System',
            'System.Net.Http',
            body.kind === 'form' && 'System.Collections.Generic',
            (hasText || body.kind === 'file') && 'System.Net.Http.Headers',
            (body.kind === 'file' || body.kind === 'multipart') && 'System.IO',
            hasText && 'System.Text',
        ]
            .filter((name): name is string => typeof name === 'string')
            .sort();
        usings.forEach((name) => out.line(`using ${name};`));
        out.blank();

        const needsHandler = !model.followRedirects || !model.verifyTls;
        if (needsHandler) {
            out.line('using var handler = new HttpClientHandler');
            out.block('{', '};', () => {
                if (!model.followRedirects) out.line('AllowAutoRedirect = false,');
                if (!model.verifyTls) {
                    out.line(
                        'ServerCertificateCustomValidationCallback = HttpClientHandler.DangerousAcceptAnyServerCertificateValidator,',
                    );
                }
            });
        }
        out.line(`using var client = new HttpClient(${needsHandler ? 'handler' : ''});`);
        if (model.timeoutMs > 0) {
            out.line(`client.Timeout = TimeSpan.FromMilliseconds(${model.timeoutMs});`);
        }
        out.blank();

        const method = METHODS[model.method];
        out.line(
            `var request = new HttpRequestMessage(${method ? `HttpMethod.${method}` : `new HttpMethod(${str(model.method)})`}, ${str(model.url)});`,
        );
        for (const header of model.headers) {
            if (!CONTENT_HEADERS.has(header.name.toLowerCase())) {
                out.line(
                    `request.Headers.TryAddWithoutValidation(${str(header.name)}, ${str(header.value)});`,
                );
            }
        }
        const hasContent = writeContent(out, model);
        if (hasContent) {
            for (const header of model.headers) {
                const name = header.name.toLowerCase();
                if (
                    CONTENT_HEADERS.has(name) &&
                    name !== 'content-type' &&
                    name !== 'content-length'
                ) {
                    out.line(
                        `request.Content.Headers.TryAddWithoutValidation(${str(header.name)}, ${str(header.value)});`,
                    );
                }
            }
        }
        out.blank();
        out.line('using var response = await client.SendAsync(request);');
        out.line('Console.WriteLine((int)response.StatusCode);');
        out.line('Console.WriteLine(await response.Content.ReadAsStringAsync());');
    },
});
