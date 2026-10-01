/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import * as grpc from '@grpc/grpc-js';
import { decodeMessage, encodeMessage, loadProtoRoot, resolveMethod } from '@httpreq/api-client';
import {
    AppError,
    grpcStatusName,
    redactText,
    type GrpcResponse,
    type PreparedGrpcCall,
    type ProtoFile,
} from '@httpreq/shared';

/**
 * gRPC calls for the desktop app.
 *
 * A browser cannot speak native gRPC, so the channel lives here, in the main process. Calls are
 * keyed by the window that made them (a window can only cancel its own), the `.proto` text is
 * parsed in memory (never read from disk, so a definition cannot reach files), and the payload
 * arrives re-validated by {@link parsePreparedGrpcCall}: unknown fields are dropped, so the
 * renderer cannot smuggle channel options through it.
 */

const MAX_FILES = 50;
const MAX_PROTO_TOTAL = 4 * 1024 * 1024;
const MAX_MESSAGE_CHARS = 16 * 1024 * 1024;
/** Used when the request does not set a response size limit. */
const DEFAULT_MAX_RECEIVE = 64 * 1024 * 1024;
const MAX_STREAM_MESSAGES = 10_000;

const HOST_PORT = /^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9._-]+):\d{1,5}$/;
const METADATA_KEY = /^[0-9a-z_.-]+$/;

const isObject = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value);

const parseProtoFiles = (value: unknown): ProtoFile[] | null => {
    if (!Array.isArray(value) || value.length === 0 || value.length > MAX_FILES) return null;
    const files: ProtoFile[] = [];
    let total = 0;
    for (const item of value) {
        if (!isObject(item) || typeof item.name !== 'string' || typeof item.content !== 'string') {
            return null;
        }
        total += item.content.length;
        files.push({ name: item.name.slice(0, 260), content: item.content });
    }
    return total <= MAX_PROTO_TOTAL ? files : null;
};

/** Rebuilds a prepared call from an untrusted IPC payload. Returns null when it is not usable. */
export const parsePreparedGrpcCall = (value: unknown): PreparedGrpcCall | null => {
    if (!isObject(value)) return null;
    const { target, service, method, message, metadata } = value;
    if (typeof target !== 'string' || !HOST_PORT.test(target)) return null;
    if (typeof service !== 'string' || !service || service.length > 512) return null;
    if (typeof method !== 'string' || !method || method.length > 256) return null;
    if (typeof message !== 'string' || message.length > MAX_MESSAGE_CHARS) return null;
    const protoFiles = parseProtoFiles(value.protoFiles);
    if (!protoFiles || !isObject(metadata)) return null;
    const cleanMetadata: Record<string, string> = {};
    for (const [key, item] of Object.entries(metadata)) {
        if (
            typeof item !== 'string' ||
            !METADATA_KEY.test(key) ||
            // Reserved by gRPC itself or the transport; the application must not set them.
            key.startsWith('grpc-') ||
            key.startsWith(':') ||
            /[\r\n\0]/.test(item)
        ) {
            return null;
        }
        cleanMetadata[key] = item;
    }
    const number = (candidate: unknown, max: number) =>
        typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0
            ? Math.min(candidate, max)
            : 0;
    return {
        target,
        tls: value.tls === true,
        // Verification is only ever turned off when the renderer asked for it explicitly.
        verifyTls: value.verifyTls !== false,
        protoFiles,
        service,
        method,
        message,
        metadata: cleanMetadata,
        deadlineMs: number(value.deadlineMs, 24 * 60 * 60 * 1000),
        maxResponseBytes: number(value.maxResponseBytes, 1024 * 1024 * 1024),
    };
};

const callKey = (senderId: number, callId: string) => `${senderId}:${callId}`;

const passthrough = (value: Uint8Array) => Buffer.from(value);
const raw = (value: Buffer) => value;

const metadataToRecord = (metadata: grpc.Metadata | undefined): Record<string, string> => {
    const record: Record<string, string> = {};
    if (!metadata) return record;
    for (const [key, values] of Object.entries(metadata.getMap())) {
        record[key] = Buffer.isBuffer(values) ? values.toString('base64') : String(values);
    }
    return record;
};

/** A short, non-sensitive description of a transport failure. */
const describe = (details: string): string => redactText(details || 'The call failed.');

interface ActiveCall {
    cancel: () => void;
}

export class GrpcCallManager {
    private readonly calls = new Map<string, ActiveCall>();

    get size(): number {
        return this.calls.size;
    }

    async call(
        senderId: number,
        callId: string,
        prepared: PreparedGrpcCall,
    ): Promise<GrpcResponse> {
        const key = callKey(senderId, callId);
        this.cancel(senderId, callId);

        const root = loadProtoRoot(prepared.protoFiles);
        const method = resolveMethod(root, prepared.service, prepared.method);
        if (method.method.requestStream) {
            throw new AppError(
                'INVALID_REQUEST',
                'Client and bidirectional streaming are not supported.',
            );
        }
        const request = encodeMessage(method.requestType, prepared.message);

        const credentials = prepared.tls
            ? grpc.credentials.createSsl(
                  null,
                  null,
                  null,
                  prepared.verifyTls
                      ? undefined
                      : { rejectUnauthorized: false, checkServerIdentity: () => undefined },
              )
            : grpc.credentials.createInsecure();
        const limit =
            prepared.maxResponseBytes > 0 ? prepared.maxResponseBytes : DEFAULT_MAX_RECEIVE;
        const client = new grpc.Client(prepared.target, credentials, {
            'grpc.max_receive_message_length': limit,
            'grpc.primary_user_agent': 'httpreq',
        });

        const metadata = new grpc.Metadata();
        for (const [name, value] of Object.entries(prepared.metadata)) metadata.add(name, value);
        const options: grpc.CallOptions =
            prepared.deadlineMs > 0 ? { deadline: Date.now() + prepared.deadlineMs } : {};

        const started = Date.now();
        return new Promise<GrpcResponse>((resolve) => {
            const chunks: Buffer[] = [];
            let headers: Record<string, string> = {};
            let settled = false;
            let size = 0;

            const finish = (
                status:
                    grpc.StatusObject | { code: number; details: string; metadata?: grpc.Metadata },
            ) => {
                if (settled) return;
                settled = true;
                this.calls.delete(key);
                client.close();
                const messages: string[] = [];
                let code = status.code;
                let details = status.details;
                try {
                    for (const chunk of chunks) {
                        messages.push(JSON.stringify(decodeMessage(method.responseType, chunk)));
                    }
                } catch {
                    code = grpc.status.INTERNAL;
                    details = 'The response could not be decoded with the given .proto definition.';
                }
                resolve({
                    status: { code, name: grpcStatusName(code), details: describe(details) },
                    headers,
                    trailers: metadataToRecord(status.metadata),
                    messages,
                    durationMs: Date.now() - started,
                    sizeBytes: size,
                });
            };

            const onData = (chunk: Buffer) => {
                size += chunk.length;
                if (chunks.length < MAX_STREAM_MESSAGES) chunks.push(chunk);
            };

            let active: grpc.ClientUnaryCall | grpc.ClientReadableStream<Buffer>;
            try {
                if (method.method.responseStream) {
                    const stream = client.makeServerStreamRequest(
                        method.path,
                        passthrough,
                        raw,
                        request,
                        metadata,
                        options,
                    );
                    stream.on('data', onData);
                    // Failures arrive as `status`; this keeps the emitter from throwing on 'error'.
                    stream.on('error', () => undefined);
                    active = stream;
                } else {
                    active = client.makeUnaryRequest(
                        method.path,
                        passthrough,
                        raw,
                        request,
                        metadata,
                        options,
                        (error, value) => {
                            if (!error && value) onData(value);
                        },
                    );
                }
            } catch (cause) {
                finish({ code: grpc.status.INTERNAL, details: (cause as Error).message });
                return;
            }
            active.on('metadata', (received: grpc.Metadata) => {
                headers = metadataToRecord(received);
            });
            active.on('status', finish);
            this.calls.set(key, { cancel: () => active.cancel() });
        });
    }

    cancel(senderId: number, callId: string): void {
        this.calls.get(callKey(senderId, callId))?.cancel();
    }

    disposeForSender(senderId: number): void {
        const prefix = `${senderId}:`;
        for (const [key, call] of [...this.calls]) {
            if (key.startsWith(prefix)) call.cancel();
        }
    }

    disposeAll(): void {
        for (const call of [...this.calls.values()]) call.cancel();
    }
}
