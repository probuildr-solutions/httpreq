/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { IconDots } from '@tabler/icons-react';
import type { ComponentPropsWithoutRef, ReactNode, Ref } from 'react';
import { cx } from '../kit';

/** Height of every row of the explorer tree, so no state of a row can change it. */
export const TREE_ROW_HEIGHT = 'h-7';

/**
 * The slot at the right edge of an explorer row that holds its actions. One component serves every
 * level of the tree (connection, database, schema, table, collection, view, routine, trigger,
 * event, column, index…), so the three-dot button is centred the same way everywhere.
 *
 * The slot is a fixed 24×24 box that centres its content on both axes. Nothing inside it flows as
 * text, so no line box adds a baseline offset, and it does not change size between the normal,
 * hover, selected and menu-open states: only its opacity does. It stays visible while a menu
 * opened from it is open or while it has keyboard focus.
 */
export function TreeRowActions({ children }: { children: ReactNode }) {
    return (
        <span
            data-tree-actions
            className="mr-0.5 flex size-6 flex-none items-center justify-center opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 has-[[aria-expanded=true]]:opacity-100"
        >
            {children}
        </span>
    );
}

/**
 * The three-dot button. Its hit area is the full 24px slot; the icon is 14px. As a menu target it
 * receives the menu's ref and props, so it forwards both.
 */
export function TreeRowMenuButton({
    ref,
    className,
    ...props
}: ComponentPropsWithoutRef<'button'> & { ref?: Ref<HTMLButtonElement> }) {
    return (
        <button
            ref={ref}
            type="button"
            {...props}
            className={cx(
                'grid size-6 place-items-center rounded-sm border-0 bg-transparent p-0 text-dimmed',
                'hover:bg-chrome-hover hover:text-fg aria-expanded:bg-chrome-hover aria-expanded:text-fg',
                className,
            )}
        >
            <IconDots size={14} aria-hidden />
        </button>
    );
}
