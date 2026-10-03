/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { DbError, STUDIO_BUDGETS } from '@httpreq/db-core';

/**
 * Parses one document, and only that one. The caller supplies the bytes of a single indexed
 * range, so this never sees a whole file; the size cap is a second guard for a single enormous
 * document.
 */
export const parseDocument = (
    bytes: Uint8Array,
    maxBytes: number = STUDIO_BUDGETS.maxSingleItemBytes,
): unknown => {
    if (bytes.length > maxBytes) {
        throw new DbError('LIMIT_EXCEEDED', 'That document is too large to open as a whole.');
    }
    try {
        return JSON.parse(new TextDecoder('utf-8', { ignoreBOM: false }).decode(bytes));
    } catch {
        throw new DbError('INVALID_REQUEST', 'This document is not valid JSON.');
    }
};

/**
 * A one-line preview of a document's text: whitespace collapsed, cut at `maxChars`. Used by lists
 * of documents, where only the beginning of each is shown.
 */
export const previewText = (text: string, maxChars = 160): string => {
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat.length > maxChars ? `${flat.slice(0, maxChars)}…` : flat;
};
