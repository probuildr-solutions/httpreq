/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 *
 * Class strings shared by the sidebar views, so a collection row, an environment row and a
 * history row keep the same height, type and states.
 */

/** A view fills the sidebar's panel and scrolls its list. */
export const EXPLORER = 'flex min-h-0 flex-1 flex-col';

/** The scrolling list of rows. */
export const TREE = 'min-h-0 flex-1 overflow-y-auto px-1 pb-2';

/** The small caps label above a group of rows and in the panel header. */
export const SECTION_LABEL = 'text-[10.5px] font-semibold uppercase tracking-[0.06em] text-dimmed';

/** A group heading inside a list. It doubles as a drop target for drafts. */
export const SECTION_HEADING = `mt-2.5 rounded-xs px-2 py-1 ${SECTION_LABEL} data-[drop]:bg-primary-soft data-[drop]:text-primary-text data-[drop]:shadow-[inset_0_0_0_1px_var(--color-primary)] data-[drag=invalid]:opacity-45`;

/** A row's name: one line, truncated. */
export const ROW_NAME =
    'min-w-0 flex-1 truncate data-[deleted]:text-dimmed data-[deleted]:line-through';

/** The verb label at the start of a request row. */
export const METHOD_LABEL = 'w-8 flex-none text-right font-mono text-[10px] font-bold';

/** The tinted background of a selected or checked row. */
export const ROW_SELECTED = 'data-[selected]:bg-primary-soft data-[checked]:bg-primary-soft';

/** A row in a list of environments or history entries. */
export const SIMPLE_ROW = `rounded-xs text-[12.5px] ${ROW_SELECTED} data-[selectable]:cursor-pointer`;
