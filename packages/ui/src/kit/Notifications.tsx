/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */
import { useEffect } from 'react';
import { IconX } from '@tabler/icons-react';
import { cx } from './cx';
import { notifications, useNotificationStore, type Entry } from './notificationStore';
import type { Tone } from './tones';

const ACCENT: Record<Tone, string> = {
    primary: 'border-l-primary',
    violet: 'border-l-primary',
    gray: 'border-l-neutral',
    red: 'border-l-danger',
    yellow: 'border-l-warning',
    teal: 'border-l-success',
    blue: 'border-l-info',
};

const DEFAULT_DURATION = 4000;

function Toast({ entry }: { entry: Entry }) {
    const duration = entry.autoClose ?? DEFAULT_DURATION;
    useEffect(() => {
        if (duration === false) return;
        const timer = setTimeout(() => notifications.hide(entry.id), duration);
        // Re-showing the same id restarts the countdown because the entry object changes.
        return () => clearTimeout(timer);
    }, [entry, duration]);

    return (
        <div
            role="status"
            className={cx(
                'pointer-events-auto flex w-80 animate-pop items-start gap-2 rounded-sm border border-l-4 border-line bg-surface p-3 shadow-popup',
                ACCENT[entry.color ?? 'primary'],
            )}
        >
            <div className="min-w-0 flex-1 text-sm">
                {entry.title && <div className="font-semibold">{entry.title}</div>}
                <div className={cx('wrap-anywhere', !!entry.title && 'text-dimmed')}>
                    {entry.message}
                </div>
            </div>
            <button
                type="button"
                aria-label="Close notification"
                className="flex text-dimmed hover:text-fg"
                onClick={() => notifications.hide(entry.id)}
            >
                <IconX size={14} aria-hidden />
            </button>
        </div>
    );
}

/** Renders the visible notifications, stacked in the bottom-right corner above the app. */
export function Notifications() {
    const entries = useNotificationStore((state) => state.entries);
    return (
        <div className="pointer-events-none fixed right-4 bottom-4 z-[2000] flex flex-col gap-2">
            {entries.map((entry) => (
                <Toast key={entry.id} entry={entry} />
            ))}
        </div>
    );
}
