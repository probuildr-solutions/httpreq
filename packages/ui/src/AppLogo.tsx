/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { useId } from 'react';

/**
 * The HttpReq mark: the "API" glyph on the violet-to-indigo tile. Kept in sync with the desktop
 * icon master at `apps/desktop/build/icon.svg`.
 */
export function AppLogo({ size = 18, title }: { size?: number; title?: string }) {
    const gradient = useId();
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            role={title ? 'img' : undefined}
            aria-label={title}
            aria-hidden={title ? undefined : true}
            focusable="false"
        >
            <defs>
                <linearGradient id={gradient} x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0" stopColor="#845ef7" />
                    <stop offset="1" stopColor="#4c6ef5" />
                </linearGradient>
            </defs>
            <rect width="24" height="24" rx="5.5" fill={`url(#${gradient})`} />
            <g
                transform="translate(12 12) scale(0.78) translate(-12 -12)"
                fill="none"
                stroke="#fff"
                strokeWidth="2.3"
                strokeLinecap="round"
                strokeLinejoin="round"
            >
                <path d="M4 13h5" />
                <path d="M12 16v-8h3a2 2 0 0 1 2 2v1a2 2 0 0 1 -2 2h-3" />
                <path d="M20 8v8" />
                <path d="M9 16v-5.5a2.5 2.5 0 0 0 -5 0v5.5" />
            </g>
        </svg>
    );
}
