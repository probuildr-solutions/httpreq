/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */
import { cx } from './cx';

/** `toolbar` is the compact picker height of the title bar and the query toolbar (24px). */
export type FieldSize = 'toolbar' | 'xs' | 'sm' | 'md';

/** Height and type size of a single-line control, per size step. */
export const CONTROL_SIZE: Record<FieldSize, string> = {
    toolbar: 'h-6 min-h-6 text-xs',
    // `xs` and `sm` differ only in type size: both are the design system's control height
    // (`--control-h`), the same as the variable-aware fields and default buttons.
    xs: 'min-h-[var(--control-h)] text-xs',
    sm: 'min-h-[var(--control-h)] text-sm',
    md: 'min-h-[42px] text-base',
};

/**
 * Height, type size and horizontal padding of a control. An `unstyled` control sits inside a
 * table cell, so it is one row tall (28px) and uses the cell's 8px padding.
 */
export const controlSize = (size: FieldSize, variant: 'default' | 'unstyled') =>
    variant === 'unstyled'
        ? cx('min-h-7 px-2', size === 'xs' || size === 'toolbar' ? 'text-xs' : 'text-sm')
        : cx(CONTROL_SIZE[size], size === 'toolbar' ? 'px-2' : 'px-[var(--control-px)]');

/** The frame every text control shares. `unstyled` drops it for controls embedded in a table. */
export const inputFrame = (variant: 'default' | 'unstyled', invalid?: boolean, size?: FieldSize) =>
    variant === 'unstyled'
        ? 'border-0 bg-transparent focus-within:shadow-[inset_0_0_0_1px_var(--color-primary)]'
        : cx(
              'rounded-sm border bg-field transition-colors focus-within:border-primary',
              invalid
                  ? 'border-danger'
                  : size === 'toolbar'
                    ? 'border-line-strong hover:border-line-stronger hover:bg-hover aria-expanded:border-primary'
                    : 'border-line',
          );
