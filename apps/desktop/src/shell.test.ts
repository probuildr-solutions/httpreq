/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
    isAllowedExternalUrl,
    isAuthorizationUrl,
    isClipboardText,
    MAX_CLIPBOARD_CHARS,
    isTrustedRendererUrl,
    nextZoomLevel,
    MAX_ZOOM_LEVEL,
} from './shell';

describe('desktop shell IPC validation', () => {
    it('opens only plain web URLs as OAuth authorization pages', () => {
        expect(isAuthorizationUrl('https://auth.example.com/authorize?client_id=x')).toBe(true);
        expect(isAuthorizationUrl('http://localhost:8080/authorize')).toBe(true);
        expect(isAuthorizationUrl('file:///etc/passwd')).toBe(false);
        expect(isAuthorizationUrl('javascript:alert(1)')).toBe(false);
        expect(isAuthorizationUrl('https://user:pass@example.com')).toBe(false);
        expect(isAuthorizationUrl(null)).toBe(false);
    });

    it('only opens the project documentation externally', () => {
        expect(isAllowedExternalUrl('https://github.com/yamatrireddy/httpreq')).toBe(true);
        expect(
            isAllowedExternalUrl('https://github.com/yamatrireddy/httpreq/blob/main/README.md'),
        ).toBe(true);
        expect(isAllowedExternalUrl('https://github.com/yamatrireddy/httpreq-evil')).toBe(false);
        expect(isAllowedExternalUrl('http://github.com/yamatrireddy/httpreq')).toBe(false);
        expect(isAllowedExternalUrl('file:///etc/passwd')).toBe(false);
        expect(isAllowedExternalUrl(42)).toBe(false);
    });

    it('trusts only the app renderer origin', () => {
        expect(isTrustedRendererUrl('file:///app/index.html', undefined)).toBe(true);
        expect(isTrustedRendererUrl('https://evil.example', undefined)).toBe(false);
        expect(isTrustedRendererUrl('http://localhost:5173/#/', 'http://localhost:5173')).toBe(
            true,
        );
        expect(isTrustedRendererUrl('http://localhost:9999/', 'http://localhost:5173')).toBe(false);
    });

    it('clamps zoom steps', () => {
        expect(nextZoomLevel(0, 'in')).toBe(0.5);
        expect(nextZoomLevel(MAX_ZOOM_LEVEL, 'in')).toBe(MAX_ZOOM_LEVEL);
        expect(nextZoomLevel(2, 'reset')).toBe(0);
    });

    it('accepts only strings of a sane size for the clipboard', () => {
        expect(isClipboardText('curl https://x.test')).toBe(true);
        expect(isClipboardText('')).toBe(true);
        expect(isClipboardText({ toString: () => 'x' })).toBe(false);
        expect(isClipboardText(null)).toBe(false);
        expect(isClipboardText('x'.repeat(MAX_CLIPBOARD_CHARS + 1))).toBe(false);
    });
});
