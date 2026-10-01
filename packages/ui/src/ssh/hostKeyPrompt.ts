/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

/**
 * Props for a dialog that can raise a host-key prompt — "Test connection" in the SSH profile
 * dialog, "Start" in the tunnel dialog.
 *
 * While the question is pending, the dialog underneath stops trapping focus, so the prompt can
 * hold it, and stops accepting pointer input and dismissal, so the connection cannot be answered
 * out from under itself. Everything is restored the moment the prompt is answered.
 *
 * The other half of the arrangement is in `HostKeyDialog`, which takes its own stacking layer.
 */
export const yieldToHostKeyPrompt = (pending: boolean) =>
    ({
        trapFocus: !pending,
        closeOnEscape: !pending,
        closeOnClickOutside: !pending,
        styles: { content: { pointerEvents: pending ? 'none' : undefined } },
    }) as const;
