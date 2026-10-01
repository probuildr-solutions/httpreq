/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import type { Folder, HttpMethod, TreeNodeKind, Workspace } from '@httpreq/shared';

export interface TreeRow {
    id: string;
    kind: TreeNodeKind;
    name: string;
    depth: number;
    parentId: string | null;
    /** HTTP rows carry their verb; WebSocket rows are labelled "WS" by the explorer. */
    method?: HttpMethod;
    url?: string;
    hasChildren: boolean;
    expanded: boolean;
}

/**
 * The visible rows of the explorer, depth-first: folders, then HTTP requests, then WebSocket
 * requests. While filtering, a node is shown when it or any descendant matches, and every shown
 * container is expanded.
 */
export const buildRows = (
    workspace: Workspace,
    expanded: ReadonlySet<string>,
    filter: string,
): { collections: TreeRow[]; drafts: TreeRow[] } => {
    const query = filter.trim().toLowerCase();

    /*
     * Children by parent, built in one pass. Looking them up by filtering the whole workspace for
     * every container made this quadratic: 240 containers over 5,000 requests is over a million
     * comparisons each time the tree changes.
     */
    const group = <T extends { parentId: string | null }>(items: readonly T[]) => {
        const map = new Map<string | null, T[]>();
        for (const item of items) {
            const list = map.get(item.parentId);
            if (list) list.push(item);
            else map.set(item.parentId, [item]);
        }
        return map;
    };
    const foldersByParent = group<Folder>(workspace.folders);
    const requestsByParent = group(workspace.requests);
    const socketsByParent = group(workspace.websocketRequests);
    const childFolders = (id: string) => foldersByParent.get(id) ?? [];
    const matches = (text: string | undefined) => !!text && text.toLowerCase().includes(query);
    const leafMatches = (item: { name: string; url: string }) =>
        matches(item.name) || matches(item.url);

    const leaves = (parentId: string | null) => [
        ...(requestsByParent.get(parentId) ?? []).map((item) => ({
            item,
            kind: 'request' as const,
        })),
        ...(socketsByParent.get(parentId) ?? []).map((item) => ({
            item,
            kind: 'websocket' as const,
        })),
    ];
    const childCount = (id: string) =>
        childFolders(id).length +
        (requestsByParent.get(id)?.length ?? 0) +
        (socketsByParent.get(id)?.length ?? 0);

    const memo = new Map<string, boolean>();
    const containerMatches = (id: string, name: string): boolean => {
        if (!query) return true;
        const cached = memo.get(id);
        if (cached !== undefined) return cached;
        const result =
            matches(name) ||
            childFolders(id).some((folder) => containerMatches(folder.id, folder.name)) ||
            leaves(id).some(({ item }) => leafMatches(item));
        memo.set(id, result);
        return result;
    };

    const leafRow = (
        item: { id: string; name: string; url: string; method?: HttpMethod },
        kind: 'request' | 'websocket',
        depth: number,
        parentId: string | null,
    ): TreeRow => ({
        id: item.id,
        kind,
        name: item.name,
        depth,
        parentId,
        ...(item.method ? { method: item.method } : {}),
        url: item.url,
        hasChildren: false,
        expanded: false,
    });

    const rows: TreeRow[] = [];
    const visit = (id: string, depth: number, parentMatched: boolean) => {
        for (const folder of childFolders(id)) {
            const selfMatch = parentMatched || matches(folder.name);
            if (query && !selfMatch && !containerMatches(folder.id, folder.name)) continue;
            const open = query ? true : expanded.has(folder.id);
            rows.push({
                id: folder.id,
                kind: 'folder',
                name: folder.name,
                depth,
                parentId: id,
                hasChildren: childCount(folder.id) > 0,
                expanded: open,
            });
            if (open) visit(folder.id, depth + 1, selfMatch && !!query);
        }
        for (const { item, kind } of leaves(id)) {
            if (query && !parentMatched && !leafMatches(item)) continue;
            rows.push(leafRow(item, kind, depth, id));
        }
    };

    for (const collection of workspace.collections) {
        const selfMatch = !!query && matches(collection.name);
        if (query && !containerMatches(collection.id, collection.name)) continue;
        const open = query ? true : expanded.has(collection.id);
        rows.push({
            id: collection.id,
            kind: 'collection',
            name: collection.name,
            depth: 0,
            parentId: null,
            hasChildren: childCount(collection.id) > 0,
            expanded: open,
        });
        if (open) visit(collection.id, 1, selfMatch);
    }

    const drafts = leaves(null)
        .filter(({ item }) => !query || leafMatches(item))
        .map(({ item, kind }) => leafRow(item, kind, 0, null));

    return { collections: rows, drafts };
};
