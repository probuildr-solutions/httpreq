/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { defineHttpGenerator } from '../../../core/define';
import { goDialect, literalOrBlock } from '../../../core/dialects';
import { baseName, bodyText, type HttpModel } from '../../../core/model';
import type { CodeWriter } from '../../../core/writer';

const str = goDialect.literal;

const METHODS: Record<string, string> = {
    GET: 'MethodGet',
    POST: 'MethodPost',
    PUT: 'MethodPut',
    PATCH: 'MethodPatch',
    DELETE: 'MethodDelete',
    HEAD: 'MethodHead',
    OPTIONS: 'MethodOptions',
};

const importsFor = (model: HttpModel): string[] => {
    const { body } = model;
    const imports = new Set(['fmt', 'io', 'log', 'net/http']);
    if (!model.verifyTls) imports.add('crypto/tls');
    if (model.timeoutMs > 0) imports.add('time');
    if (['json', 'markup', 'text', 'form'].includes(body.kind)) imports.add('strings');
    if (body.kind === 'file') imports.add('os');
    if (body.kind === 'multipart') {
        imports.add('bytes');
        imports.add('mime/multipart');
        if (body.parts.some((part) => 'fileName' in part)) imports.add('os');
    }
    return [...imports].sort();
};

/** `if err != nil { log.Fatal(err) }`, the check Go code repeats after every fallible call. */
const check = (out: CodeWriter) =>
    out.block('if err != nil {', '}', () => out.line('log.Fatal(err)'));

/** gofmt aligns the values of consecutive `key: value` lines in a composite literal. */
const writeFields = (out: CodeWriter, fields: [string, string][]) => {
    const width = Math.max(...fields.map(([key]) => key.length));
    for (const [key, value] of fields) out.line(`${`${key}:`.padEnd(width + 1)} ${value},`);
};

/** Declares the request body and returns the argument for `http.NewRequest`. */
const writeBody = (out: CodeWriter, model: HttpModel): string => {
    const { body } = model;
    switch (body.kind) {
        case 'json':
        case 'markup':
        case 'text':
            out.line(
                `payload := strings.NewReader(${literalOrBlock(goDialect, body.text, '', body.kind !== 'text')})`,
            );
            return 'payload';
        case 'form':
            out.line(`payload := strings.NewReader(${str(bodyText(body) ?? '')})`);
            return 'payload';
        case 'file':
            out.line(`file, err := os.Open(${str(body.fileName)})`);
            check(out);
            out.line('defer file.Close()');
            return 'file';
        case 'multipart': {
            out.line('var payload bytes.Buffer');
            out.line('writer := multipart.NewWriter(&payload)');
            out.blank();
            let files = 0;
            for (const part of body.parts) {
                if (!('fileName' in part)) {
                    out.block(
                        `if err := writer.WriteField(${str(part.name)}, ${str(part.value)}); err != nil {`,
                        '}',
                        () => out.line('log.Fatal(err)'),
                    );
                    continue;
                }
                // Each file gets its own names, so the statements never redeclare one another.
                const suffix = files === 0 ? '' : String(files + 1);
                files += 1;
                out.line(`file${suffix}, err := os.Open(${str(part.fileName)})`);
                check(out);
                out.line(
                    `part${suffix}, err := writer.CreateFormFile(${str(part.name)}, ${str(baseName(part.fileName))})`,
                );
                check(out);
                out.line(`_, err = io.Copy(part${suffix}, file${suffix})`);
                check(out);
                out.line(`file${suffix}.Close()`);
            }
            out.block('if err := writer.Close(); err != nil {', '}', () =>
                out.line('log.Fatal(err)'),
            );
            return '&payload';
        }
        default:
            return 'nil';
    }
};

export const goNetHttpGenerator = defineHttpGenerator({
    id: 'go-nethttp',
    label: 'Go – net/http',
    language: 'Go',
    editorLanguage: 'go',
    fileExtension: 'go',
    indent: 'tab',
    render(model, out) {
        out.line('package main').blank();
        out.block('import (', ')', () =>
            importsFor(model).forEach((name) => out.line(`"${name}"`)),
        );
        out.blank();
        out.block('func main() {', '}', () => {
            const payload = writeBody(out, model);
            if (model.body.kind !== 'none') out.blank();

            const method = METHODS[model.method];
            out.line(
                `req, err := http.NewRequest(${method ? `http.${method}` : str(model.method)}, ${str(model.url)}, ${payload})`,
            );
            check(out);
            for (const header of model.headers) {
                // `Host` is not a header on a Go request: it is a field.
                out.line(
                    header.name.toLowerCase() === 'host'
                        ? `req.Host = ${str(header.value)}`
                        : `req.Header.Set(${str(header.name)}, ${str(header.value)})`,
                );
            }
            if (model.body.kind === 'multipart') {
                out.line('req.Header.Set("Content-Type", writer.FormDataContentType())');
            }
            out.blank();

            const fields: [string, string][] = [];
            if (model.timeoutMs > 0)
                fields.push(['Timeout', `${model.timeoutMs} * time.Millisecond`]);
            if (!model.followRedirects) {
                fields.push([
                    'CheckRedirect',
                    'func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }',
                ]);
            }
            if (!model.verifyTls) {
                out.line('transport := http.DefaultTransport.(*http.Transport).Clone()');
                out.line('transport.TLSClientConfig = &tls.Config{InsecureSkipVerify: true}');
                fields.push(['Transport', 'transport']);
            }
            if (fields.length > 0)
                out.block('client := &http.Client{', '}', () => writeFields(out, fields));
            out.line(`res, err := ${fields.length > 0 ? 'client' : 'http.DefaultClient'}.Do(req)`);
            check(out);
            out.line('defer res.Body.Close()');
            out.blank();
            out.line('data, err := io.ReadAll(res.Body)');
            check(out);
            out.line('fmt.Println(res.Status)');
            out.line('fmt.Println(string(data))');
        });
    },
});
