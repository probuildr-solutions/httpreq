/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { defineHttpGenerator } from '../../../core/define';
import { javaDialect, literalOrBlock } from '../../../core/dialects';
import { DEFAULT_FILE_TYPE, baseName, type HttpModel } from '../../../core/model';
import type { CodeWriter } from '../../../core/writer';
import { TRUST_ALL_IMPORTS, writeTrustAll } from './trustAll';

const str = javaDialect.literal;

/** Methods OkHttp refuses to build without a body. */
const NEEDS_BODY = new Set(['POST', 'PUT', 'PATCH']);

/** `MediaType.parse("…")`, or `null` when the request names no content type. */
const mediaType = (contentType: string | undefined, fallback?: string): string => {
    const type = contentType ?? fallback;
    return type ? `MediaType.parse(${str(type)})` : 'null';
};

const importsFor = (model: HttpModel): string[] => {
    const { body } = model;
    const imports = new Set(['okhttp3.OkHttpClient', 'okhttp3.Request', 'okhttp3.Response']);
    if (model.timeoutMs > 0) imports.add('java.time.Duration');
    if (!model.verifyTls) TRUST_ALL_IMPORTS.forEach((name) => imports.add(name));
    if (body.kind === 'form') imports.add('okhttp3.FormBody');
    if (body.kind === 'multipart') imports.add('okhttp3.MultipartBody');
    if (
        body.kind === 'file' ||
        (body.kind === 'multipart' && body.parts.some((p) => 'fileName' in p))
    ) {
        imports.add('java.io.File');
    }
    // `RequestBody` and `MediaType` are used whenever there is a body or one has to be made up.
    if (body.kind !== 'none' || NEEDS_BODY.has(model.method)) imports.add('okhttp3.RequestBody');
    if (body.kind !== 'none' && body.kind !== 'form') imports.add('okhttp3.MediaType');
    return [...imports].sort();
};

/** Declares `body` and returns whether the request has one. */
const writeBody = (out: CodeWriter, model: HttpModel): boolean => {
    const { body } = model;
    switch (body.kind) {
        case 'json':
        case 'markup':
        case 'text': {
            const text = literalOrBlock(
                javaDialect,
                body.text,
                out.indentation + out.unit,
                body.kind !== 'text',
            );
            out.line(
                `RequestBody body = RequestBody.create(${text}, ${mediaType(model.contentType)});`,
            );
            return true;
        }
        case 'form':
            out.line('RequestBody body = new FormBody.Builder()');
            out.indent(() =>
                out.indent(() => {
                    body.fields.forEach((field) =>
                        out.line(`.add(${str(field.name)}, ${str(field.value)})`),
                    );
                    out.line('.build();');
                }),
            );
            return true;
        case 'file':
            out.line(
                `RequestBody body = RequestBody.create(new File(${str(body.fileName)}), ${mediaType(model.contentType, DEFAULT_FILE_TYPE)});`,
            );
            return true;
        case 'multipart':
            out.line('RequestBody body = new MultipartBody.Builder()');
            out.indent(() =>
                out.indent(() => {
                    out.line('.setType(MultipartBody.FORM)');
                    for (const part of body.parts) {
                        out.line(
                            'fileName' in part
                                ? `.addFormDataPart(${str(part.name)}, ${str(baseName(part.fileName))}, RequestBody.create(new File(${str(part.fileName)}), MediaType.parse(${str(DEFAULT_FILE_TYPE)})))`
                                : `.addFormDataPart(${str(part.name)}, ${str(part.value)})`,
                        );
                    }
                    out.line('.build();');
                }),
            );
            return true;
        default:
            if (NEEDS_BODY.has(model.method)) {
                out.line('RequestBody body = RequestBody.create(new byte[0], null);');
                return true;
            }
            return false;
    }
};

export const javaOkHttpGenerator = defineHttpGenerator({
    id: 'java-okhttp',
    label: 'Java – OkHttp',
    language: 'Java',
    editorLanguage: 'java',
    fileExtension: 'java',
    requirements: 'Java 15+, OkHttp 4+',
    render(model, out) {
        importsFor(model).forEach((name) => out.line(`import ${name};`));
        out.blank();
        out.block('public class Main {', '}', () => {
            out.blank();
            out.block('public static void main(String[] args) throws Exception {', '}', () => {
                if (!model.verifyTls) writeTrustAll(out);

                const clientOptions = [
                    !model.followRedirects && '.followRedirects(false)',
                    model.timeoutMs > 0 && `.callTimeout(Duration.ofMillis(${model.timeoutMs}))`,
                    !model.verifyTls &&
                        '.sslSocketFactory(sslContext.getSocketFactory(), trustAll)',
                    !model.verifyTls && '.hostnameVerifier((hostname, session) -> true)',
                ].filter((option): option is string => typeof option === 'string');
                if (clientOptions.length === 0) {
                    out.line('OkHttpClient client = new OkHttpClient();');
                } else {
                    out.line('OkHttpClient client = new OkHttpClient.Builder()');
                    out.indent(() =>
                        out.indent(() => {
                            clientOptions.forEach((option) => out.line(option));
                            out.line('.build();');
                        }),
                    );
                }
                out.blank();

                const hasBody = writeBody(out, model);
                if (hasBody) out.blank();

                // The body sets the Content-Type itself, from its media type.
                const headers = hasBody ? model.headersWithout('Content-Type') : model.headers;
                out.line('Request request = new Request.Builder()');
                out.indent(() =>
                    out.indent(() => {
                        out.line(`.url(${str(model.url)})`);
                        headers.forEach((header) =>
                            out.line(`.header(${str(header.name)}, ${str(header.value)})`),
                        );
                        if (model.method === 'GET') out.line('.get()');
                        else if (model.method === 'HEAD') out.line('.head()');
                        else {
                            out.line(`.method(${str(model.method)}, ${hasBody ? 'body' : 'null'})`);
                        }
                        out.line('.build();');
                    }),
                );
                out.blank();
                out.block(
                    'try (Response response = client.newCall(request).execute()) {',
                    '}',
                    () => {
                        out.line('System.out.println(response.code());');
                        out.line('System.out.println(response.body().string());');
                    },
                );
            });
        });
    },
});
