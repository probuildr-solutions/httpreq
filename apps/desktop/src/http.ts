/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { performance } from 'node:perf_hooks';
import { readResponse, toFetchInit } from '@httpreq/api-client';
import {
    AppError,
    isHttpMethod,
    serializeError,
    type ExecutionHooks,
    type HttpResponse,
    type IpcResult,
    type PreparedBody,
    type PreparedOptions,
    type PreparedRequest,
} from '@httpreq/shared';

export type FetchImplementation = (
    url: string,
    init: RequestInit,
    options: PreparedOptions,
) => Promise<Response>;

const isObject = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object';

const isStringRecord = (value: unknown): value is Record<string, string> =>
    isObject(value) && Object.values(value).every((item) => typeof item === 'string');

const isBody = (value: unknown): value is PreparedBody => {
    if (!isObject(value)) return false;
    if (value.kind === 'text') return typeof value.text === 'string';
    if (value.kind === 'bytes') return value.bytes instanceof Uint8Array;
    if (value.kind !== 'multipart' || !Array.isArray(value.parts)) return false;
    return value.parts.every(
        (part: unknown) =>
            isObject(part) &&
            typeof part.name === 'string' &&
            (typeof part.value === 'string' ||
                (part.bytes instanceof Uint8Array &&
                    typeof part.fileName === 'string' &&
                    typeof part.contentType === 'string')),
    );
};

const isOptions = (value: unknown): value is PreparedOptions =>
    isObject(value) &&
    typeof value.followRedirects === 'boolean' &&
    typeof value.verifyTls === 'boolean' &&
    typeof value.sendCookies === 'boolean' &&
    typeof value.maxResponseBytes === 'number' &&
    value.maxResponseBytes >= 0;

/** Structural validation of the untrusted renderer payload. */
export const isPreparedRequest = (value: unknown): value is PreparedRequest =>
    isObject(value) &&
    isHttpMethod(value.method) &&
    typeof value.url === 'string' &&
    isStringRecord(value.headers) &&
    (value.body === undefined || isBody(value.body)) &&
    isOptions(value.options);

/**
 * Validates an untrusted renderer payload and executes it natively. Never throws: every outcome
 * is returned as an IpcResult because Electron IPC strips custom error classes and their codes.
 * Variables and authorization were already resolved by the shared pipeline in the renderer.
 */
export const executeHttp = async (
    request: unknown,
    signal: AbortSignal,
    fetchImpl: FetchImplementation,
    hooks?: ExecutionHooks,
): Promise<IpcResult<HttpResponse>> => {
    try {
        if (!isPreparedRequest(request))
            throw new AppError('INVALID_REQUEST', 'Invalid request payload.');
        let url: URL;
        try {
            url = new URL(request.url);
        } catch (cause) {
            throw new AppError('INVALID_REQUEST', 'Enter a valid absolute URL.', { cause });
        }
        if (!['http:', 'https:'].includes(url.protocol)) {
            throw new AppError('INVALID_REQUEST', 'Only HTTP and HTTPS URLs are permitted.');
        }
        const startedAt = performance.now();
        const response = await fetchImpl(
            url.toString(),
            toFetchInit(request, signal),
            request.options,
        );
        return {
            ok: true,
            value: await readResponse(response, startedAt, request.options.maxResponseBytes, hooks),
        };
    } catch (error) {
        return {
            ok: false,
            error: serializeError(error, {
                code: 'NETWORK_ERROR',
                message: 'The native request could not be completed.',
            }),
        };
    }
};
