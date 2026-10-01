/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */
import type { ReactNode } from 'react';
import { create } from 'zustand';
import type { Tone } from './tones';

export interface NotificationOptions {
    /** Showing a notification with an id that is already visible replaces it. */
    id?: string;
    color?: Tone;
    title?: ReactNode;
    message: ReactNode;
    /** Milliseconds before it hides itself; `false` keeps it until dismissed. */
    autoClose?: number | false;
}

export interface Entry extends NotificationOptions {
    id: string;
}

interface NotificationsState {
    entries: Entry[];
}

/** The notifications currently on screen. */
export const useNotificationStore = create<NotificationsState>(() => ({ entries: [] }));

let counter = 0;

/** The imperative API used by the rest of the app to report outcomes. */
export const notifications = {
    show(options: NotificationOptions): string {
        const id = options.id ?? `notification-${++counter}`;
        useNotificationStore.setState((state) => ({
            entries: [...state.entries.filter((entry) => entry.id !== id), { ...options, id }],
        }));
        return id;
    },
    hide(id: string) {
        useNotificationStore.setState((state) => ({
            entries: state.entries.filter((entry) => entry.id !== id),
        }));
    },
    clean() {
        useNotificationStore.setState({ entries: [] });
    },
};
