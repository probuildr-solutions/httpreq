/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import type { IpcResult } from './index';

/**
 * gRPC domain model. A gRPC request is an `HttpRequest` whose `protocol` is `grpc`: the URL is the
 * server (`grpc://host:port`, `grpcs://` for TLS), `headers` are the call metadata, and the JSON
 * request message is the body. This configuration adds what only gRPC needs.
 */

export interface ProtoFile {
    /** Import name, e.g. `acme/orders.proto`. The first file is the entry point. */
    name: string;
    content: string;
}

export interface GrpcConfig {
    /** The service definition: the first file is the entry point, the rest satisfy its imports. */
    protoFiles: ProtoFile[];
    /** Fully qualified service name, e.g. `acme.orders.OrderService`. */
    service: string;
    method: string;
    /** Milliseconds before the call is cancelled with DEADLINE_EXCEEDED; 0 sets no deadline. */
    deadlineMs: number;
}

export const createGrpcConfig = (): GrpcConfig => ({
    protoFiles: [],
    service: '',
    method: '',
    deadlineMs: 30_000,
});

/** What a parsed `.proto` offers: the data behind the service/method pickers. */
export interface ProtoMethod {
    name: string;
    requestType: string;
    responseType: string;
    clientStreaming: boolean;
    serverStreaming: boolean;
}

export interface ProtoService {
    /** Fully qualified, e.g. `acme.orders.OrderService`. */
    fullName: string;
    name: string;
    methods: ProtoMethod[];
}

export interface ProtoDescription {
    services: ProtoService[];
}

/** gRPC status codes, from the gRPC specification. */
export const GRPC_STATUS_NAMES = [
    'OK',
    'CANCELLED',
    'UNKNOWN',
    'INVALID_ARGUMENT',
    'DEADLINE_EXCEEDED',
    'NOT_FOUND',
    'ALREADY_EXISTS',
    'PERMISSION_DENIED',
    'RESOURCE_EXHAUSTED',
    'FAILED_PRECONDITION',
    'ABORTED',
    'OUT_OF_RANGE',
    'UNIMPLEMENTED',
    'INTERNAL',
    'UNAVAILABLE',
    'DATA_LOSS',
    'UNAUTHENTICATED',
] as const;

export const grpcStatusName = (code: number): string => GRPC_STATUS_NAMES[code] ?? `CODE_${code}`;

/** Everything the desktop transport needs for one call; variables resolved, auth applied. */
export interface PreparedGrpcCall {
    /** `host:port`. */
    target: string;
    tls: boolean;
    verifyTls: boolean;
    protoFiles: ProtoFile[];
    service: string;
    method: string;
    /** The request message as JSON text. */
    message: string;
    /** Lower-case keys, as gRPC requires. */
    metadata: Record<string, string>;
    deadlineMs: number;
    /** Largest decoded response accepted; 0 uses the transport default. */
    maxResponseBytes: number;
}

export interface GrpcResponse {
    /** `OK` and every other code, as the server reported it in the trailers. */
    status: { code: number; name: string; details: string };
    /** Initial metadata (response headers). */
    headers: Record<string, string>;
    trailers: Record<string, string>;
    /** Decoded messages as JSON text: one for unary, any number for server streaming. */
    messages: string[];
    durationMs: number;
    sizeBytes: number;
}

export interface GrpcRuntime {
    readonly kind: 'browser' | 'electron';
    /** False where the transport cannot run (a browser cannot speak native gRPC). */
    readonly available: boolean;
    call(prepared: PreparedGrpcCall, signal?: AbortSignal): Promise<GrpcResponse>;
}

/** gRPC operations the preload exposes. The main process owns the channel. */
export interface GrpcBridge {
    call(callId: string, prepared: PreparedGrpcCall): Promise<IpcResult<GrpcResponse>>;
    cancel(callId: string): void;
}
