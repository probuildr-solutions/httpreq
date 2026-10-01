/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import type { HttpReqBridge } from '@httpreq/shared';

const desktopBridge = () => (globalThis as { httpreq?: HttpReqBridge }).httpreq?.desktop;

/** The legacy path for browsers without the async Clipboard API (or in an insecure context). */
const copyWithSelection = (text: string) => {
    const field = document.createElement('textarea');
    field.value = text;
    field.setAttribute('readonly', '');
    field.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0';
    document.body.append(field);
    field.select();
    try {
        if (!document.execCommand('copy')) throw new Error('The browser refused to copy.');
    } finally {
        field.remove();
    }
};

/**
 * Copies text to the clipboard. The desktop app writes through Electron's clipboard (the
 * renderer's Clipboard API is permission-denied there, and needs a user gesture that has often
 * expired by the time the text is built); the browser uses the Clipboard API, falling back to a
 * selection copy. Rejects with a readable message when nothing worked.
 */
export const copyText = async (text: string): Promise<void> => {
    const desktop = desktopBridge();
    if (desktop) return desktop.writeClipboardText(text);
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        try {
            return await navigator.clipboard.writeText(text);
        } catch {
            // Falls through to the selection copy.
        }
    }
    copyWithSelection(text);
};

/** Reads clipboard text, for pasting into the terminal. */
export const readClipboardText = async (): Promise<string> => {
    const desktop = desktopBridge();
    return desktop ? desktop.readClipboardText() : navigator.clipboard.readText();
};
