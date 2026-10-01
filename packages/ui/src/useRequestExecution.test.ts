/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AppError } from '@httpreq/shared';
import { useRequestExecution } from './useRequestExecution';

/** Runs that stay pending until resolved by id, and honour abort signals. */
const createControllableRuns = () => {
    const resolvers = new Map<string, (value: string) => void>();
    const run = (id: string) => (signal: AbortSignal) =>
        new Promise<string>((resolve, reject) => {
            resolvers.set(id, resolve);
            signal.addEventListener('abort', () =>
                reject(new DOMException('Aborted', 'AbortError')),
            );
        });
    return { run, resolve: (id: string) => resolvers.get(id)?.(`response ${id}`) };
};

describe('useRequestExecution', () => {
    it('tracks and cancels requests per tab independently', async () => {
        const { run, resolve } = createControllableRuns();
        const { result } = renderHook(() => useRequestExecution());

        let firstOutcome!: ReturnType<typeof result.current.send<string>>;
        let secondOutcome!: ReturnType<typeof result.current.send<string>>;
        act(() => {
            firstOutcome = result.current.send('a', run('a'));
            secondOutcome = result.current.send('b', run('b'));
        });
        expect(result.current.isSending('a')).toBe(true);
        expect(result.current.isSending('b')).toBe(true);

        await act(async () => {
            result.current.cancel('b');
            await expect(secondOutcome).resolves.toEqual({ kind: 'cancelled' });
        });
        expect(result.current.isSending('b')).toBe(false);
        expect(result.current.isSending('a')).toBe(true);

        await act(async () => {
            resolve('a');
            await expect(firstOutcome).resolves.toEqual({ kind: 'success', value: 'response a' });
        });
        expect(result.current.isSending('a')).toBe(false);
    });

    it('reports AppError messages as failures', async () => {
        const { result } = renderHook(() => useRequestExecution());
        await act(async () => {
            await expect(
                result.current.send('a', () =>
                    Promise.reject(new AppError('NETWORK_ERROR', 'Connection refused.')),
                ),
            ).resolves.toEqual({
                kind: 'failed',
                message: 'Connection refused.',
                code: 'NETWORK_ERROR',
            });
        });
    });
});
