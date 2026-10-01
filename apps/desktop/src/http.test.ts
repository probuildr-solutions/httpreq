/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { PreparedRequest } from '@httpreq/shared';
import { executeHttp } from './http';

const request: PreparedRequest = {
    method: 'GET',
    url: 'https://example.com/users',
    headers: { Accept: 'application/json' },
    options: { followRedirects: true, verifyTls: true, sendCookies: false, maxResponseBytes: 0 },
};

describe('executeHttp', () => {
    it('returns a normalized response and forwards the abort signal and options', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(new Response('hello', { status: 201 }));
        const signal = new AbortController().signal;
        const result = await executeHttp(request, signal, fetchImpl);
        expect(result).toMatchObject({
            ok: true,
            value: { status: 201, body: 'hello', sizeBytes: 5 },
        });
        expect(fetchImpl).toHaveBeenCalledWith(
            'https://example.com/users',
            expect.objectContaining({
                method: 'GET',
                signal,
                redirect: 'follow',
                credentials: 'omit',
            }),
            request.options,
        );
    });

    it('truncates bodies at the response size limit', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(new Response('0123456789'));
        const result = await executeHttp(
            { ...request, options: { ...request.options, maxResponseBytes: 4 } },
            new AbortController().signal,
            fetchImpl,
        );
        expect(result).toMatchObject({
            ok: true,
            value: { body: '0123', truncated: true, sizeBytes: 4 },
        });
    });

    it('sends multipart bodies built from byte parts', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(new Response(''));
        await executeHttp(
            {
                ...request,
                method: 'POST',
                body: {
                    kind: 'multipart',
                    parts: [
                        { name: 'note', value: 'hi' },
                        {
                            name: 'file',
                            fileName: 'a.txt',
                            contentType: 'text/plain',
                            bytes: new Uint8Array([104, 105]),
                        },
                    ],
                },
            },
            new AbortController().signal,
            fetchImpl,
        );
        const init = fetchImpl.mock.calls[0]![1] as RequestInit;
        expect(init.body).toBeInstanceOf(FormData);
        expect((init.body as FormData).get('note')).toBe('hi');
    });

    it('rejects malformed payloads with a serializable INVALID_REQUEST error', async () => {
        const fetchImpl = vi.fn();
        const result = await executeHttp({ url: 42 }, new AbortController().signal, fetchImpl);
        expect(result).toEqual({
            ok: false,
            error: { code: 'INVALID_REQUEST', message: 'Invalid request payload.' },
        });
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('refuses non-HTTP protocols', async () => {
        const result = await executeHttp(
            { ...request, url: 'file:///etc/passwd' },
            new AbortController().signal,
            vi.fn(),
        );
        expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
    });

    it('maps native failures to NETWORK_ERROR without leaking the cause', async () => {
        const fetchImpl = vi.fn().mockRejectedValue(new Error('net::ERR_CONNECTION_REFUSED'));
        const result = await executeHttp(request, new AbortController().signal, fetchImpl);
        expect(result).toEqual({
            ok: false,
            error: { code: 'NETWORK_ERROR', message: 'The native request could not be completed.' },
        });
    });
});
