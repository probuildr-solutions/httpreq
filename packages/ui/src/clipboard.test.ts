/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyText, readClipboardText } from './clipboard';

afterEach(() => {
    vi.unstubAllGlobals();
    delete (globalThis as { httpreq?: unknown }).httpreq;
});

describe('copyText', () => {
    it('uses the desktop clipboard instead of the permission-gated browser one', async () => {
        const writeClipboardText = vi.fn(async () => undefined);
        const browser = vi.fn(async () => {
            throw new DOMException('Write permission denied.', 'NotAllowedError');
        });
        vi.stubGlobal('navigator', { clipboard: { writeText: browser } });
        (globalThis as { httpreq?: unknown }).httpreq = { desktop: { writeClipboardText } };

        await copyText('curl https://x.test');
        expect(writeClipboardText).toHaveBeenCalledWith('curl https://x.test');
        expect(browser).not.toHaveBeenCalled();
    });

    it('surfaces a desktop failure so the caller can report it', async () => {
        (globalThis as { httpreq?: unknown }).httpreq = {
            desktop: {
                writeClipboardText: async () => {
                    throw new Error('The text could not be written to the clipboard.');
                },
            },
        };
        await expect(copyText('x')).rejects.toThrow('could not be written');
    });

    it('uses the Clipboard API in the browser, and falls back to a selection copy', async () => {
        const writeText = vi.fn(async () => undefined);
        vi.stubGlobal('navigator', { clipboard: { writeText } });
        await copyText('hello');
        expect(writeText).toHaveBeenCalledWith('hello');

        vi.stubGlobal('navigator', {
            clipboard: {
                writeText: async () => {
                    throw new Error('denied');
                },
            },
        });
        document.execCommand = vi.fn(() => true);
        await copyText('fallback');
        expect(document.execCommand).toHaveBeenCalledWith('copy');
        expect(document.querySelector('textarea')).toBeNull();
    });
});

describe('readClipboardText', () => {
    it('reads through the desktop bridge when there is one', async () => {
        (globalThis as { httpreq?: unknown }).httpreq = {
            desktop: { readClipboardText: async () => 'pasted' },
        };
        expect(await readClipboardText()).toBe('pasted');
    });
});
