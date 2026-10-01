/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 *
 * The profile list shared by the SSH and tunnel sidebar views.
 */

export const PANEL = 'flex h-full min-h-0 flex-col';
export const LIST = 'min-h-0 flex-1 overflow-auto py-1';
export const EMPTY = 'px-3 py-[18px] text-center';
export const ITEM =
    'flex w-full cursor-pointer items-center gap-2 border-0 bg-transparent px-2 py-[5px] text-left text-sm text-inherit hover:bg-hover focus-visible:bg-hover data-[checked]:bg-primary-soft';
export const ITEM_TEXT =
    'min-w-0 flex-1 cursor-pointer border-0 bg-transparent p-0 text-left text-inherit';
export const ITEM_NAME = 'block truncate';
export const ITEM_DETAIL = 'block truncate font-mono text-[11px] text-dimmed';
export const ITEM_ACTIONS = 'flex flex-none items-center gap-1 [&[hidden]]:hidden';
