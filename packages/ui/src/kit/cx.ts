/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

/** Joins class names, skipping anything falsy, so conditional styling reads as one expression. */
export const cx = (...parts: Array<string | false | null | undefined>): string =>
    parts.filter(Boolean).join(' ');
