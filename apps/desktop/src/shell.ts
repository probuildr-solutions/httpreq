/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { DOCUMENTATION_URL } from '@httpreq/shared';

export const MIN_ZOOM_LEVEL = -3;
export const MAX_ZOOM_LEVEL = 5;
export const ZOOM_STEP = 0.5;

/** Only the project's own documentation may be opened in the system browser. */
export const isAllowedExternalUrl = (value: unknown): value is string => {
    if (typeof value !== 'string') return false;
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        return false;
    }
    const allowed = new URL(DOCUMENTATION_URL);
    return (
        url.protocol === 'https:' &&
        url.host === allowed.host &&
        (url.pathname === allowed.pathname || url.pathname.startsWith(`${allowed.pathname}/`))
    );
};

/**
 * OAuth 2.0 authorization pages the user asked to open. Only plain web URLs without embedded
 * credentials are accepted, so the renderer cannot launch other protocol handlers.
 */
export const isAuthorizationUrl = (value: unknown): value is string => {
    if (typeof value !== 'string' || value.length > 8192) return false;
    try {
        const url = new URL(value);
        return (
            (url.protocol === 'https:' || url.protocol === 'http:') &&
            !url.username &&
            !url.password
        );
    } catch {
        return false;
    }
};

export const nextZoomLevel = (current: number, direction: 'in' | 'out' | 'reset'): number => {
    if (direction === 'reset') return 0;
    const next = current + (direction === 'in' ? ZOOM_STEP : -ZOOM_STEP);
    return Math.min(MAX_ZOOM_LEVEL, Math.max(MIN_ZOOM_LEVEL, next));
};

/**
 * Accepts IPC only from the app's own top-level document: the Vite dev server in development or
 * the packaged `file://` renderer in production. Subframes and navigated-away pages are rejected.
 */
export const isTrustedRendererUrl = (url: string | undefined, devServer: string | undefined) => {
    if (!url) return false;
    if (devServer) {
        try {
            return new URL(url).origin === new URL(devServer).origin;
        } catch {
            return false;
        }
    }
    return url.startsWith('file://');
};

/** The most text one clipboard write may carry; larger payloads are refused, not truncated. */
export const MAX_CLIPBOARD_CHARS = 10_000_000;

export const isClipboardText = (value: unknown): value is string =>
    typeof value === 'string' && value.length <= MAX_CLIPBOARD_CHARS;
