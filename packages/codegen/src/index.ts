/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import {
    DEFAULT_CODEGEN_OPTIONS,
    type CodegenOptions,
    type CodegenResult,
    type HttpRequest,
} from '@httpreq/shared';
import type { PipelineContext } from '@httpreq/api-client';
import { buildCodegenRequest, codegenFailureReason } from './input';
import { DEFAULT_GENERATORS } from './generators';
import { CodeGeneratorRegistry } from './registry';

export * from './core/json';
export * from './core/model';
export { CodeWriter } from './core/writer';
export { defineHttpGenerator, defineProtocolGenerator } from './core/define';
export * from './errors';
export * from './input';
export * from './redact';
export * from './registry';

/** A registry holding every generator the app ships with (see `DEFAULT_GENERATORS`). */
export const createDefaultCodegenRegistry = (): CodeGeneratorRegistry =>
    DEFAULT_GENERATORS.reduce(
        (registry, generator) => registry.register(generator),
        new CodeGeneratorRegistry(),
    );

export const defaultCodegen = createDefaultCodegenRegistry();

/**
 * Builds the request and generates code in one step. Anything that stops the request from being
 * built (no URL, an undefined variable, an unreadable proto) comes back as an `unsupported`
 * result with the reason, so the viewer has one failure path to render.
 */
export const generateCodeForRequest = async (
    request: HttpRequest,
    context: PipelineContext,
    generatorId: string,
    options: Partial<CodegenOptions> = {},
    registry: CodeGeneratorRegistry = defaultCodegen,
): Promise<CodegenResult> => {
    const merged = { ...DEFAULT_CODEGEN_OPTIONS, ...options };
    try {
        const input = await buildCodegenRequest(request, context, {
            includeSecrets: merged.includeSecrets,
        });
        return registry.generate(input, generatorId, merged);
    } catch (error) {
        return { supported: false, reason: codegenFailureReason(error) };
    }
};
