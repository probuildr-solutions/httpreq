/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { AppError, type AppErrorCode } from '@httpreq/shared';

export type ExecutionOutcome<T> =
    | { kind: 'success'; value: T }
    | { kind: 'cancelled' }
    | { kind: 'failed'; message: string; code?: AppErrorCode };

const isAbortError = (error: unknown) =>
    error instanceof DOMException && error.name === 'AbortError';

/**
 * Runs request executions with one AbortController per request tab, so tabs can send
 * concurrently and cancelling one tab never affects another. What "running" means (the
 * pipeline and runtime) is supplied by the caller.
 */
export function useRequestExecution() {
    const controllers = useRef(new Map<string, AbortController>());
    const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());

    const setSending = useCallback((requestId: string, sending: boolean) => {
        setPending((previous) => {
            const next = new Set(previous);
            if (sending) next.add(requestId);
            else next.delete(requestId);
            return next;
        });
    }, []);

    const send = useCallback(
        async <T>(
            requestId: string,
            run: (signal: AbortSignal) => Promise<T>,
        ): Promise<ExecutionOutcome<T>> => {
            controllers.current.get(requestId)?.abort();
            const controller = new AbortController();
            controllers.current.set(requestId, controller);
            setSending(requestId, true);
            try {
                return { kind: 'success', value: await run(controller.signal) };
            } catch (error) {
                if (isAbortError(error) && controller.signal.aborted) return { kind: 'cancelled' };
                return error instanceof AppError
                    ? { kind: 'failed', message: error.message, code: error.code }
                    : { kind: 'failed', message: 'An unexpected error occurred.' };
            } finally {
                // A newer send for the same tab owns the entry once it has replaced this controller.
                if (controllers.current.get(requestId) === controller) {
                    controllers.current.delete(requestId);
                    setSending(requestId, false);
                }
            }
        },
        [setSending],
    );

    const cancel = useCallback((requestId: string) => {
        controllers.current.get(requestId)?.abort();
    }, []);

    const isSending = useCallback((requestId: string) => pending.has(requestId), [pending]);

    useEffect(() => {
        const active = controllers.current;
        return () => active.forEach((controller) => controller.abort());
    }, []);

    return { send, cancel, isSending };
}
