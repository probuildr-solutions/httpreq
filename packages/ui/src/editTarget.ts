/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

/**
 * What a profile dialog is editing: a saved item, looked up by id, or a new one that exists only
 * in the dialog until the user saves it. Closing the dialog on a new item discards it, so an
 * abandoned "New…" never leaves an empty entry in the workspace.
 */
export type EditTarget<T> = { kind: 'edit'; id: string } | { kind: 'new'; value: T };

export const editExisting = <T>(id: string): EditTarget<T> => ({ kind: 'edit', id });
export const editNew = <T>(value: T): EditTarget<T> => ({ kind: 'new', value });
