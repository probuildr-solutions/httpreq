/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */
import { cx } from './cx';

/**
 * A connection state as a small coloured dot: green when up, amber while changing, red on error,
 * grey otherwise. Pair it with a text label, since colour alone is not a state.
 */
export function StatusDot({ status, className }: { status: string; className?: string }) {
    return (
        <span
            aria-hidden
            data-status={status}
            className={cx(
                'size-2 flex-none rounded-full bg-gray-5',
                'data-[status=connected]:bg-teal-6 data-[status=active]:bg-teal-6',
                'data-[status=connecting]:bg-yellow-6 data-[status=disconnecting]:bg-yellow-6 data-[status=starting]:bg-yellow-6 data-[status=stopping]:bg-yellow-6',
                'data-[status=connecting]:animate-pulse-soft data-[status=disconnecting]:animate-pulse-soft data-[status=starting]:animate-pulse-soft data-[status=stopping]:animate-pulse-soft',
                'data-[status=error]:bg-red-6',
                'motion-reduce:animate-none',
                className,
            )}
        />
    );
}
