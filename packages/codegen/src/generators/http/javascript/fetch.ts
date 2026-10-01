/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { defineHttpGenerator } from '../../../core/define';
import type { HttpModel } from '../../../core/model';
import type { CodeWriter } from '../../../core/writer';
import { bodyExpression, readsFiles, str, writeFormData, writeHeaders } from './shared';

/** The options object of `fetch`, one entry per line; nothing is written for a plain GET. */
const writeOptions = (model: HttpModel, out: CodeWriter): void => {
    if (model.method !== 'GET') out.line(`method: ${str(model.method)},`);
    if (model.headers.length > 0) {
        out.block('headers: {', '},', () => writeHeaders(out, model));
    }
    const expression = bodyExpression(out, model.body);
    if (expression !== undefined) out.line(`body: ${expression},`);
    if (!model.followRedirects) out.line('redirect: "manual",');
    if (model.timeoutMs > 0) out.line(`signal: AbortSignal.timeout(${model.timeoutMs}),`);
};

const hasOptions = (model: HttpModel): boolean =>
    model.method !== 'GET' ||
    model.headers.length > 0 ||
    model.body.kind !== 'none' ||
    !model.followRedirects ||
    model.timeoutMs > 0;

const writeTlsNote = (model: HttpModel, out: CodeWriter): void => {
    if (model.verifyTls) return;
    out.line(
        '// Certificate verification is off for this request: in Node.js, run with NODE_TLS_REJECT_UNAUTHORIZED=0.',
    );
};

/** An ES module: top-level `await`, so it runs as `.mjs` or in a module script. */
const writeJavaScript = (model: HttpModel, out: CodeWriter): void => {
    if (readsFiles(model.body)) out.line('import { openAsBlob } from "node:fs";').blank();
    writeTlsNote(model, out);
    writeFormData(out, model.body);
    if (hasOptions(model)) {
        out.block(`const response = await fetch(${str(model.url)}, {`, '});', () =>
            writeOptions(model, out),
        );
    } else {
        out.line(`const response = await fetch(${str(model.url)});`);
    }
    out.blank();
    out.line('console.log(response.status);');
    out.line('console.log(await response.text());');
};

/**
 * TypeScript is wrapped in `main()`: top-level `await` is a compile error in a file that is not
 * a module and in a project that compiles to CommonJS, and a snippet should work in either.
 */
const writeTypeScript = (model: HttpModel, out: CodeWriter): void => {
    if (readsFiles(model.body)) out.line('import { openAsBlob } from "node:fs";').blank();
    out.block('async function main(): Promise<void> {', '}', () => {
        writeTlsNote(model, out);
        writeFormData(out, model.body);
        out.line(`const url = ${str(model.url)};`);
        if (hasOptions(model)) {
            out.block('const options: RequestInit = {', '};', () => writeOptions(model, out));
        }
        out.blank();
        out.line(
            `const response: Response = await fetch(url${hasOptions(model) ? ', options' : ''});`,
        );
        out.line('const text: string = await response.text();');
        out.blank();
        out.line('console.log(response.status, text);');
    });
    out.blank();
    out.line('main().catch(console.error);');
};

export const javascriptFetchGenerator = defineHttpGenerator({
    id: 'javascript-fetch',
    label: 'JavaScript – fetch',
    language: 'JavaScript',
    editorLanguage: 'javascript',
    fileExtension: 'mjs',
    requirements: 'ES module: Node.js 20+ or a browser',
    render: writeJavaScript,
});

export const typescriptFetchGenerator = defineHttpGenerator({
    id: 'typescript-fetch',
    label: 'TypeScript – fetch',
    language: 'TypeScript',
    editorLanguage: 'typescript',
    fileExtension: 'ts',
    requirements: 'Node.js 20+ or a browser',
    render: writeTypeScript,
});
