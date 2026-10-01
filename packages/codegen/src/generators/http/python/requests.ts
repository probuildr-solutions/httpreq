/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { defineHttpGenerator } from '../../../core/define';
import { literalOrBlock, pythonDialect } from '../../../core/dialects';
import { renderJson, type JsonStyle } from '../../../core/json';
import { baseName, seconds, type ModelBody } from '../../../core/model';
import type { CodeWriter } from '../../../core/writer';

const str = pythonDialect.literal;

const jsonStyle = (unit: string): JsonStyle => ({
    indent: unit,
    key: str,
    string: str,
    constants: { null: 'None', true: 'True', false: 'False' },
    separator: ': ',
});

/** `requests` sends a `str` body encoded as Latin-1, so text beyond it is encoded explicitly. */
const needsUtf8 = (text: string) => [...text].some((char) => char.codePointAt(0)! > 0xff);

/**
 * Declares the variables the call refers to and returns the keyword argument that carries the
 * body, e.g. `json=payload`.
 */
const writeBody = (out: CodeWriter, body: ModelBody): string | undefined => {
    switch (body.kind) {
        case 'json':
            if (body.value) {
                out.line(
                    `payload = ${renderJson(body.value, out.indentation, jsonStyle(out.unit))}`,
                );
                return 'json=payload';
            }
            break;
        case 'form': {
            const names = body.fields.map((field) => field.name);
            const pairs = body.fields.map((field) => `${str(field.name)}: ${str(field.value)}`);
            if (new Set(names).size === names.length) {
                out.block('payload = {', '}', () => pairs.forEach((pair) => out.line(`${pair},`)));
            } else {
                // A dictionary would drop repeated names.
                out.block('payload = [', ']', () =>
                    body.fields.forEach((field) =>
                        out.line(`(${str(field.name)}, ${str(field.value)}),`),
                    ),
                );
            }
            return 'data=payload';
        }
        case 'multipart':
            // `(None, value)` makes a text field, which keeps the parts in their written order.
            out.block('files = [', ']', () =>
                body.parts.forEach((part) =>
                    out.line(
                        'fileName' in part
                            ? `(${str(part.name)}, (${str(baseName(part.fileName))}, open(${str(part.fileName)}, "rb"))),`
                            : `(${str(part.name)}, (None, ${str(part.value)})),`,
                    ),
                ),
            );
            return 'files=files';
        case 'file':
            out.line(`payload = open(${str(body.fileName)}, "rb")`);
            return 'data=payload';
        default:
            if (body.kind === 'none') return undefined;
    }
    // JSON that is not shown as data, markup and plain text.
    const text =
        body.kind === 'json' || body.kind === 'markup' || body.kind === 'text' ? body.text : '';
    out.line(
        `payload = ${literalOrBlock(pythonDialect, text, out.indentation, body.kind !== 'text')}`,
    );
    return needsUtf8(text) ? 'data=payload.encode("utf-8")' : 'data=payload';
};

export const pythonRequestsGenerator = defineHttpGenerator({
    id: 'python-requests',
    label: 'Python – requests',
    language: 'Python',
    editorLanguage: 'python',
    fileExtension: 'py',
    requirements: 'Python 3, requests',
    render(model, out) {
        out.line('import requests').blank();
        out.line(`url = ${str(model.url)}`);
        if (model.headers.length > 0) {
            out.block('headers = {', '}', () =>
                model.headers.forEach((header) =>
                    out.line(`${str(header.name)}: ${str(header.value)},`),
                ),
            );
        }
        const bodyArgument = writeBody(out, model.body);
        out.blank();

        const args = [
            'url',
            model.headers.length > 0 && 'headers=headers',
            bodyArgument,
            !model.followRedirects && 'allow_redirects=False',
            !model.verifyTls && 'verify=False',
            model.timeoutMs > 0 && `timeout=${seconds(model.timeoutMs)}`,
        ].filter((arg): arg is string => typeof arg === 'string');
        const call = `requests.${model.method.toLowerCase()}`;
        if (args.length <= 2) {
            out.line(`response = ${call}(${args.join(', ')})`);
        } else {
            out.block(`response = ${call}(`, ')', () => args.forEach((arg) => out.line(`${arg},`)));
        }
        out.blank();
        out.line('print(response.status_code)');
        out.line('print(response.text)');
    },
});
