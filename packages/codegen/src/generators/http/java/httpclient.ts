/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { defineHttpGenerator } from '../../../core/define';
import { javaDialect, literalOrBlock } from '../../../core/dialects';
import {
    DEFAULT_FILE_TYPE,
    baseName,
    bodyText,
    mimeQuoted,
    type HttpModel,
} from '../../../core/model';
import type { CodeWriter } from '../../../core/writer';
import { TRUST_ALL_IMPORTS, writeTrustAll } from './trustAll';

const str = javaDialect.literal;

/** Headers `java.net.http` refuses to send: the client sets them itself. */
const RESTRICTED_HEADERS = new Set(['connection', 'content-length', 'expect', 'host', 'upgrade']);

const importsFor = (model: HttpModel): string[] => {
    const imports = new Set([
        'java.net.URI',
        'java.net.http.HttpClient',
        'java.net.http.HttpRequest',
        'java.net.http.HttpResponse',
        'java.net.http.HttpResponse.BodyHandlers',
    ]);
    const { body } = model;
    if (model.method !== 'GET') imports.add('java.net.http.HttpRequest.BodyPublishers');
    if (model.timeoutMs > 0) imports.add('java.time.Duration');
    if (body.kind === 'file') imports.add('java.nio.file.Path');
    if (body.kind === 'multipart') {
        ['java.nio.charset.StandardCharsets', 'java.util.ArrayList', 'java.util.List'].forEach(
            (name) => imports.add(name),
        );
        imports.add('java.util.UUID');
        if (body.parts.some((part) => 'fileName' in part)) {
            imports.add('java.nio.file.Files');
            imports.add('java.nio.file.Path');
        }
    }
    if (!model.verifyTls) TRUST_ALL_IMPORTS.forEach((name) => imports.add(name));
    return [...imports].sort();
};

/** Builds the `List<byte[]>` a multipart body is sent from: `java.net.http` has no multipart support. */
const writeMultipart = (out: CodeWriter, model: HttpModel): void => {
    const { body } = model;
    if (body.kind !== 'multipart') return;
    out.line('String boundary = "----HttpReq" + UUID.randomUUID();');
    out.line('List<byte[]> multipart = new ArrayList<>();');
    const add = (text: string) =>
        out.line(
            `multipart.add(("--" + boundary + ${str(text)}).getBytes(StandardCharsets.UTF_8));`,
        );
    for (const part of body.parts) {
        const name = mimeQuoted(part.name);
        if ('fileName' in part) {
            const file = mimeQuoted(baseName(part.fileName));
            add(
                `\r\nContent-Disposition: form-data; name="${name}"; filename="${file}"\r\nContent-Type: ${DEFAULT_FILE_TYPE}\r\n\r\n`,
            );
            out.line(`multipart.add(Files.readAllBytes(Path.of(${str(part.fileName)})));`);
            out.line('multipart.add("\\r\\n".getBytes(StandardCharsets.UTF_8));');
        } else {
            add(`\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${part.value}\r\n`);
        }
    }
    out.line('multipart.add(("--" + boundary + "--\\r\\n").getBytes(StandardCharsets.UTF_8));');
    out.blank();
};

/** `java.net.http` checks the host name separately from the certificate; only a property turns that off. */
const writeInsecure = (out: CodeWriter): void => {
    writeTrustAll(out);
    out.line('System.setProperty("jdk.internal.httpclient.disableHostnameVerification", "true");');
    out.blank();
};

const publisher = (out: CodeWriter, model: HttpModel): string => {
    const { body } = model;
    switch (body.kind) {
        case 'json':
        case 'markup':
        case 'text':
            return `BodyPublishers.ofString(${literalOrBlock(javaDialect, body.text, out.indentation + out.unit, body.kind !== 'text')})`;
        case 'form':
            return `BodyPublishers.ofString(${str(bodyText(body) ?? '')})`;
        case 'file':
            return `BodyPublishers.ofFile(Path.of(${str(body.fileName)}))`;
        case 'multipart':
            return 'BodyPublishers.ofByteArrays(multipart)';
        default:
            return 'BodyPublishers.noBody()';
    }
};

export const javaHttpClientGenerator = defineHttpGenerator({
    id: 'java-httpclient',
    label: 'Java – java.net.http',
    language: 'Java',
    editorLanguage: 'java',
    fileExtension: 'java',
    requirements: 'Java 15+',
    render(model, out) {
        importsFor(model).forEach((name) => out.line(`import ${name};`));
        out.blank();
        out.block('public class Main {', '}', () => {
            out.blank();
            out.block('public static void main(String[] args) throws Exception {', '}', () => {
                if (!model.verifyTls) writeInsecure(out);
                writeMultipart(out, model);

                const clientOptions = [
                    model.followRedirects && '.followRedirects(HttpClient.Redirect.NORMAL)',
                    !model.verifyTls && '.sslContext(sslContext)',
                ].filter((option): option is string => typeof option === 'string');
                if (clientOptions.length === 0) {
                    out.line('HttpClient client = HttpClient.newHttpClient();');
                } else {
                    out.line('HttpClient client = HttpClient.newBuilder()');
                    out.indent(() =>
                        out.indent(() => {
                            clientOptions.forEach((option) => out.line(option));
                            out.line('.build();');
                        }),
                    );
                }
                out.blank();

                const sent = model.headers.filter(
                    (header) => !RESTRICTED_HEADERS.has(header.name.toLowerCase()),
                );
                const skipped = model.headers.filter((header) => !sent.includes(header));
                if (skipped.length > 0) {
                    out.line(
                        `// Set by the HTTP client and not sendable here: ${skipped.map((header) => header.name).join(', ')}.`,
                    );
                }
                out.line('HttpRequest request = HttpRequest.newBuilder()');
                out.indent(() =>
                    out.indent(() => {
                        out.line(`.uri(URI.create(${str(model.url)}))`);
                        if (model.timeoutMs > 0) {
                            out.line(`.timeout(Duration.ofMillis(${model.timeoutMs}))`);
                        }
                        sent.forEach((header) =>
                            out.line(`.header(${str(header.name)}, ${str(header.value)})`),
                        );
                        if (model.body.kind === 'multipart') {
                            out.line(
                                '.header("Content-Type", "multipart/form-data; boundary=" + boundary)',
                            );
                        }
                        out.line(
                            model.method === 'GET'
                                ? '.GET()'
                                : `.method(${str(model.method)}, ${publisher(out, model)})`,
                        );
                        out.line('.build();');
                    }),
                );
                out.blank();
                out.line(
                    'HttpResponse<String> response = client.send(request, BodyHandlers.ofString());',
                );
                out.line('System.out.println(response.statusCode());');
                out.line('System.out.println(response.body());');
            });
        });
    },
});
