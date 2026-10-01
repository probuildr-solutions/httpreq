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
import {
    grpcurlGenerator,
    mosquittoGenerator,
    nodeGrpcGenerator,
    nodeMqttGenerator,
    pythonPahoGenerator,
} from './generators/grpc-mqtt';
import { csharpHttpClientGenerator, goNetHttpGenerator } from './generators/http-csharp-go';
import {
    curlGenerator,
    javascriptFetchGenerator,
    nodeAxiosGenerator,
} from './generators/http-curl-js';
import {
    phpCurlGenerator,
    powershellGenerator,
    rubyNetHttpGenerator,
    swiftUrlSessionGenerator,
} from './generators/http-others';
import { javaHttpClientGenerator, pythonRequestsGenerator } from './generators/http-python-java';
import { buildCodegenRequest, codegenFailureReason } from './input';
import { CodeGeneratorRegistry } from './registry';

export * from './errors';
export * from './input';
export * from './redact';
export * from './registry';

/** The generators the app ships with, in the order the selector lists them. */
export const createDefaultCodegenRegistry = (): CodeGeneratorRegistry =>
    new CodeGeneratorRegistry()
        .register(curlGenerator)
        .register(javascriptFetchGenerator)
        .register(nodeAxiosGenerator)
        .register(pythonRequestsGenerator)
        .register(javaHttpClientGenerator)
        .register(csharpHttpClientGenerator)
        .register(goNetHttpGenerator)
        .register(phpCurlGenerator)
        .register(rubyNetHttpGenerator)
        .register(powershellGenerator)
        .register(swiftUrlSessionGenerator)
        .register(grpcurlGenerator)
        .register(nodeGrpcGenerator)
        .register(mosquittoGenerator)
        .register(nodeMqttGenerator)
        .register(pythonPahoGenerator);

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
