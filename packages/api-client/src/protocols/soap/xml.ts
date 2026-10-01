/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { AppError } from '@httpreq/shared';

/** Largest XML document the app will parse on the user's behalf (a WSDL, a request, a response). */
export const MAX_XML_BYTES = 5 * 1024 * 1024;

/** A DOCTYPE is where entity expansion and external-entity attacks live; SOAP never needs one. */
const DOCTYPE = /<!DOCTYPE|<!ENTITY/i;

export type XmlParseResult = { ok: true; document: Document } | { ok: false; message: string };

/**
 * Parses untrusted XML. Documents with a DTD are refused outright (no entity expansion, no
 * external entities), as are oversized ones, and a parser error is reported as a message rather
 * than thrown.
 */
export const parseXml = (text: string): XmlParseResult => {
    if (text.length > MAX_XML_BYTES) {
        return { ok: false, message: 'The XML document is larger than 5 MB.' };
    }
    if (DOCTYPE.test(text)) {
        return { ok: false, message: 'XML with a DOCTYPE or entity declaration is not allowed.' };
    }
    if (typeof DOMParser === 'undefined') {
        return { ok: false, message: 'This environment cannot parse XML.' };
    }
    const document = new DOMParser().parseFromString(text, 'application/xml');
    const error = document.getElementsByTagName('parsererror')[0];
    if (error) {
        const message = (error.textContent ?? 'The XML is not well-formed.').trim();
        // Browsers prefix the message with the engine's boilerplate; keep the first useful line.
        return { ok: false, message: message.split('\n').find((line) => line.trim()) ?? message };
    }
    return { ok: true, document };
};

/** Why `text` is not well-formed XML, or null when it is. `{{variables}}` are tolerated. */
export const xmlProblem = (text: string): string | null => {
    if (!text.trim()) return null;
    const result = parseXml(`<r>${text.replace(/^\s*<\?xml[^>]*\?>/, '')}</r>`);
    return result.ok ? null : result.message;
};

export const escapeXml = (text: string): string =>
    text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Throws `INVALID_REQUEST` for text that cannot be inserted into a header value. */
export const assertHeaderSafe = (label: string, value: string) => {
    if (/[\r\n\0]/.test(value)) {
        throw new AppError('INVALID_REQUEST', `${label} cannot contain line breaks.`);
    }
};
