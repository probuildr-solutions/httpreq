/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import type { CodeWriter } from '../../../core/writer';
import { jsDialect, literalOrBlock } from '../../../core/dialects';
import { renderJson, type JsonStyle } from '../../../core/json';
import { baseName, isIdentifier, type HttpModel, type ModelBody } from '../../../core/model';

/** Data literals as JavaScript and TypeScript write them: bare keys where possible. */
export const jsonStyle = (unit: string): JsonStyle => ({
    indent: unit,
    key: (name) => (isIdentifier(name) ? name : jsDialect.literal(name)),
    string: jsDialect.literal,
    constants: { null: 'null', true: 'true', false: 'false' },
    separator: ': ',
});

export const str = jsDialect.literal;

/** Whether the request reads a file from disk (a file body or a multipart file part). */
export const readsFiles = (body: ModelBody): boolean =>
    body.kind === 'file' ||
    (body.kind === 'multipart' && body.parts.some((part) => 'fileName' in part));

/** `Name: "value",` lines inside an object the caller has opened. Header names are always quoted. */
export const writeHeaders = (out: CodeWriter, model: HttpModel): void => {
    for (const header of model.headers) out.line(`${str(header.name)}: ${str(header.value)},`);
};

/** Builds the `FormData` a multipart body needs. Files are read with `openAsBlob` (Node.js 20+). */
export const writeFormData = (out: CodeWriter, body: ModelBody): void => {
    if (body.kind !== 'multipart') return;
    out.line('const form = new FormData();');
    for (const part of body.parts) {
        out.line(
            'fileName' in part
                ? `form.append(${str(part.name)}, await openAsBlob(${str(part.fileName)}), ${str(baseName(part.fileName))});`
                : `form.append(${str(part.name)}, ${str(part.value)});`,
        );
    }
    out.blank();
};

/**
 * The value of a request's `body` option as JavaScript source, or `undefined` when there is none.
 * A JSON document becomes `JSON.stringify({ … })`, a form `URLSearchParams`, markup a template
 * literal. `multipart` refers to the `form` that {@link writeFormData} declared.
 */
export const bodyExpression = (out: CodeWriter, body: ModelBody): string | undefined => {
    switch (body.kind) {
        case 'json':
            return body.value
                ? `JSON.stringify(${renderJson(body.value, out.indentation, jsonStyle(out.unit))})`
                : literalOrBlock(jsDialect, body.text, out.indentation, true);
        case 'markup':
            return literalOrBlock(jsDialect, body.text, out.indentation, true);
        case 'text':
            return str(body.text);
        case 'form': {
            const inner = out.indentation + out.unit;
            const pairs = body.fields.map((field) => `[${str(field.name)}, ${str(field.value)}]`);
            const inline = `new URLSearchParams([${pairs.join(', ')}])`;
            return inline.length <= 60
                ? inline
                : `new URLSearchParams([\n${pairs.map((pair) => `${inner}${pair},`).join('\n')}\n${out.indentation}])`;
        }
        case 'multipart':
            return 'form';
        case 'file':
            return `await openAsBlob(${str(body.fileName)})`;
        default:
            return undefined;
    }
};
