/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import type { HistoryRepository, WorkspaceRepository } from '@httpreq/shared';
import { KeyValueHistoryRepository, KeyValueWorkspaceRepository } from './repository';
import { createBrowserStore, WebStorageStore, type KeyValueStore } from './store';

export * from './repository';
export * from './sanitize';
export * from './store';

/**
 * Key prefix used by the pre-workspace releases, which wrote straight to `localStorage` as
 * `httpreq.workspace.<id>`, `httpreq.drafts.<id>` and `httpreq.history.<id>`.
 */
export const LEGACY_PREFIX = 'httpreq.';

/** Keys the legacy layout owned. Preferences live under their own key and are left alone. */
const LEGACY_PATTERN = /^(workspace|drafts|history)\./;

/**
 * Copies pre-workspace `localStorage` data into `target` the first time the app runs on the new
 * storage. Only keys that the target does not already have are copied, so a partial or repeated
 * migration can never overwrite newer data, and the legacy keys are left in place as a backup.
 *
 * Returns the number of keys copied.
 */
export const migrateLegacyStorage = async (
    target: KeyValueStore,
    storage: Storage | undefined = globalThis.localStorage,
): Promise<number> => {
    if (!storage) return 0;
    let legacy: WebStorageStore;
    let keys: string[];
    try {
        legacy = new WebStorageStore(storage, LEGACY_PREFIX);
        keys = (await legacy.keys()).filter((key) => LEGACY_PATTERN.test(key));
    } catch {
        return 0;
    }
    if (!keys.length) return 0;
    const existing = new Set(await target.keys());
    let copied = 0;
    for (const key of keys) {
        if (existing.has(key)) continue;
        const value = await legacy.get(key);
        if (value === null) continue;
        await target.set(key, value);
        copied += 1;
    }
    return copied;
};

/**
 * The browser's storage stack: IndexedDB when available, with pre-workspace `localStorage` data
 * carried over on first run. Falls back to `localStorage` and then to memory, so the app always
 * starts even when site data is blocked.
 */
export const createBrowserStorage = async (): Promise<{
    store: KeyValueStore;
    repository: WorkspaceRepository;
    history: HistoryRepository;
}> => {
    const store = await createBrowserStore();
    // A failed migration must not stop the app: the worst case is an empty first workspace.
    await migrateLegacyStorage(store).catch(() => 0);
    return {
        store,
        repository: new KeyValueWorkspaceRepository(store),
        history: new KeyValueHistoryRepository(store),
    };
};

/**
 * `localStorage`-backed repositories, reading and writing the same keys as before workspaces
 * existed. Kept for tests and for runtimes without IndexedDB.
 */
export class LocalWorkspaceRepository extends KeyValueWorkspaceRepository {
    constructor(storage: Storage = localStorage) {
        super(new WebStorageStore(storage, LEGACY_PREFIX));
    }
}

export class LocalHistoryRepository extends KeyValueHistoryRepository {
    constructor(storage: Storage = localStorage, limit?: number) {
        super(new WebStorageStore(storage, LEGACY_PREFIX), limit);
    }
}
