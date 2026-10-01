/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import type { CodeGenerator, HttpCodegenRequest } from '@httpreq/shared';
import { bodyAsText, dq, lines, methodAllowsBody, pad } from '../util';

const HTTP_PROTOCOLS = ['http', 'soap'] as const;

/** A Python string literal; JSON escapes are valid there except for astral `\u` pairs, which are fine too. */
const py = (text: string) => JSON.stringify(text);

export const pythonRequestsGenerator: CodeGenerator<HttpCodegenRequest> = {
    id: 'python-requests',
    label: 'Python – requests',
    language: 'Python',
    editorLanguage: 'python',
    protocols: HTTP_PROTOCOLS,
    generate: (request, { indent }) => {
        const { body } = request;
        const text = bodyAsText(body);
        const allowsBody = methodAllowsBody(request.method);
        const multipart = body.kind === 'multipart' ? body : null;
        const arg = (name: string, value: string) => `${pad(1, indent)}${name}=${value},`;
        return lines(
            'import requests',
            '',
            `url = ${py(request.url)}`,
            request.headers.length > 0 && 'headers = {',
            ...request.headers.map(
                (header) => `${pad(1, indent)}${py(header.name)}: ${py(header.value)},`,
            ),
            request.headers.length > 0 && '}',
            multipart &&
                'files = [' +
                    multipart.parts
                        .filter((part) => 'fileName' in part)
                        .map(
                            (part) =>
                                `(${py(part.name)}, open(${py('fileName' in part ? part.fileName : '')}, "rb"))`,
                        )
                        .join(', ') +
                    ']',
            multipart &&
                'data = {' +
                    multipart.parts
                        .filter((part) => 'value' in part)
                        .map((part) => `${py(part.name)}: ${py('value' in part ? part.value : '')}`)
                        .join(', ') +
                    '}',
            allowsBody && text !== null && `payload = ${py(text)}`,
            '',
            'response = requests.request(',
            arg('method', py(request.method)),
            arg('url', 'url'),
            request.headers.length > 0 && arg('headers', 'headers'),
            allowsBody && text !== null && arg('data', 'payload'),
            allowsBody && multipart && arg('data', 'data'),
            allowsBody && multipart && arg('files', 'files'),
            allowsBody && body.kind === 'file' && arg('data', `open(${py(body.fileName)}, "rb")`),
            !request.followRedirects && arg('allow_redirects', 'False'),
            !request.verifyTls && arg('verify', 'False'),
            request.timeoutMs > 0 && arg('timeout', String(request.timeoutMs / 1000)),
            ')',
            '',
            'print(response.status_code)',
            'print(response.text)',
        );
    },
};

export const javaHttpClientGenerator: CodeGenerator<HttpCodegenRequest> = {
    id: 'java-httpclient',
    label: 'Java – java.net.http',
    language: 'Java',
    editorLanguage: 'java',
    protocols: HTTP_PROTOCOLS,
    generate: (request, { indent }) => {
        const { body } = request;
        const text = bodyAsText(body);
        const allowsBody = methodAllowsBody(request.method);
        const publisher = !allowsBody
            ? 'HttpRequest.BodyPublishers.noBody()'
            : body.kind === 'file'
              ? `HttpRequest.BodyPublishers.ofFile(Path.of(${dq(body.fileName)}))`
              : body.kind === 'multipart'
                ? 'HttpRequest.BodyPublishers.noBody() /* build the multipart body, e.g. with a MultipartBodyPublisher */'
                : text !== null
                  ? `HttpRequest.BodyPublishers.ofString(${dq(text)})`
                  : 'HttpRequest.BodyPublishers.noBody()';
        const p1 = pad(1, indent);
        const p2 = pad(2, indent);
        const p3 = pad(3, indent);
        return lines(
            'import java.net.URI;',
            'import java.net.http.HttpClient;',
            'import java.net.http.HttpRequest;',
            'import java.net.http.HttpResponse;',
            body.kind === 'file' && 'import java.nio.file.Path;',
            request.timeoutMs > 0 && 'import java.time.Duration;',
            '',
            'public class Main {',
            `${p1}public static void main(String[] args) throws Exception {`,
            `${p2}HttpClient client = HttpClient.newBuilder()`,
            `${p3}.followRedirects(HttpClient.Redirect.${request.followRedirects ? 'NORMAL' : 'NEVER'})`,
            `${p3}.build();`,
            !request.verifyTls &&
                `${p2}// Certificate verification is off for this request: configure an SSLContext with a trust-all TrustManager on the builder.`,
            `${p2}HttpRequest request = HttpRequest.newBuilder()`,
            `${p3}.uri(URI.create(${dq(request.url)}))`,
            request.timeoutMs > 0 && `${p3}.timeout(Duration.ofMillis(${request.timeoutMs}))`,
            ...request.headers.map(
                (header) => `${p3}.header(${dq(header.name)}, ${dq(header.value)})`,
            ),
            `${p3}.method(${dq(request.method)}, ${publisher})`,
            `${p3}.build();`,
            `${p2}HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());`,
            `${p2}System.out.println(response.statusCode());`,
            `${p2}System.out.println(response.body());`,
            `${p1}}`,
            '}',
        );
    },
};
