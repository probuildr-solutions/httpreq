/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

let started = false;

type IdleCallback = (callback: () => void, options?: { timeout: number }) => void;
const whenIdle: IdleCallback = (callback, options) =>
    'requestIdleCallback' in window
        ? void window.requestIdleCallback(callback, options)
        : void setTimeout(callback, 200);

/**
 * Loads Monaco and creates (and throws away) one editor once the app is idle after start-up.
 * Downloading and compiling Monaco, and building its services on the first `editor.create`, is
 * most of what made the first body, script or response editor slow to appear; doing it ahead of
 * time means the first real editor is ready almost at once.
 */
export const preloadEditor = () => {
    // jsdom (tests) has no layout or canvas for Monaco to measure.
    if (started || typeof window === 'undefined' || navigator.userAgent.includes('jsdom')) return;
    started = true;
    whenIdle(
        () =>
            void Promise.all([
                import('../monaco'),
                import('../LocalEditor'),
                import('../ResponseViewer'),
            ])
                .then(([monaco]) => whenIdle(monaco.warmUp, { timeout: 3000 }))
                .catch(() => undefined),
        { timeout: 3000 },
    );
};
