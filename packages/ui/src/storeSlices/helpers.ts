/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */
import type { Workspace } from '@httpreq/shared';

/** A workspace with `patch` applied and its modification time bumped, so it is persisted. */
export const touch = (workspace: Workspace, patch: Partial<Workspace>): Workspace => ({
    ...workspace,
    ...patch,
    updatedAt: new Date().toISOString(),
});

/**
 * The tab to activate after `closing` tabs go: the nearest one still open, looking left first,
 * the way an editor does. `null` when nothing is left.
 */
export const nearestOpen = (
    open: readonly string[],
    closing: ReadonlySet<string>,
    active: string,
) => {
    const index = open.indexOf(active);
    for (let i = index - 1; i >= 0; i -= 1) if (!closing.has(open[i]!)) return open[i]!;
    for (let i = index + 1; i < open.length; i += 1) if (!closing.has(open[i]!)) return open[i]!;
    return null;
};
