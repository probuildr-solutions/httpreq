/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

/**
 * The failures every Database Studio package reports. A code, not a class hierarchy, so an error
 * survives a trip across a process boundary (structured clone drops prototypes) and the UI can
 * branch on it without importing the package that raised it.
 */
export type DbErrorCode =
    | 'CANCELLED'
    | 'TIMEOUT'
    | 'INVALID_REQUEST'
    | 'NOT_FOUND'
    | 'PERMISSION_DENIED'
    | 'UNSUPPORTED'
    | 'CONFLICT'
    | 'QUERY_FAILED'
    | 'AUTH_FAILED'
    | 'CONNECTION_FAILED'
    | 'LIMIT_EXCEEDED'
    | 'IO_ERROR'
    | 'WORKER_CRASHED'
    | 'WORKER_UNAVAILABLE'
    | 'INTERNAL';

/** The serializable form of a {@link DbError}. */
export interface DbErrorInfo {
    code: DbErrorCode;
    message: string;
}

export class DbError extends Error {
    readonly code: DbErrorCode;
    /** The server's own error number and SQLSTATE, when the failure came from a server. */
    readonly server?: { number?: number; state?: string };

    constructor(
        code: DbErrorCode,
        message: string,
        options?: { cause?: unknown; server?: { number?: number; state?: string } },
    ) {
        super(message, options?.cause === undefined ? undefined : { cause: options.cause });
        this.name = 'DbError';
        this.code = code;
        this.server = options?.server;
    }

    toInfo(): DbErrorInfo {
        return { code: this.code, message: this.message };
    }
}

const CODES: ReadonlySet<string> = new Set<DbErrorCode>([
    'CANCELLED',
    'TIMEOUT',
    'INVALID_REQUEST',
    'NOT_FOUND',
    'PERMISSION_DENIED',
    'UNSUPPORTED',
    'CONFLICT',
    'QUERY_FAILED',
    'AUTH_FAILED',
    'CONNECTION_FAILED',
    'LIMIT_EXCEEDED',
    'IO_ERROR',
    'WORKER_CRASHED',
    'WORKER_UNAVAILABLE',
    'INTERNAL',
]);

export const isDbErrorInfo = (value: unknown): value is DbErrorInfo =>
    !!value &&
    typeof value === 'object' &&
    typeof (value as DbErrorInfo).message === 'string' &&
    CODES.has((value as DbErrorInfo).code);

const isAbortLike = (error: unknown): boolean =>
    !!error &&
    typeof error === 'object' &&
    ((error as { name?: unknown }).name === 'AbortError' ||
        (error as { code?: unknown }).code === 'ABORT_ERR');

/**
 * Normalizes anything thrown into a {@link DbError}. Node system errors become `IO_ERROR` or
 * `NOT_FOUND` with the OS error code but without the path Node puts in its message, so a failure
 * shown in the UI or written to a log does not carry a user's directory names.
 */
export const toDbError = (error: unknown): DbError => {
    if (error instanceof DbError) return error;
    if (isDbErrorInfo(error)) return new DbError(error.code, error.message);
    if (isAbortLike(error)) return new DbError('CANCELLED', 'The operation was cancelled.');
    const code = (error as { code?: unknown } | null)?.code;
    if (typeof code === 'string' && /^E[A-Z]+$/.test(code)) {
        if (code === 'ENOENT') return new DbError('NOT_FOUND', 'The file does not exist.');
        if (code === 'EACCES' || code === 'EPERM') {
            return new DbError('PERMISSION_DENIED', 'The file cannot be read: access denied.');
        }
        return new DbError('IO_ERROR', `The file could not be read (${code}).`, { cause: error });
    }
    return new DbError('INTERNAL', 'An unexpected error occurred.', { cause: error });
};

/** Throws `CANCELLED` (or `TIMEOUT` when the signal carries that reason) if the signal fired. */
export const throwIfAborted = (signal: AbortSignal | undefined): void => {
    if (!signal?.aborted) return;
    const reason: unknown = signal.reason;
    if (reason instanceof DbError) throw reason;
    throw new DbError('CANCELLED', 'The operation was cancelled.');
};
