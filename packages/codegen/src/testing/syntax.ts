/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { join } from 'node:path';
import ts from 'typescript';

/**
 * Checks of generated JavaScript and TypeScript with the TypeScript compiler, which every
 * contributor already has. Other languages are checked with their own toolchains in
 * `toolchains.test.ts`, where those are installed.
 */

/** Syntax errors in a module, as messages. An empty list means the code parses. */
export const syntaxErrors = (code: string, fileName = 'sample.ts'): string[] =>
    (
        ts.transpileModule(code, {
            fileName,
            reportDiagnostics: true,
            compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
        }).diagnostics ?? []
    ).map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));

const OPTIONS: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
    types: ['node'],
    strict: true,
    noEmit: true,
    skipLibCheck: true,
};

/** Reused between calls so the standard library is parsed once, not per snippet. */
let previous: ts.Program | undefined;

/** Type errors in a TypeScript module, resolved against the DOM and Node.js typings. */
export const typeErrors = (code: string): string[] => {
    // A path inside the repository, so `@types/node` resolves from the root node_modules.
    // (TypeScript names files with forward slashes on every platform.)
    const virtual = join(process.cwd(), 'packages', 'codegen', 'src', '__generated__.ts').replace(
        /\\/g,
        '/',
    );
    const host = ts.createCompilerHost(OPTIONS);
    const readFile = host.readFile.bind(host);
    const getSourceFile = host.getSourceFile.bind(host);
    host.fileExists = (name) => name === virtual || ts.sys.fileExists(name);
    host.readFile = (name) => (name === virtual ? code : readFile(name));
    host.getSourceFile = (name, languageVersion, ...rest) =>
        name === virtual
            ? ts.createSourceFile(name, code, languageVersion)
            : getSourceFile(name, languageVersion, ...rest);
    previous = ts.createProgram([virtual], OPTIONS, host, previous);
    return ts
        .getPreEmitDiagnostics(previous)
        .filter((diagnostic) => diagnostic.file?.fileName === virtual || !diagnostic.file)
        .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
};
