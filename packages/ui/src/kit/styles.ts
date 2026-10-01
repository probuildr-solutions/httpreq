/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

/**
 * A button that names the current choice and opens a menu of the others: the workspace switcher
 * and the environment picker. It keeps a visible border at rest, so among tabs and title-bar
 * labels it reads as something to click, in both colour schemes.
 */
export const PICKER_TRIGGER =
    'inline-flex items-center gap-1.5 rounded-sm border border-line-strong bg-field text-xs text-fg ' +
    'hover:border-line-stronger hover:bg-hover aria-expanded:border-primary ' +
    'focus-visible:outline-offset-1 disabled:cursor-progress disabled:opacity-60';

/** A name inside a picker or menu row: one line, truncated, so a long name never widens the control. */
export const TRUNCATE_NAME = 'block truncate';

/** The row that holds a status dot and its label. */
export const STATUS_ROW = 'inline-flex items-center gap-1.5 text-xs whitespace-nowrap';
