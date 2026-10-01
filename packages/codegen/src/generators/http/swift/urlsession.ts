/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { defineHttpGenerator } from '../../../core/define';
import { literalOrBlock, swiftDialect } from '../../../core/dialects';
import {
    DEFAULT_FILE_TYPE,
    baseName,
    bodyText,
    mimeQuoted,
    seconds,
    type HttpModel,
} from '../../../core/model';
import type { CodeWriter } from '../../../core/writer';

const str = swiftDialect.literal;

/** Customises redirects and certificate checks, the two things `URLSession.shared` cannot. */
const writeDelegate = (out: CodeWriter, model: HttpModel): void => {
    out.block('final class SessionDelegate: NSObject, URLSessionTaskDelegate {', '}', () => {
        if (!model.followRedirects) {
            out.block(
                'func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {',
                '}',
                () => out.line('completionHandler(nil)'),
            );
        }
        if (!model.verifyTls) {
            if (!model.followRedirects) out.blank();
            out.line('// Certificate verification is off for this request.');
            out.block(
                'func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {',
                '}',
                () => {
                    out.block(
                        'guard let trust = challenge.protectionSpace.serverTrust else {',
                        '}',
                        () => {
                            out.line('completionHandler(.performDefaultHandling, nil)');
                            out.line('return');
                        },
                    );
                    out.line('completionHandler(.useCredential, URLCredential(trust: trust))');
                },
            );
        }
    });
    out.blank();
};

/** `Data` for a literal: `Data("…".utf8)`. */
const data = (literal: string) => `Data(${literal}.utf8)`;

const writeBody = (out: CodeWriter, model: HttpModel): void => {
    const { body } = model;
    switch (body.kind) {
        case 'json':
        case 'markup':
        case 'text':
            out.line(
                `request.httpBody = ${data(literalOrBlock(swiftDialect, body.text, out.indentation + out.unit, body.kind !== 'text'))}`,
            );
            break;
        case 'form':
            out.line(`request.httpBody = ${data(str(bodyText(body) ?? ''))}`);
            break;
        case 'file':
            out.line(
                `request.httpBody = try Data(contentsOf: URL(fileURLWithPath: ${str(body.fileName)}))`,
            );
            break;
        case 'multipart': {
            out.line('let boundary = "Boundary-\\(UUID().uuidString)"');
            out.line('var form = Data()');
            const append = (text: string) =>
                out.line(`form.append(${data(`("--" + boundary + ${str(text)})`)})`);
            for (const part of body.parts) {
                if ('fileName' in part) {
                    append(
                        `\r\nContent-Disposition: form-data; name="${mimeQuoted(part.name)}"; filename="${mimeQuoted(baseName(part.fileName))}"\r\nContent-Type: ${DEFAULT_FILE_TYPE}\r\n\r\n`,
                    );
                    out.line(
                        `form.append(try Data(contentsOf: URL(fileURLWithPath: ${str(part.fileName)})))`,
                    );
                    out.line(`form.append(${data('"\\r\\n"')})`);
                } else {
                    append(
                        `\r\nContent-Disposition: form-data; name="${mimeQuoted(part.name)}"\r\n\r\n${part.value}\r\n`,
                    );
                }
            }
            out.line(`form.append(${data('("--" + boundary + "--\\r\\n")')})`);
            out.line(
                'request.setValue("multipart/form-data; boundary=" + boundary, forHTTPHeaderField: "Content-Type")',
            );
            out.line('request.httpBody = form');
            break;
        }
        default:
            break;
    }
};

export const swiftUrlSessionGenerator = defineHttpGenerator({
    id: 'swift-urlsession',
    label: 'Swift – URLSession',
    language: 'Swift',
    editorLanguage: 'swift',
    fileExtension: 'swift',
    requirements: 'Swift 5.7+',
    render(model, out) {
        out.line('import Foundation').blank();
        const delegate = !model.followRedirects || !model.verifyTls;
        if (delegate) writeDelegate(out, model);

        out.line(`var request = URLRequest(url: URL(string: ${str(model.url)})!)`);
        out.line(`request.httpMethod = ${str(model.method)}`);
        if (model.timeoutMs > 0) out.line(`request.timeoutInterval = ${seconds(model.timeoutMs)}`);
        for (const header of model.headers) {
            out.line(
                `request.setValue(${str(header.value)}, forHTTPHeaderField: ${str(header.name)})`,
            );
        }
        writeBody(out, model);
        out.blank();

        const session = delegate
            ? 'URLSession(configuration: .default, delegate: SessionDelegate(), delegateQueue: nil)'
            : 'URLSession.shared';
        out.line(`let (data, response) = try await ${session}.data(for: request)`);
        out.line('if let http = response as? HTTPURLResponse { print(http.statusCode) }');
        out.line('print(String(decoding: data, as: UTF8.self))');
    },
});
