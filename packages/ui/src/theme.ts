/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

/**
 * The font stacks, for the few places that cannot read the CSS tokens (the Monaco editor and the
 * terminal take a font family as a string). They mirror `--font-sans` and `--font-mono` in
 * `tailwind.css`, which is where the design system defines them.
 */
export const UI_FONT_FAMILY =
    "Poppins, 'Segoe UI', system-ui, -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif";
export const MONO_FONT_FAMILY =
    "'JetBrains Mono', 'Cascadia Code', 'SF Mono', SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace";
