/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import type {
    CodeGenerator,
    CodegenOptions,
    CodegenRequest,
    HttpCodegenRequest,
    ProtocolId,
} from '@httpreq/shared';
import { toHttpModel, type HttpModel } from './model';
import { CodeWriter } from './writer';

/**
 * Everything that makes one target: its identity and a `render` function that writes the code for
 * a request. Adding a language is one spec in one file and one line in the generator list; no
 * other generator, the registry or the UI changes.
 */
export interface GeneratorSpec<R extends CodegenRequest, Input = R> {
    id: string;
    label: string;
    /** Groups targets in the selector, e.g. `Java`. */
    language: string;
    /** Monaco language id. */
    editorLanguage: string;
    /** File extension without the dot. */
    fileExtension: string;
    /** Runtime or library version the output needs, shown beside the selector. */
    requirements?: string;
    /** `option` follows the indentation setting; Go is always a tab (gofmt), Ruby two spaces. */
    indent?: 'option' | 'tab' | number;
    render(input: Input, out: CodeWriter, options: CodegenOptions): void;
}

const indentUnit = (indent: GeneratorSpec<CodegenRequest>['indent'], options: CodegenOptions) =>
    indent === 'tab' ? '\t' : ' '.repeat(typeof indent === 'number' ? indent : options.indent);

/** Template method: the spec supplies the language-specific step, this supplies the rest. */
const build = <R extends CodegenRequest, Input>(
    spec: GeneratorSpec<R, Input>,
    protocols: readonly ProtocolId[],
    prepare: (request: R) => Input,
): CodeGenerator<R> => ({
    id: spec.id,
    label: spec.label,
    language: spec.language,
    editorLanguage: spec.editorLanguage,
    fileExtension: spec.fileExtension,
    requirements: spec.requirements,
    protocols,
    generate(request, options) {
        const out = new CodeWriter(indentUnit(spec.indent, options));
        spec.render(prepare(request), out, options);
        return out.toString();
    },
});

/** An HTTP target: it renders from the normalised {@link HttpModel}, not the raw request. */
export const defineHttpGenerator = (
    spec: GeneratorSpec<HttpCodegenRequest, HttpModel>,
): CodeGenerator<HttpCodegenRequest> => build(spec, ['http', 'soap'], toHttpModel);

/** A target for a protocol with its own request shape (gRPC, MQTT). */
export const defineProtocolGenerator = <R extends CodegenRequest>(
    spec: GeneratorSpec<R> & { protocol: ProtocolId },
): CodeGenerator<R> => build(spec, [spec.protocol], (request) => request);
