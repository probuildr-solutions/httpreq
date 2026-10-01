/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import {
    AppError,
    protocolOf,
    type ExecutionHooks,
    type GrpcRuntime,
    type HttpRequest,
    type HttpResponse,
    type HttpRuntime,
    type ProtocolId,
} from '@httpreq/shared';
import { executeRequest, type PipelineContext } from '../pipeline';
import { buildGrpcCall, grpcToHttpResponse } from './grpc/build';

export * from './common';
export * from './grpc/build';
export * from './grpc/proto';
export * from './grpc/runtime';
export * from './mqtt/build';
export * from './mqtt/runtime';
export * from './soap/adapter';
export * from './soap/wsdl';
export * from './soap/xml';

/**
 * Protocol execution is a registry of strategies keyed by protocol id. The caller picks nothing:
 * {@link executeProtocolRequest} looks the request's protocol up, so adding a protocol means
 * registering an executor, never editing a switch in the pipeline or the UI.
 */

/** The transports an executor may need. HTTP is always present; the others only on the desktop. */
export interface ProtocolRuntimes {
    http: HttpRuntime;
    grpc: GrpcRuntime;
}

export interface ProtocolExecution {
    /** Every protocol's result is shaped as an HTTP response, so one viewer and one history serve all. */
    response: HttpResponse;
    warnings: string[];
}

export interface ProtocolExecutor {
    readonly id: ProtocolId;
    execute(
        request: HttpRequest,
        context: PipelineContext,
        runtimes: ProtocolRuntimes,
        signal?: AbortSignal,
        hooks?: ExecutionHooks,
    ): Promise<ProtocolExecution>;
}

const registry = new Map<ProtocolId, ProtocolExecutor>();

export const registerProtocolExecutor = (executor: ProtocolExecutor) => {
    registry.set(executor.id, executor);
};

export const getProtocolExecutor = (id: ProtocolId): ProtocolExecutor | undefined =>
    registry.get(id);

/** HTTP, and SOAP, which `buildRequest` reshapes into HTTP before anything else happens. */
const httpExecutor = (id: 'http' | 'soap'): ProtocolExecutor => ({
    id,
    execute: async (request, context, runtimes, signal, hooks) => {
        const { response, built } = await executeRequest(
            request,
            context,
            runtimes.http,
            signal,
            hooks,
        );
        return { response, warnings: built.warnings };
    },
});

const grpcExecutor: ProtocolExecutor = {
    id: 'grpc',
    execute: async (request, context, runtimes, signal) => {
        if (!runtimes.grpc.available) {
            throw new AppError('INVALID_REQUEST', 'gRPC calls need the HttpReq desktop app.');
        }
        const built = await buildGrpcCall(request, context);
        const raw = await runtimes.grpc.call(built.prepared, signal);
        const response = grpcToHttpResponse(raw, built.serverStreaming);
        await context.scripts?.postResponse?.(response, request);
        return { response, warnings: built.warnings };
    },
};

registerProtocolExecutor(httpExecutor('http'));
registerProtocolExecutor(httpExecutor('soap'));
registerProtocolExecutor(grpcExecutor);

/**
 * Sends a request over whatever protocol it uses. MQTT is not here on purpose: it is a session
 * (connect, subscribe, publish), driven by its own editor, not a single exchange.
 */
export const executeProtocolRequest = (
    request: HttpRequest,
    context: PipelineContext,
    runtimes: ProtocolRuntimes,
    signal?: AbortSignal,
    hooks?: ExecutionHooks,
): Promise<ProtocolExecution> => {
    const protocol = protocolOf(request);
    const executor = registry.get(protocol);
    if (!executor) {
        return Promise.reject(
            new AppError(
                'INVALID_REQUEST',
                protocol === 'mqtt'
                    ? 'An MQTT request connects to a broker. Use Connect, then Publish.'
                    : `There is no executor for the “${protocol}” protocol.`,
            ),
        );
    }
    return executor.execute(request, context, runtimes, signal, hooks);
};
