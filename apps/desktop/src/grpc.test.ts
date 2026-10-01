/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

// @vitest-environment node

import * as grpc from '@grpc/grpc-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadProtoRoot, resolveMethod } from '@httpreq/api-client';
import type { PreparedGrpcCall } from '@httpreq/shared';
import { GrpcCallManager, parsePreparedGrpcCall } from './grpc';

const PROTO = `syntax = "proto3"; package acme;
service Svc {
    rpc Get (Req) returns (Res);
    rpc Watch (Req) returns (stream Res);
    rpc Fail (Req) returns (Res);
    rpc Slow (Req) returns (Res);
}
message Req { string id = 1; }
message Res { string name = 1; int64 big = 2; }`;

const files = [{ name: 'svc.proto', content: PROTO }];
const root = loadProtoRoot(files);
const method = (name: string) => resolveMethod(root, 'acme.Svc', name);

const definition = (
    name: string,
    serverStream = false,
): grpc.MethodDefinition<unknown, unknown> => {
    const resolved = method(name);
    return {
        path: resolved.path,
        requestStream: false,
        responseStream: serverStream,
        requestSerialize: (value) =>
            Buffer.from(
                resolved.requestType
                    .encode(resolved.requestType.fromObject(value as object))
                    .finish(),
            ),
        requestDeserialize: (bytes) =>
            resolved.requestType.toObject(resolved.requestType.decode(bytes)),
        responseSerialize: (value) =>
            Buffer.from(
                resolved.responseType
                    .encode(resolved.responseType.fromObject(value as object))
                    .finish(),
            ),
        responseDeserialize: (bytes) =>
            resolved.responseType.toObject(resolved.responseType.decode(bytes)),
    };
};

let server: grpc.Server;
let port = 0;
const seen: { metadata: Record<string, string>; id: string }[] = [];

beforeAll(async () => {
    server = new grpc.Server();
    server.addService(
        {
            Get: definition('Get'),
            Watch: definition('Watch', true),
            Fail: definition('Fail'),
            Slow: definition('Slow'),
        } as grpc.ServiceDefinition,
        {
            Get: (
                call: grpc.ServerUnaryCall<{ id: string }, unknown>,
                callback: grpc.sendUnaryData<unknown>,
            ) => {
                seen.push({
                    metadata: Object.fromEntries(
                        Object.entries(call.metadata.getMap()).map(([k, v]) => [k, String(v)]),
                    ),
                    id: call.request.id,
                });
                call.sendMetadata(new grpc.Metadata());
                callback(null, {
                    name: `hello ${call.request.id}`,
                    big: 9007199254740993n.toString(),
                });
            },
            Watch: (call: grpc.ServerWritableStream<{ id: string }, unknown>) => {
                call.write({ name: 'one' });
                call.write({ name: 'two' });
                call.end();
            },
            Fail: (_call: unknown, callback: grpc.sendUnaryData<unknown>) =>
                callback({ code: grpc.status.NOT_FOUND, details: 'no such order' }),
            Slow: () => undefined,
        } as unknown as grpc.UntypedServiceImplementation,
    );
    port = await new Promise<number>((resolve, reject) =>
        server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (error, bound) =>
            error ? reject(error) : resolve(bound),
        ),
    );
});

afterAll(() => server.forceShutdown());

const call = (methodName: string, patch: Partial<PreparedGrpcCall> = {}): PreparedGrpcCall => ({
    target: `127.0.0.1:${port}`,
    tls: false,
    verifyTls: true,
    protoFiles: files,
    service: 'acme.Svc',
    method: methodName,
    message: '{"id":"7"}',
    metadata: {},
    deadlineMs: 5000,
    maxResponseBytes: 0,
    ...patch,
});

describe('gRPC transport', () => {
    it('makes a unary call, sending metadata and decoding the reply', async () => {
        const manager = new GrpcCallManager();
        const response = await manager.call(
            1,
            'a',
            call('Get', { metadata: { 'x-trace': 'abc' } }),
        );
        expect(response.status).toMatchObject({ code: 0, name: 'OK' });
        expect(JSON.parse(response.messages[0]!)).toMatchObject({
            name: 'hello 7',
            // 64-bit integers survive as strings.
            big: '9007199254740993',
        });
        expect(seen.at(-1)).toMatchObject({
            id: '7',
            metadata: expect.objectContaining({ 'x-trace': 'abc' }),
        });
        expect(manager.size).toBe(0);
    });

    it('collects the messages of a server-streaming call', async () => {
        const response = await new GrpcCallManager().call(1, 'b', call('Watch'));
        expect(response.status.code).toBe(0);
        expect(response.messages.map((m) => JSON.parse(m).name)).toEqual(['one', 'two']);
    });

    it('reports a server error as a status, not an exception', async () => {
        const response = await new GrpcCallManager().call(1, 'c', call('Fail'));
        expect(response.status).toMatchObject({
            code: 5,
            name: 'NOT_FOUND',
            details: 'no such order',
        });
        expect(response.messages).toEqual([]);
    });

    it('enforces the deadline', async () => {
        const response = await new GrpcCallManager().call(
            1,
            'd',
            call('Slow', { deadlineMs: 150 }),
        );
        expect(response.status.name).toBe('DEADLINE_EXCEEDED');
    });

    it('cancels a call, but only from the window that made it', async () => {
        const manager = new GrpcCallManager();
        const pending = manager.call(1, 'e', call('Slow', { deadlineMs: 0 }));
        await new Promise((resolve) => setTimeout(resolve, 100));
        manager.cancel(2, 'e'); // another window: ignored
        expect(manager.size).toBe(1);
        manager.cancel(1, 'e');
        expect((await pending).status.name).toBe('CANCELLED');
    });

    it('reports an unreachable server as UNAVAILABLE', async () => {
        const response = await new GrpcCallManager().call(
            1,
            'f',
            call('Get', { target: '127.0.0.1:1', deadlineMs: 2000 }),
        );
        expect(response.status.name).toBe('UNAVAILABLE');
    });

    it('rejects a message that does not fit the method', async () => {
        await expect(
            new GrpcCallManager().call(1, 'g', call('Get', { message: '{"nope":1}' })),
        ).rejects.toThrow(/not a field/);
    });
});

describe('gRPC payload validation', () => {
    const valid = () => ({ ...call('Get') });

    it('accepts a well-formed call and drops unknown fields', () => {
        const parsed = parsePreparedGrpcCall({
            ...valid(),
            channelOptions: { 'grpc.ssl_target_name_override': 'x' },
        });
        expect(parsed).not.toBeNull();
        expect(parsed).not.toHaveProperty('channelOptions');
    });

    it('rejects bad targets, reserved metadata and oversized definitions', () => {
        expect(parsePreparedGrpcCall({ ...valid(), target: 'unix:/var/run/x.sock' })).toBeNull();
        expect(parsePreparedGrpcCall({ ...valid(), target: 'host with space:1' })).toBeNull();
        expect(
            parsePreparedGrpcCall({ ...valid(), metadata: { 'grpc-timeout': '1S' } }),
        ).toBeNull();
        expect(parsePreparedGrpcCall({ ...valid(), metadata: { 'x-a': 'a\r\nb' } })).toBeNull();
        expect(parsePreparedGrpcCall({ ...valid(), metadata: { 'X-Upper': 'a' } })).toBeNull();
        expect(
            parsePreparedGrpcCall({
                ...valid(),
                protoFiles: [{ name: 'a', content: 'x'.repeat(5 * 1024 * 1024) }],
            }),
        ).toBeNull();
        expect(parsePreparedGrpcCall(null)).toBeNull();
    });

    it('keeps TLS verification on unless explicitly turned off', () => {
        expect(
            parsePreparedGrpcCall({ ...valid(), tls: true, verifyTls: undefined })?.verifyTls,
        ).toBe(true);
        expect(parsePreparedGrpcCall({ ...valid(), tls: true, verifyTls: false })?.verifyTls).toBe(
            false,
        );
    });
});
