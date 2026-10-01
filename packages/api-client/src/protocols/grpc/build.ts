/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import {
    AppError,
    createGrpcConfig,
    grpcStatusName,
    type GrpcResponse,
    type HttpRequest,
    type HttpResponse,
    type PreparedGrpcCall,
} from '@httpreq/shared';
import type { AuthContext } from '../../auth/types';
import { runPreRequestScripts, type PipelineContext } from '../../pipeline';
import { createVariableResolver } from '../../variables';
import { applyProtocolAuth, parseProtocolUrl, toMetadata } from '../common';
import { encodeMessage, loadProtoRoot, resolveMethod } from './proto';

export interface BuiltGrpc {
    prepared: PreparedGrpcCall;
    warnings: string[];
    serverStreaming: boolean;
}

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const TLS_SCHEMES = new Set(['grpcs', 'https']);

/**
 * The gRPC half of the pipeline, mirroring HTTP's: variables are resolved once, authorization is
 * applied by the same providers (a Bearer token becomes the `authorization` metadata), and the
 * saved request is never mutated. The result is the only shape that crosses into a runtime.
 */
export const buildGrpcCall = async (
    request: HttpRequest,
    context: PipelineContext,
): Promise<BuiltGrpc> => {
    const config = request.grpc ?? createGrpcConfig();
    const warnings: string[] = [];
    if (config.protoFiles.length === 0) {
        throw new AppError(
            'INVALID_REQUEST',
            'Add a .proto file, then choose a service and method.',
        );
    }
    if (!config.service || !config.method) {
        throw new AppError('INVALID_REQUEST', 'Choose the service and method to call.');
    }

    const resolver = createVariableResolver(context.environment, context.resolverOptions);
    const authContext: AuthContext = { resolve: resolver.resolve, now: context.now ?? Date.now };
    let text = resolver.resolve(request.url.trim());
    if (text && !SCHEME.test(text) && !text.startsWith('{{')) text = `grpc://${text}`;
    const url = parseProtocolUrl(
        text,
        resolver,
        context.environment,
        ['grpc', 'grpcs', 'http', 'https'],
        'gRPC',
        'grpc://localhost:50051',
    );
    const scheme = url.protocol.replace(/:$/, '').toLowerCase();
    const tls = TLS_SCHEMES.has(scheme);
    // The authorization providers work on an HTTP(S) URL for the same host.
    const draftUrl = new URL(`${tls ? 'https' : 'http'}://${url.host}${url.pathname}${url.search}`);
    const applied = await applyProtocolAuth(
        request,
        context.workspace,
        authContext,
        resolver,
        draftUrl,
    );

    const root = loadProtoRoot(config.protoFiles);
    const method = resolveMethod(root, config.service, config.method);
    if (method.method.requestStream) {
        throw new AppError(
            'INVALID_REQUEST',
            `${config.method} streams requests (client or bidirectional streaming), which is not supported. Unary and server-streaming methods are.`,
        );
    }

    let message = request.body.mode === 'json' ? resolver.resolve(request.body.json) : '{}';
    let metadata = applied.headers.toRecord();
    const scripted = await runPreRequestScripts(
        context.scripts,
        { method: 'GRPC', url: url.host, headers: metadata, body: message, bodyEditable: true },
        request,
    );
    if (scripted) {
        metadata = scripted.headers;
        message = scripted.body ?? message;
    }
    // Fails here, before anything is sent, if the message does not fit the method's input type.
    encodeMessage(method.requestType, message);
    if (resolver.unresolved.size > 0) {
        warnings.push(
            `Not defined, sent as written: ${[...resolver.unresolved].map((name) => `{{${name}}}`).join(', ')}.`,
        );
    }

    const port = url.port || (tls ? '443' : '80');
    return {
        prepared: {
            target: `${url.hostname}:${port}`,
            tls,
            verifyTls: request.settings.verifyTls,
            protoFiles: config.protoFiles,
            service: config.service,
            method: config.method,
            message,
            metadata: toMetadata(metadata),
            deadlineMs: config.deadlineMs,
            maxResponseBytes: Math.round(request.settings.responseSizeLimitMb * 1024 * 1024),
        },
        warnings,
        serverStreaming: !!method.method.responseStream,
    };
};

/** The closest HTTP status for a gRPC code, as the gRPC-to-HTTP mapping defines it. */
const HTTP_STATUS: Record<number, number> = {
    0: 200,
    1: 499,
    2: 500,
    3: 400,
    4: 504,
    5: 404,
    6: 409,
    7: 403,
    8: 429,
    9: 400,
    10: 409,
    11: 400,
    12: 501,
    13: 500,
    14: 503,
    15: 500,
    16: 401,
};

const pretty = (json: string) => {
    try {
        return JSON.stringify(JSON.parse(json) as unknown, null, 2);
    } catch {
        return json;
    }
};

/**
 * Shapes a gRPC result like an HTTP response so the response viewer, history and scripts work on
 * it unchanged. The real status travels in `grpc`.
 */
export const grpcToHttpResponse = (
    response: GrpcResponse,
    serverStreaming: boolean,
): HttpResponse => {
    const { status } = response;
    let body: string;
    if (status.code !== 0 && response.messages.length === 0) {
        body = JSON.stringify(
            { code: status.code, status: grpcStatusName(status.code), details: status.details },
            null,
            2,
        );
    } else if (serverStreaming) {
        body = pretty(`[${response.messages.join(',')}]`);
    } else {
        body = pretty(response.messages[0] ?? '{}');
    }
    return {
        status: HTTP_STATUS[status.code] ?? 500,
        statusText: grpcStatusName(status.code),
        headers: response.headers,
        body,
        contentType: 'application/json',
        durationMs: response.durationMs,
        sizeBytes: response.sizeBytes,
        grpc: {
            code: status.code,
            name: grpcStatusName(status.code),
            details: status.details,
            trailers: response.trailers,
        },
    };
};
