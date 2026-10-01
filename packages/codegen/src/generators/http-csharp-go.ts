/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import type { CodeGenerator, HttpCodegenRequest } from '@httpreq/shared';
import { bodyAsText, dq, headerValue, lines, methodAllowsBody, pad, withoutHeaders } from '../util';

const HTTP_PROTOCOLS = ['http', 'soap'] as const;

/** `Content-Type` belongs to the content object in .NET; the other headers go on the request. */
const CONTENT_HEADERS = ['content-type', 'content-length', 'content-encoding'];

export const csharpHttpClientGenerator: CodeGenerator<HttpCodegenRequest> = {
    id: 'csharp-httpclient',
    label: 'C# – HttpClient',
    language: 'C#',
    editorLanguage: 'csharp',
    protocols: HTTP_PROTOCOLS,
    generate: (request, { indent }) => {
        const { body } = request;
        const text = bodyAsText(body);
        const contentType = headerValue(request.headers, 'Content-Type');
        const mediaType = contentType?.split(';')[0]?.trim() ?? 'text/plain';
        const p1 = pad(1, indent);
        const handler = !request.verifyTls || !request.followRedirects;
        return lines(
            'using System;',
            'using System.Net.Http;',
            'using System.Threading.Tasks;',
            '',
            'class Program',
            '{',
            `${p1}static async Task Main()`,
            `${p1}{`,
            handler && `${pad(2, indent)}var handler = new HttpClientHandler`,
            handler && `${pad(2, indent)}{`,
            handler && !request.followRedirects && `${pad(3, indent)}AllowAutoRedirect = false,`,
            handler &&
                !request.verifyTls &&
                `${pad(3, indent)}ServerCertificateCustomValidationCallback = HttpClientHandler.DangerousAcceptAnyServerCertificateValidator,`,
            handler && `${pad(2, indent)}};`,
            `${pad(2, indent)}using var client = new HttpClient(${handler ? 'handler' : ''});`,
            request.timeoutMs > 0 &&
                `${pad(2, indent)}client.Timeout = TimeSpan.FromMilliseconds(${request.timeoutMs});`,
            `${pad(2, indent)}var request = new HttpRequestMessage(new HttpMethod(${dq(request.method)}), ${dq(request.url)});`,
            ...withoutHeaders(request, CONTENT_HEADERS).map(
                (header) =>
                    `${pad(2, indent)}request.Headers.TryAddWithoutValidation(${dq(header.name)}, ${dq(header.value)});`,
            ),
            methodAllowsBody(request.method) && text !== null && body.kind !== 'none'
                ? `${pad(2, indent)}request.Content = new StringContent(${dq(text)}, System.Text.Encoding.UTF8, ${dq(mediaType)});`
                : false,
            methodAllowsBody(request.method) &&
                body.kind === 'file' &&
                `${pad(2, indent)}request.Content = new StreamContent(System.IO.File.OpenRead(${dq(body.fileName)}));`,
            methodAllowsBody(request.method) &&
                body.kind === 'multipart' &&
                lines(
                    `${pad(2, indent)}var form = new MultipartFormDataContent();`,
                    ...body.parts.map((part) =>
                        'fileName' in part
                            ? `${pad(2, indent)}form.Add(new StreamContent(System.IO.File.OpenRead(${dq(part.fileName)})), ${dq(part.name)}, ${dq(part.fileName)});`
                            : `${pad(2, indent)}form.Add(new StringContent(${dq(part.value)}), ${dq(part.name)});`,
                    ),
                    `${pad(2, indent)}request.Content = form;`,
                ),
            `${pad(2, indent)}var response = await client.SendAsync(request);`,
            `${pad(2, indent)}Console.WriteLine((int)response.StatusCode);`,
            `${pad(2, indent)}Console.WriteLine(await response.Content.ReadAsStringAsync());`,
            `${p1}}`,
            '}',
        );
    },
};

export const goNetHttpGenerator: CodeGenerator<HttpCodegenRequest> = {
    id: 'go-nethttp',
    label: 'Go – net/http',
    language: 'Go',
    editorLanguage: 'go',
    protocols: HTTP_PROTOCOLS,
    generate: (request) => {
        const { body } = request;
        const text = bodyAsText(body);
        const t = '\t';
        const sendsText = methodAllowsBody(request.method) && text !== null;
        const client = !request.followRedirects || !request.verifyTls || request.timeoutMs > 0;
        return lines(
            'package main',
            '',
            'import (',
            `${t}"fmt"`,
            `${t}"io"`,
            `${t}"net/http"`,
            !request.verifyTls && `${t}"crypto/tls"`,
            sendsText && `${t}"strings"`,
            request.timeoutMs > 0 && `${t}"time"`,
            ')',
            '',
            'func main() {',
            sendsText && `${t}payload := strings.NewReader(${dq(text)})`,
            `${t}req, err := http.NewRequest(${dq(request.method)}, ${dq(request.url)}, ${sendsText ? 'payload' : 'nil'})`,
            `${t}if err != nil {`,
            `${t}${t}panic(err)`,
            `${t}}`,
            ...request.headers.map(
                (header) => `${t}req.Header.Set(${dq(header.name)}, ${dq(header.value)})`,
            ),
            body.kind === 'multipart' &&
                `${t}// Build the multipart body with mime/multipart and set its Content-Type (with boundary).`,
            body.kind === 'file' &&
                `${t}// Open ${body.fileName} with os.Open and pass it as the request body.`,
            '',
            client ? `${t}client := &http.Client{` : `${t}client := http.DefaultClient`,
            client &&
                request.timeoutMs > 0 &&
                `${t}${t}Timeout: ${request.timeoutMs} * time.Millisecond,`,
            client &&
                !request.followRedirects &&
                `${t}${t}CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },`,
            client &&
                !request.verifyTls &&
                `${t}${t}Transport: &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}},`,
            client && `${t}}`,
            `${t}res, err := client.Do(req)`,
            `${t}if err != nil {`,
            `${t}${t}panic(err)`,
            `${t}}`,
            `${t}defer res.Body.Close()`,
            '',
            `${t}data, _ := io.ReadAll(res.Body)`,
            `${t}fmt.Println(res.StatusCode)`,
            `${t}fmt.Println(string(data))`,
            '}',
        );
    },
};
