/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import type {
    ExecutionHooks,
    HttpReqBridge,
    HttpResponse,
    HttpRuntime,
    HttpStreamMessage,
    PreparedRequest,
    SseEvent,
    StreamHead,
} from '@httpreq/shared';
import { AppError, createId } from '@httpreq/shared';
import { buildStreamResponse, MAX_STREAM_EVENTS, readResponse, toFetchInit } from './transport';

export * from './auth/basic';
export * from './auth/digest';
export * from './auth/jwt';
export * from './auth/oauth2';
export * from './auth/registry';
export * from './auth/types';
export * from './curl';
export * from './generatedHeaders';
export * from './pipeline';
export * from './protocols';
export * from './responses';
export * from './transport';
export * from './variables';
export * from './websocket';

export class BrowserHttpRuntime implements HttpRuntime {
    readonly kind = 'browser' as const;

    async execute(
        request: PreparedRequest,
        signal?: AbortSignal,
        hooks?: ExecutionHooks,
    ): Promise<HttpResponse> {
        const startedAt = performance.now();
        try {
            const response = await fetch(request.url, toFetchInit(request, signal));
            return await readResponse(response, startedAt, request.options.maxResponseBytes, hooks);
        } catch (cause) {
            if (
                cause instanceof AppError ||
                (cause instanceof DOMException &&
                    (cause.name === 'AbortError' || cause.name === 'TimeoutError'))
            )
                throw cause;
            throw new AppError(
                'NETWORK_ERROR',
                'The request could not be completed. Check the URL, network, and CORS policy.',
                { cause },
            );
        }
    }
}

declare global {
    interface Window {
        httpreq?: HttpReqBridge;
    }
}

const abortError = () => new DOMException('The request was cancelled.', 'AbortError');

export class ElectronHttpRuntime implements HttpRuntime {
    readonly kind = 'electron' as const;

    execute(
        request: PreparedRequest,
        signal?: AbortSignal,
        hooks?: ExecutionHooks,
    ): Promise<HttpResponse> {
        const bridge = window.httpreq;
        if (!bridge) {
            return Promise.reject(new AppError('NETWORK_ERROR', 'Electron bridge is unavailable.'));
        }
        if (signal?.aborted) return Promise.reject(abortError());

        const executionId = createId();
        const startedAt = performance.now();
        return new Promise<HttpResponse>((resolve, reject) => {
            // What the main process has streamed so far, kept so that stopping a stream can keep it.
            let head: StreamHead | undefined;
            let events: SseEvent[] = [];
            let dropped = 0;
            const unsubscribe = hooks
                ? bridge.onHttpStream?.((id: string, message: HttpStreamMessage) => {
                      if (id !== executionId) return;
                      if (message.type === 'start') {
                          head = message.head;
                          hooks.onStreamStart?.(message.head);
                          return;
                      }
                      events.push(...message.events);
                      if (events.length > MAX_STREAM_EVENTS) {
                          dropped += events.length - MAX_STREAM_EVENTS;
                          events = events.slice(events.length - MAX_STREAM_EVENTS);
                      }
                      hooks.onStreamEvents?.(message.events);
                  })
                : undefined;
            // Reject immediately on abort; the main process cancels its native request in parallel.
            // An open stream that is stopped resolves with the events received so far instead.
            const onAbort = () => {
                bridge.cancelHttp(executionId);
                if (head) {
                    resolve(
                        buildStreamResponse(
                            head,
                            events,
                            Math.round(performance.now() - startedAt),
                            'stopped',
                            dropped,
                        ),
                    );
                } else reject(abortError());
            };
            signal?.addEventListener('abort', onAbort, { once: true });
            bridge
                .executeHttp(request, executionId)
                .then(
                    (result) =>
                        result.ok
                            ? resolve(result.value)
                            : reject(new AppError(result.error.code, result.error.message)),
                    (cause: unknown) =>
                        reject(
                            new AppError(
                                'NETWORK_ERROR',
                                'The desktop bridge could not execute the request.',
                                {
                                    cause,
                                },
                            ),
                        ),
                )
                .finally(() => {
                    signal?.removeEventListener('abort', onAbort);
                    unsubscribe?.();
                });
        });
    }
}
