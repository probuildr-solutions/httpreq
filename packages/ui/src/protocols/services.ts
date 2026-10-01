/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { createContext, useContext } from 'react';
import { AppError, type HttpRuntime } from '@httpreq/shared';

/** What the protocol panels need from the host application, kept out of the components. */
export interface ProtocolServices {
    /** Downloads a text document (a WSDL) through the platform's HTTP runtime. */
    fetchText: (url: string) => Promise<string>;
}

const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;

/**
 * Fetches a definition document through the same runtime requests use, so it works in the browser
 * (subject to CORS) and the desktop app (no CORS) alike. Only http(s) is accepted, no credentials
 * are sent, and the size is bounded.
 */
export const createProtocolServices = (runtime: HttpRuntime): ProtocolServices => ({
    fetchText: async (url) => {
        let parsed: URL;
        try {
            parsed = new URL(url.trim());
        } catch {
            throw new AppError('INVALID_REQUEST', 'Enter a full http:// or https:// URL.');
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            throw new AppError('INVALID_REQUEST', 'Only http:// and https:// URLs can be fetched.');
        }
        const response = await runtime.execute({
            method: 'GET',
            url: parsed.toString(),
            headers: { Accept: 'text/xml, application/xml, text/plain, */*' },
            options: {
                followRedirects: true,
                verifyTls: true,
                sendCookies: false,
                maxResponseBytes: MAX_DOCUMENT_BYTES,
            },
        });
        if (response.status < 200 || response.status >= 300) {
            throw new AppError(
                'NETWORK_ERROR',
                `The server answered ${response.status} ${response.statusText}.`,
            );
        }
        if (response.truncated) {
            throw new AppError('INVALID_REQUEST', 'The document is larger than 5 MB.');
        }
        return response.body;
    },
});

export const ProtocolServicesContext = createContext<ProtocolServices | null>(null);

export const useProtocolServices = (): ProtocolServices => {
    const services = useContext(ProtocolServicesContext);
    if (!services)
        throw new Error('useProtocolServices must be used inside the HttpReq application.');
    return services;
};
