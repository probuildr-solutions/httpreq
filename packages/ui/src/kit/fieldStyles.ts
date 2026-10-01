/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */
import { cx } from './cx';

export type FieldSize = 'xs' | 'sm' | 'md';

/** Height and type size of a single-line control, per size step. */
export const CONTROL_SIZE: Record<FieldSize, string> = {
    xs: 'min-h-[30px] text-xs',
    // Forms set `--control-h` (see FORM_DENSITY) so selects and number fields match the 30px
    // variable-aware fields beside them.
    sm: 'min-h-[var(--control-h,2.25rem)] text-sm',
    md: 'min-h-[42px] text-base',
};

/**
 * Height, type size and horizontal padding of a control. An `unstyled` control sits inside a
 * table cell, so it is one row tall (28px) and uses the cell's 8px padding.
 */
export const controlSize = (size: FieldSize, variant: 'default' | 'unstyled') =>
    variant === 'unstyled'
        ? cx('min-h-7 px-2', size === 'xs' ? 'text-xs' : 'text-sm')
        : cx(CONTROL_SIZE[size], 'px-2.5');

/** The frame every text control shares. `unstyled` drops it for controls embedded in a table. */
export const inputFrame = (variant: 'default' | 'unstyled', invalid?: boolean) =>
    variant === 'unstyled'
        ? 'border-0 bg-transparent focus-within:shadow-[inset_0_0_0_1px_var(--color-primary)]'
        : cx(
              'rounded-sm border bg-field transition-colors focus-within:border-primary',
              invalid ? 'border-danger' : 'border-line',
          );
