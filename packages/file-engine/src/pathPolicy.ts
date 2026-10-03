/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { DbError } from '@httpreq/db-core';

const MAX_PATH_CHARS = 4096;

/** Names Windows treats as devices wherever they appear, with or without an extension. */
const WINDOWS_DEVICE_NAME = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(\..*)?$/i;

const isWindowsAbsolute = (path: string): boolean =>
    /^[a-zA-Z]:[\\/]/.test(path) || /^\\\\[^\\/?.]/.test(path);

const isPosixAbsolute = (path: string): boolean => path.startsWith('/');

/**
 * Checks a path string before any I/O. This is a syntax check; whether the target is a regular
 * file is decided later, on the opened handle, so it cannot change between check and use.
 *
 * Rejected: non-strings, empty or very long paths, NUL bytes (which truncate paths in native
 * code), relative paths (the process working directory means nothing to a user), the Windows
 * device namespaces (`\\.\` and `\\?\`, which reach devices and bypass normalization), and
 * reserved device names such as `NUL` or `COM1`. UNC network shares (`\\server\share\file`) are
 * ordinary files and are allowed.
 */
export const assertSafeLocalPath = (path: unknown): string => {
    if (typeof path !== 'string' || path.length === 0) {
        throw new DbError('INVALID_REQUEST', 'A file path is required.');
    }
    if (path.length > MAX_PATH_CHARS) {
        throw new DbError('INVALID_REQUEST', 'The file path is too long.');
    }
    if (path.includes('\0')) {
        throw new DbError('INVALID_REQUEST', 'The file path contains an invalid character.');
    }
    if (path.startsWith('\\\\.\\') || path.startsWith('\\\\?\\') || path.startsWith('//./')) {
        throw new DbError('INVALID_REQUEST', 'Device paths cannot be opened.');
    }
    if (!isWindowsAbsolute(path) && !isPosixAbsolute(path)) {
        throw new DbError('INVALID_REQUEST', 'The file path must be absolute.');
    }
    const last = path.split(/[\\/]/).pop() ?? '';
    if (WINDOWS_DEVICE_NAME.test(last) && !isPosixAbsolute(path)) {
        throw new DbError('INVALID_REQUEST', 'That name refers to a device, not a file.');
    }
    return path;
};

/** The file name to show in the UI: never the directory, which can name the user. */
export const displayName = (path: string): string => path.split(/[\\/]/).pop() || path;
