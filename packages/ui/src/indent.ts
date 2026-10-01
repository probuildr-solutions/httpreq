/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

/**
 * The one indentation setting for every editor and every pretty-printer in the app: JSON and XML
 * bodies, the response viewer, WebSocket messages, imported specifications and exported files.
 */
export const INDENT_SIZE = 4;

/** `JSON.stringify` with the app's indentation. */
export const stringifyPretty = (value: unknown): string => JSON.stringify(value, null, INDENT_SIZE);
