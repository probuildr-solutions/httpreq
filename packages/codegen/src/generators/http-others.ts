/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import type { CodeGenerator, HttpCodegenRequest } from '@httpreq/shared';
import {
    bodyAsText,
    headerValue,
    lines,
    methodAllowsBody,
    pad,
    sqBackslash,
    sqDouble,
    swiftString,
    withoutHeaders,
} from '../util';

const HTTP_PROTOCOLS = ['http', 'soap'] as const;

export const phpCurlGenerator: CodeGenerator<HttpCodegenRequest> = {
    id: 'php-curl',
    label: 'PHP – cURL',
    language: 'PHP',
    editorLanguage: 'php',
    protocols: HTTP_PROTOCOLS,
    generate: (request, { indent }) => {
        const { body } = request;
        const text = bodyAsText(body);
        const p = pad(1, indent);
        const multipart = body.kind === 'multipart' ? body : null;
        return lines(
            '<?php',
            '$curl = curl_init();',
            multipart &&
                `$fields = [${multipart.parts
                    .map((part) =>
                        'fileName' in part
                            ? `${sqBackslash(part.name)} => new CURLFile(${sqBackslash(part.fileName)})`
                            : `${sqBackslash(part.name)} => ${sqBackslash(part.value)}`,
                    )
                    .join(', ')}];`,
            'curl_setopt_array($curl, [',
            `${p}CURLOPT_URL => ${sqBackslash(request.url)},`,
            `${p}CURLOPT_RETURNTRANSFER => true,`,
            `${p}CURLOPT_CUSTOMREQUEST => ${sqBackslash(request.method)},`,
            `${p}CURLOPT_FOLLOWLOCATION => ${request.followRedirects ? 'true' : 'false'},`,
            !request.verifyTls && `${p}CURLOPT_SSL_VERIFYPEER => false,`,
            !request.verifyTls && `${p}CURLOPT_SSL_VERIFYHOST => 0,`,
            request.timeoutMs > 0 && `${p}CURLOPT_TIMEOUT_MS => ${request.timeoutMs},`,
            methodAllowsBody(request.method) &&
                text !== null &&
                `${p}CURLOPT_POSTFIELDS => ${sqBackslash(text)},`,
            methodAllowsBody(request.method) && multipart && `${p}CURLOPT_POSTFIELDS => $fields,`,
            request.headers.length > 0 && `${p}CURLOPT_HTTPHEADER => [`,
            ...request.headers.map(
                (header) => `${pad(2, indent)}${sqBackslash(`${header.name}: ${header.value}`)},`,
            ),
            request.headers.length > 0 && `${p}],`,
            ']);',
            '',
            '$response = curl_exec($curl);',
            'echo curl_getinfo($curl, CURLINFO_HTTP_CODE), PHP_EOL, $response;',
            'curl_close($curl);',
        );
    },
};

const RUBY_CLASS: Record<string, string> = {
    GET: 'Get',
    POST: 'Post',
    PUT: 'Put',
    PATCH: 'Patch',
    DELETE: 'Delete',
    HEAD: 'Head',
    OPTIONS: 'Options',
};

export const rubyNetHttpGenerator: CodeGenerator<HttpCodegenRequest> = {
    id: 'ruby-nethttp',
    label: 'Ruby – Net::HTTP',
    language: 'Ruby',
    editorLanguage: 'ruby',
    protocols: HTTP_PROTOCOLS,
    generate: (request) => {
        const { body } = request;
        const text = bodyAsText(body);
        const klass = RUBY_CLASS[request.method.toUpperCase()];
        return lines(
            "require 'uri'",
            "require 'net/http'",
            '',
            `uri = URI(${sqBackslash(request.url)})`,
            'http = Net::HTTP.new(uri.host, uri.port)',
            "http.use_ssl = uri.scheme == 'https'",
            !request.verifyTls && 'http.verify_mode = OpenSSL::SSL::VERIFY_NONE',
            request.timeoutMs > 0 && `http.read_timeout = ${request.timeoutMs / 1000}`,
            '',
            klass
                ? `request = Net::HTTP::${klass}.new(uri)`
                : `request = Net::HTTPGenericRequest.new(${sqBackslash(request.method)}, true, true, uri)`,
            ...request.headers.map(
                (header) => `request[${sqBackslash(header.name)}] = ${sqBackslash(header.value)}`,
            ),
            methodAllowsBody(request.method) &&
                text !== null &&
                `request.body = ${sqBackslash(text)}`,
            methodAllowsBody(request.method) &&
                body.kind === 'multipart' &&
                `request.set_form([${body.parts
                    .map((part) =>
                        'fileName' in part
                            ? `[${sqBackslash(part.name)}, File.open(${sqBackslash(part.fileName)})]`
                            : `[${sqBackslash(part.name)}, ${sqBackslash(part.value)}]`,
                    )
                    .join(', ')}], 'multipart/form-data')`,
            body.kind === 'file' &&
                `request.body_stream = File.open(${sqBackslash(body.fileName)})`,
            '',
            'response = http.request(request)',
            'puts response.code',
            'puts response.body',
        );
    },
};

export const powershellGenerator: CodeGenerator<HttpCodegenRequest> = {
    id: 'powershell',
    label: 'PowerShell – Invoke-RestMethod',
    language: 'PowerShell',
    editorLanguage: 'powershell',
    protocols: HTTP_PROTOCOLS,
    generate: (request, { indent }) => {
        const { body } = request;
        const text = bodyAsText(body);
        const contentType = headerValue(request.headers, 'Content-Type');
        const headers = withoutHeaders(request, ['Content-Type']);
        return lines(
            headers.length > 0 && '$headers = @{',
            ...headers.map(
                (header) => `${pad(1, indent)}${sqDouble(header.name)} = ${sqDouble(header.value)}`,
            ),
            headers.length > 0 && '}',
            body.kind === 'multipart' &&
                lines(
                    '$form = @{',
                    ...body.parts.map(
                        (part) =>
                            `${pad(1, indent)}${sqDouble(part.name)} = ${
                                'fileName' in part
                                    ? `Get-Item -Path ${sqDouble(part.fileName)}`
                                    : sqDouble(part.value)
                            }`,
                    ),
                    '}',
                ),
            methodAllowsBody(request.method) && text !== null && `$body = ${sqDouble(text)}`,
            '',
            `$response = Invoke-RestMethod -Uri ${sqDouble(request.url)} -Method ${request.method}` +
                (headers.length > 0 ? ' -Headers $headers' : '') +
                (contentType ? ` -ContentType ${sqDouble(contentType)}` : '') +
                (methodAllowsBody(request.method) && text !== null ? ' -Body $body' : '') +
                (body.kind === 'multipart' ? ' -Form $form' : '') +
                (body.kind === 'file' ? ` -InFile ${sqDouble(body.fileName)}` : '') +
                (!request.followRedirects ? ' -MaximumRedirection 0' : '') +
                (!request.verifyTls ? ' -SkipCertificateCheck' : '') +
                (request.timeoutMs > 0
                    ? ` -TimeoutSec ${Math.ceil(request.timeoutMs / 1000)}`
                    : ''),
            '$response',
        );
    },
};

export const swiftUrlSessionGenerator: CodeGenerator<HttpCodegenRequest> = {
    id: 'swift-urlsession',
    label: 'Swift – URLSession',
    language: 'Swift',
    editorLanguage: 'swift',
    protocols: HTTP_PROTOCOLS,
    generate: (request, { indent }) => {
        const text = bodyAsText(request.body);
        const p = pad(1, indent);
        return lines(
            'import Foundation',
            '',
            `var request = URLRequest(url: URL(string: ${swiftString(request.url)})!)`,
            `request.httpMethod = ${swiftString(request.method)}`,
            request.timeoutMs > 0 && `request.timeoutInterval = ${request.timeoutMs / 1000}`,
            ...request.headers.map(
                (header) =>
                    `request.setValue(${swiftString(header.value)}, forHTTPHeaderField: ${swiftString(header.name)})`,
            ),
            methodAllowsBody(request.method) &&
                text !== null &&
                `request.httpBody = ${swiftString(text)}.data(using: .utf8)`,
            request.body.kind === 'multipart' &&
                '// Build the multipart body by hand and set its boundary in Content-Type.',
            request.body.kind === 'file' &&
                `request.httpBody = try Data(contentsOf: URL(fileURLWithPath: ${swiftString(request.body.fileName)}))`,
            !request.verifyTls &&
                '// Certificate verification is off for this request: implement URLSessionDelegate to trust the server.',
            '',
            'let task = URLSession.shared.dataTask(with: request) { data, response, error in',
            `${p}if let error = error { print(error); return }`,
            `${p}if let http = response as? HTTPURLResponse { print(http.statusCode) }`,
            `${p}if let data = data { print(String(data: data, encoding: .utf8) ?? "") }`,
            '}',
            'task.resume()',
            'RunLoop.main.run(until: Date(timeIntervalSinceNow: 30))',
        );
    },
};
