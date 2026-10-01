/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserHttpRuntime, ElectronHttpRuntime } from './index';
import {
    AppError,
    type HttpReqBridge,
    type HttpResponse,
    type PreparedRequest,
} from '@httpreq/shared';

const request: PreparedRequest = {
    method: 'POST',
    url: 'https://example.com/users?page=2',
    headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
    body: { kind: 'text', text: '{"name":"Ada"}' },
    options: { followRedirects: true, verifyTls: true, sendCookies: false, maxResponseBytes: 0 },
};

describe('BrowserHttpRuntime', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('normalizes a fetch response for the shared UI', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue(
                new Response('{"ok":true}', {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                }),
            ),
        );
        const response = await new BrowserHttpRuntime().execute(request);
        expect(response).toMatchObject({ status: 200, body: '{"ok":true}', sizeBytes: 11 });
        expect(fetch).toHaveBeenCalledWith(
            request.url,
            expect.objectContaining({ method: 'POST', body: '{"name":"Ada"}', redirect: 'follow' }),
        );
    });

    it('maps transport failures to NETWORK_ERROR', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
        await expect(new BrowserHttpRuntime().execute(request)).rejects.toMatchObject({
            code: 'NETWORK_ERROR',
        });
    });
});

describe('ElectronHttpRuntime', () => {
    const response: HttpResponse = {
        status: 200,
        statusText: 'OK',
        headers: {},
        body: '',
        contentType: 'text/plain',
        durationMs: 1,
        sizeBytes: 0,
    };
    const installBridge = (bridge: HttpReqBridge) => {
        window.httpreq = bridge;
    };

    afterEach(() => {
        delete window.httpreq;
    });

    it('returns the response from a successful bridge result', async () => {
        installBridge({
            executeHttp: vi.fn().mockResolvedValue({ ok: true, value: response }),
            cancelHttp: vi.fn(),
        });
        await expect(new ElectronHttpRuntime().execute(request)).resolves.toEqual(response);
    });

    it('rebuilds AppError with its code from a failed bridge result', async () => {
        installBridge({
            executeHttp: vi.fn().mockResolvedValue({
                ok: false,
                error: {
                    code: 'INVALID_REQUEST',
                    message: 'Only HTTP and HTTPS URLs are permitted.',
                },
            }),
            cancelHttp: vi.fn(),
        });
        const error = await new ElectronHttpRuntime().execute(request).catch((cause) => cause);
        expect(error).toBeInstanceOf(AppError);
        expect(error).toMatchObject({
            code: 'INVALID_REQUEST',
            message: 'Only HTTP and HTTPS URLs are permitted.',
        });
    });

    it('cancels the native request and rejects with AbortError when aborted', async () => {
        const cancelHttp = vi.fn();
        const executeHttp = vi.fn<HttpReqBridge['executeHttp']>(() => new Promise(() => undefined));
        installBridge({ executeHttp, cancelHttp });
        const controller = new AbortController();
        const pending = new ElectronHttpRuntime().execute(request, controller.signal);
        controller.abort();
        await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        expect(cancelHttp).toHaveBeenCalledWith(executeHttp.mock.calls[0]![1]);
    });

    it('does not call the bridge when the signal is already aborted', async () => {
        const executeHttp = vi.fn();
        installBridge({ executeHttp, cancelHttp: vi.fn() });
        const controller = new AbortController();
        controller.abort();
        await expect(
            new ElectronHttpRuntime().execute(request, controller.signal),
        ).rejects.toMatchObject({ name: 'AbortError' });
        expect(executeHttp).not.toHaveBeenCalled();
    });
});
