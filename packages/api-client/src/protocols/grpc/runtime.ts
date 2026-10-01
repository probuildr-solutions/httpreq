/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import {
    AppError,
    createId,
    type GrpcResponse,
    type GrpcRuntime,
    type PreparedGrpcCall,
} from '@httpreq/shared';

/** The browser cannot speak native gRPC (HTTP/2 trailers, raw framing), so it says so clearly. */
export class UnavailableGrpcRuntime implements GrpcRuntime {
    readonly kind = 'browser' as const;
    readonly available = false;

    call(): Promise<GrpcResponse> {
        return Promise.reject(
            new AppError('INVALID_REQUEST', 'gRPC calls need the HttpReq desktop app.'),
        );
    }
}

/** Desktop runtime: the channel lives in the Electron main process; the renderer holds an id. */
export class ElectronGrpcRuntime implements GrpcRuntime {
    readonly kind = 'electron' as const;
    readonly available = true;

    async call(prepared: PreparedGrpcCall, signal?: AbortSignal): Promise<GrpcResponse> {
        const bridge = window.httpreq?.grpc;
        if (!bridge) throw new AppError('NETWORK_ERROR', 'The desktop gRPC bridge is unavailable.');
        if (signal?.aborted) throw new DOMException('The call was cancelled.', 'AbortError');
        const callId = createId();
        const onAbort = () => bridge.cancel(callId);
        signal?.addEventListener('abort', onAbort, { once: true });
        try {
            const result = await bridge.call(callId, prepared);
            if (signal?.aborted) throw new DOMException('The call was cancelled.', 'AbortError');
            if (!result.ok) throw new AppError(result.error.code, result.error.message);
            return result.value;
        } finally {
            signal?.removeEventListener('abort', onAbort);
        }
    }
}
