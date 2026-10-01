/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import '@testing-library/jest-dom/vitest';

// Node-environment tests (e.g. the Electron main process) have no window to polyfill.
if (typeof window !== 'undefined') {
    Object.defineProperty(window, 'matchMedia', {
        writable: true,
        value: (query: string) => ({
            matches: false,
            media: query,
            onchange: null,
            addListener: () => undefined,
            removeListener: () => undefined,
            addEventListener: () => undefined,
            removeEventListener: () => undefined,
            dispatchEvent: () => false,
        }),
    });

    // jsdom has no ResizeObserver, and components that watch their own box (the terminal, the tab
    // strip) construct one on mount. The stub never fires: a test that needs a resize drives the
    // component directly rather than waiting for a layout jsdom does not perform.
    if (!('ResizeObserver' in window)) {
        Object.defineProperty(window, 'ResizeObserver', {
            writable: true,
            value: class {
                observe() {}
                unobserve() {}
                disconnect() {}
            },
        });
    }
}
