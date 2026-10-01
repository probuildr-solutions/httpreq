/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */
import { useSyncExternalStore } from 'react';

/** What the user picked; `auto` follows the operating system. */
export type ColorSchemePreference = 'light' | 'dark' | 'auto';

const STORAGE_KEY = 'httpreq-color-scheme';

const systemQuery = () =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-color-scheme: dark)')
        : null;

const listeners = new Set<() => void>();

const isPreference = (value: unknown): value is ColorSchemePreference =>
    value === 'light' || value === 'dark' || value === 'auto';

const read = (): ColorSchemePreference => {
    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (isPreference(stored)) return stored;
    } catch {
        // Storage can be unavailable (private mode, blocked); the default applies.
    }
    return 'auto';
};

let preference = read();

const resolve = (value: ColorSchemePreference): 'light' | 'dark' =>
    value === 'auto' ? (systemQuery()?.matches ? 'dark' : 'light') : value;

/** Stamps the resolved scheme on <html>, which is what every design token keys off. */
const apply = () => {
    if (typeof document === 'undefined') return;
    document.documentElement.dataset.theme = resolve(preference);
    for (const listener of listeners) listener();
};

/** Applies the stored preference and tracks the system setting. Call once before first paint. */
export const initColorScheme = () => {
    preference = read();
    apply();
    systemQuery()?.addEventListener?.('change', apply);
};

export const setColorScheme = (value: ColorSchemePreference) => {
    preference = value;
    try {
        localStorage.setItem(STORAGE_KEY, value);
    } catch {
        // The choice still applies for this session.
    }
    apply();
};

const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
};

/** The user's stored preference and its setter. */
export const useColorSchemePreference = () => ({
    colorScheme: useSyncExternalStore(subscribe, () => preference),
    setColorScheme,
});

/** The scheme actually in effect (`auto` already resolved), for code that needs light or dark. */
export const useComputedColorScheme = (): 'light' | 'dark' =>
    useSyncExternalStore(subscribe, () => resolve(preference));

/** Flips between light and dark from whatever is currently shown. */
export const toggleColorScheme = () =>
    setColorScheme(resolve(preference) === 'dark' ? 'light' : 'dark');
