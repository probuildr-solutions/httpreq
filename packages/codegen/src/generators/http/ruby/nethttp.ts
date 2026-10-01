/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { defineHttpGenerator } from '../../../core/define';
import { literalOrBlock, rubyDialect } from '../../../core/dialects';
import { bodyText, seconds, type HttpModel } from '../../../core/model';
import type { CodeWriter } from '../../../core/writer';

const str = rubyDialect.literal;

const REQUEST_CLASSES: Record<string, string> = {
    GET: 'Get',
    POST: 'Post',
    PUT: 'Put',
    PATCH: 'Patch',
    DELETE: 'Delete',
    HEAD: 'Head',
    OPTIONS: 'Options',
};

const writeBody = (out: CodeWriter, model: HttpModel): void => {
    const { body } = model;
    switch (body.kind) {
        case 'json':
        case 'markup':
        case 'text':
            out.line(
                `request.body = ${literalOrBlock(rubyDialect, body.text, out.indentation + out.unit, body.kind !== 'text')}`,
            );
            break;
        case 'form':
            out.line(`request.body = ${str(bodyText(body) ?? '')}`);
            break;
        case 'file':
            out.line(`request.body = File.binread(${str(body.fileName)})`);
            break;
        case 'multipart':
            out.block('request.set_form([', "], 'multipart/form-data')", () =>
                body.parts.forEach((part) =>
                    out.line(
                        'fileName' in part
                            ? `[${str(part.name)}, File.open(${str(part.fileName)})],`
                            : `[${str(part.name)}, ${str(part.value)}],`,
                    ),
                ),
            );
            break;
        default:
            break;
    }
};

export const rubyNetHttpGenerator = defineHttpGenerator({
    id: 'ruby-nethttp',
    label: 'Ruby – Net::HTTP',
    language: 'Ruby',
    editorLanguage: 'ruby',
    fileExtension: 'rb',
    indent: 2,
    render(model, out) {
        out.line("require 'net/http'");
        if (!model.verifyTls) out.line("require 'openssl'");
        out.line("require 'uri'").blank();
        out.line(`uri = URI(${str(model.url)})`);
        const klass = REQUEST_CLASSES[model.method];
        out.line(
            klass
                ? `request = Net::HTTP::${klass}.new(uri)`
                : `request = Net::HTTPGenericRequest.new(${str(model.method)}, true, true, uri)`,
        );
        for (const header of model.headers) {
            out.line(`request[${str(header.name)}] = ${str(header.value)}`);
        }
        writeBody(out, model);
        out.blank();

        const options = [
            "use_ssl: uri.scheme == 'https'",
            !model.verifyTls && 'verify_mode: OpenSSL::SSL::VERIFY_NONE',
            model.timeoutMs > 0 && `read_timeout: ${seconds(model.timeoutMs)}`,
        ].filter((option): option is string => typeof option === 'string');
        out.block(
            `response = Net::HTTP.start(uri.hostname, uri.port, ${options.join(', ')}) do |http|`,
            'end',
            () => out.line('http.request(request)'),
        );
        out.blank();
        out.line('puts response.code');
        out.line('puts response.body');
    },
});
