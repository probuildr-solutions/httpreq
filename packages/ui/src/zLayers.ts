/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

/**
 * The application's stacking order, in one place.
 *
 * A single default for every overlay (200) leaves two open dialogs ordered by
 * whichever portal happens to be earlier in the DOM. That is fine while dialogs are mutually
 * exclusive, and wrong as soon as one of them raises another: a confirmation, or the host-key
 * question a connection asks in the middle of "Test connection". Each of those gets its own
 * layer here rather than an arbitrary large number at the call site.
 */
export const Z_LAYERS = {
    /** The title bar. Above the navbar so its menus drop over the sidebar, below every dialog. */
    header: 150,
    /** The default for `Modal`: an ordinary, self-contained dialog. */
    dialog: 200,
    /** A confirmation raised from inside a dialog, which has to be answered before it. */
    confirm: 300,
    /**
     * Host-key verification. It interrupts a connection started from another dialog, so it sits
     * above everything else the user can have open.
     */
    hostKey: 400,
} as const;
