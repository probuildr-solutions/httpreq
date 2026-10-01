/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import type {
    ExecutionHooks,
    HttpResponse,
    PreparedBody,
    PreparedRequest,
    SseEvent,
} from '@httpreq/shared';
import {
    createSseParser,
    decodeBody,
    isBinaryBody,
    isEventStream,
    serializeSseEvents,
} from './responses';

const toFetchBody = (body: PreparedBody | undefined): BodyInit | undefined => {
    if (!body) return undefined;
    if (body.kind === 'text') return body.text;
    if (body.kind === 'bytes') return body.bytes as BufferSource;
    const form = new FormData();
    for (const part of body.parts) {
        if ('bytes' in part) {
            form.append(
                part.name,
                new Blob([part.bytes as BlobPart], {
                    type: part.contentType || 'application/octet-stream',
                }),
                part.fileName,
            );
        } else {
            form.append(part.name, part.value);
        }
    }
    return form;
};

/** Converts a prepared request into `fetch` options (browser `fetch` and Electron `net.fetch`). */
export const toFetchInit = (request: PreparedRequest, signal?: AbortSignal): RequestInit => ({
    method: request.method,
    headers: request.headers,
    body: toFetchBody(request.body),
    redirect: request.options.followRedirects ? 'follow' : 'manual',
    credentials: request.options.sendCookies ? 'include' : 'omit',
    signal,
});

/** Events kept for display; older ones are dropped so an endless stream cannot exhaust memory. */
export const MAX_STREAM_EVENTS = 10_000;

const concat = (chunks: Uint8Array[], size: number) => {
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
    }
    return bytes;
};

const isAbortError = (error: unknown) =>
    (error as { name?: unknown } | null)?.name === 'AbortError';

/**
 * Reads a Server-Sent Events body as it arrives. Each batch of events is reported through the
 * hooks immediately, and the response resolves when the server closes the stream, the size limit
 * is reached, or the request is aborted (which is how a user stops a stream: the events received
 * so far are kept rather than thrown away).
 */
const readEventStream = async (
    response: Response,
    startedAt: number,
    maxBytes: number,
    hooks: ExecutionHooks,
): Promise<HttpResponse> => {
    const headers = Object.fromEntries(response.headers.entries());
    const contentType = response.headers.get('content-type') ?? 'text/event-stream';
    hooks.onStreamStart?.({
        status: response.status,
        statusText: response.statusText,
        headers,
        contentType,
    });

    const parser = createSseParser();
    const decoder = new TextDecoder();
    const chunks: Uint8Array[] = [];
    let events: SseEvent[] = [];
    let dropped = 0;
    let size = 0;
    let truncated = false;
    let ended: 'closed' | 'stopped' = 'closed';
    const now = () => Math.round(performance.now() - startedAt);
    const keep = (batch: SseEvent[]) => {
        if (batch.length === 0) return;
        events.push(...batch);
        if (events.length > MAX_STREAM_EVENTS) {
            dropped += events.length - MAX_STREAM_EVENTS;
            events = events.slice(events.length - MAX_STREAM_EVENTS);
        }
        hooks.onStreamEvents?.(batch);
    };

    const reader = response.body?.getReader();
    try {
        while (reader) {
            const { done, value } = await reader.read();
            if (done) break;
            let chunk = value;
            if (maxBytes > 0 && size + chunk.length > maxBytes) {
                chunk = chunk.subarray(0, maxBytes - size);
                truncated = true;
            }
            chunks.push(chunk);
            size += chunk.length;
            keep(parser.push(decoder.decode(chunk, { stream: true }), now()));
            if (truncated) {
                await reader.cancel().catch(() => undefined);
                break;
            }
        }
    } catch (error) {
        // Stopping is an abort; a dropped connection also ends the stream with what arrived.
        if (isAbortError(error)) ended = 'stopped';
    }
    keep(parser.flush(now()));

    const bytes = concat(chunks, size);
    return {
        status: response.status,
        statusText: response.statusText,
        headers,
        body: decodeBody(bytes, contentType),
        bytes,
        contentType,
        durationMs: now(),
        sizeBytes: size,
        stream: { events, ended, dropped },
        ...(truncated ? { truncated } : {}),
    };
};

/**
 * Builds the response of a stream that was stopped from the events already received, for
 * runtimes where the stop is decided away from the connection (the desktop renderer).
 */
export const buildStreamResponse = (
    head: {
        status: number;
        statusText: string;
        headers: Record<string, string>;
        contentType: string;
    },
    events: SseEvent[],
    durationMs: number,
    ended: 'closed' | 'stopped',
    dropped = 0,
): HttpResponse => {
    const body = serializeSseEvents(events);
    const bytes = new TextEncoder().encode(body);
    return {
        ...head,
        body,
        bytes,
        durationMs,
        sizeBytes: bytes.length,
        stream: { events, ended, dropped },
    };
};

/**
 * Reads a response, stopping at `maxBytes` (0 = unlimited) so a huge download can never exhaust
 * memory; the result is then marked as truncated. A `text/event-stream` body is read
 * progressively when `hooks` are given (see `readEventStream`). Binary bodies are kept as bytes
 * and never decoded to text.
 */
export const readResponse = async (
    response: Response,
    startedAt: number,
    maxBytes = 0,
    hooks?: ExecutionHooks,
): Promise<HttpResponse> => {
    if (hooks && isEventStream(response.headers.get('content-type') ?? '')) {
        return readEventStream(response, startedAt, maxBytes, hooks);
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    let truncated = false;
    const reader = response.body?.getReader();
    if (reader) {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (maxBytes > 0 && size + value.length > maxBytes) {
                chunks.push(value.subarray(0, maxBytes - size));
                size = maxBytes;
                truncated = true;
                await reader.cancel().catch(() => undefined);
                break;
            }
            chunks.push(value);
            size += value.length;
        }
    }
    const bytes = concat(chunks, size);
    // A redirect that was not followed ("manual") is opaque in browsers: no status or headers.
    const opaqueRedirect = response.type === 'opaqueredirect';
    const declaredType = response.headers.get('content-type') ?? '';
    const contentType = declaredType || 'text/plain';
    const binary = isBinaryBody(bytes, declaredType);
    return {
        status: response.status,
        statusText: opaqueRedirect ? 'Redirect not followed' : response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
        body: binary ? '' : decodeBody(bytes, contentType),
        bytes,
        contentType,
        durationMs: Math.round(performance.now() - startedAt),
        sizeBytes: size,
        ...(binary ? { binary } : {}),
        ...(truncated ? { truncated } : {}),
    };
};
