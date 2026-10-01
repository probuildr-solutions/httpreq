/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import type {
    HistoryEntry,
    HistoryRepository,
    HttpRequest,
    Workspace,
    WorkspaceMeta,
    WorkspaceRepository,
} from '@httpreq/shared';
import { workspaceMeta } from '@httpreq/shared';
import { migrateWorkspace, normalizeRequest, sortWorkspaces } from '@httpreq/workspace';
import {
    deserializeAuth,
    sanitizeRequest,
    sanitizeWebSocketRequest,
    sanitizeWorkspace,
} from './sanitize';
import type { KeyValueStore } from './store';

/** Maximum number of history entries kept per workspace. */
export const HISTORY_LIMIT = 200;

/** Storage key of a workspace's structural data (collections, folders, environments, profiles). */
export const WORKSPACE_KEY = (id: string) => `workspace.${id}`;
/** Storage key of a workspace's unsaved request edits. */
export const DRAFTS_KEY = (id: string) => `drafts.${id}`;
/** Storage key of a workspace's request history. */
export const HISTORY_KEY = (id: string) => `history.${id}`;
/** One HTTP request of a workspace stored in the split layout. */
export const REQUEST_KEY = (workspaceId: string, id: string) => `request.${workspaceId}.${id}`;
/** One WebSocket request of a workspace stored in the split layout. */
export const SOCKET_KEY = (workspaceId: string, id: string) => `websocket.${workspaceId}.${id}`;
/** Index of every workspace, so the switcher does not have to read them all. */
export const INDEX_KEY = 'workspaces';
/** The workspace to restore on the next start. */
export const ACTIVE_KEY = 'activeWorkspace';

const isMeta = (value: unknown): value is WorkspaceMeta =>
    !!value &&
    typeof value === 'object' &&
    typeof (value as WorkspaceMeta).id === 'string' &&
    typeof (value as WorkspaceMeta).name === 'string';

/**
 * The workspace record in the split layout: everything but the requests, which are stored one per
 * key and listed here in tree order.
 */
interface WorkspaceShell extends Omit<Workspace, 'requests' | 'websocketRequests'> {
    requestIds: string[];
    websocketRequestIds: string[];
}

const isShell = (value: unknown): value is WorkspaceShell =>
    !!value &&
    typeof value === 'object' &&
    Array.isArray((value as WorkspaceShell).requestIds) &&
    Array.isArray((value as WorkspaceShell).websocketRequestIds);

/**
 * Every workspace in one key/value store, on both platforms.
 *
 * A workspace is stored split: a small shell (tree containers, environments, profiles, open tabs)
 * plus one record per request. Saving compares each request with the object last written and
 * rewrites only those that changed, in one transaction with the shell. Writing the whole workspace
 * as one value, as the first releases did, meant serializing every request and body in it on the
 * UI thread for every structural change — for a large workspace, over 100 ms per tab opened. That
 * layout is still read, and converted by the next save.
 *
 * Isolation is by key: a workspace's tree, drafts and history live under keys derived from its
 * id, and nothing reads across them. The index is a derived cache — if it ever disagrees with the
 * stored workspaces, {@link listWorkspaces} rebuilds it from the keys that actually exist.
 */
export class KeyValueWorkspaceRepository implements WorkspaceRepository {
    /**
     * Per workspace, the request objects known to be on disk as they are, by storage key. The store
     * updates immutably, so an unchanged request is the very same object on the next save.
     */
    private readonly written = new Map<string, Map<string, unknown>>();

    constructor(private readonly store: KeyValueStore) {}

    async listWorkspaces(): Promise<WorkspaceMeta[]> {
        const stored = await this.store.get(INDEX_KEY);
        const index = Array.isArray(stored) ? stored.filter(isMeta) : [];
        const keys = await this.store.keys('workspace.');
        const ids = new Set(keys.map((key) => key.slice('workspace.'.length)));
        const live = index.filter((meta) => ids.has(meta.id));
        // Workspaces written by another tab (or recovered from a backup) are picked up here.
        const missing = [...ids].filter((id) => !live.some((meta) => meta.id === id));
        for (const id of missing) {
            const workspace = await this.getWorkspace(id);
            if (workspace) live.push(workspaceMeta(workspace));
        }
        if (missing.length || live.length !== index.length) await this.writeIndex(live);
        return sortWorkspaces(live);
    }

    private async writeIndex(items: WorkspaceMeta[]): Promise<void> {
        await this.store.set(INDEX_KEY, sortWorkspaces(items));
    }

    private async updateIndex(meta: WorkspaceMeta): Promise<void> {
        const stored = await this.store.get(INDEX_KEY);
        const index = (Array.isArray(stored) ? stored.filter(isMeta) : []).filter(
            (item) => item.id !== meta.id,
        );
        await this.writeIndex([...index, meta]);
    }

    async getWorkspace(id: string): Promise<Workspace | null> {
        const stored = await this.store.get(WORKSPACE_KEY(id));
        if (!isShell(stored)) {
            // The single-record layout. Nothing is known to be on disk in the split layout yet, so the
            // next save writes every request.
            this.written.delete(id);
            return migrateWorkspace(stored, deserializeAuth);
        }
        const { requestIds, websocketRequestIds, ...shell } = stored;
        const records = new Map([
            ...(await this.store.entries(`request.${id}.`)),
            ...(await this.store.entries(`websocket.${id}.`)),
        ]);
        // A record that is missing (e.g. removed by hand) is skipped rather than failing the load.
        const read = (keys: string[]) =>
            keys
                .map((key) => records.get(key))
                .filter((item) => !!item && typeof item === 'object');
        const workspace = migrateWorkspace(
            {
                ...shell,
                requests: read(requestIds.map((requestId) => REQUEST_KEY(id, requestId))),
                websocketRequests: read(
                    websocketRequestIds.map((socketId) => SOCKET_KEY(id, socketId)),
                ),
            },
            deserializeAuth,
        );
        if (workspace) {
            // What was just read is what is on disk, so the next save writes only what changes from
            // here. Records the shell no longer lists (left by an interrupted write) are known too, as
            // absent, so that save also deletes them.
            const known = new Map<string, unknown>(
                [...records.keys()].map((key) => [key, undefined]),
            );
            for (const request of workspace.requests)
                known.set(REQUEST_KEY(id, request.id), request);
            for (const socket of workspace.websocketRequests)
                known.set(SOCKET_KEY(id, socket.id), socket);
            this.written.set(id, known);
        }
        return workspace;
    }

    async saveWorkspace(workspace: Workspace): Promise<void> {
        const { id } = workspace;
        const known = this.written.get(id);
        const next = new Map<string, unknown>();
        const writes: [string, unknown][] = [];
        for (const request of workspace.requests) {
            const key = REQUEST_KEY(id, request.id);
            next.set(key, request);
            if (known?.get(key) !== request) writes.push([key, sanitizeRequest(request)]);
        }
        for (const socket of workspace.websocketRequests) {
            const key = SOCKET_KEY(id, socket.id);
            next.set(key, socket);
            if (known?.get(key) !== socket) writes.push([key, sanitizeWebSocketRequest(socket)]);
        }
        // Without a record of what is on disk, look: stale records must not outlive their requests.
        const existing = known
            ? [...known.keys()]
            : [
                  ...(await this.store.keys(`request.${id}.`)),
                  ...(await this.store.keys(`websocket.${id}.`)),
              ];
        const deletes = existing.filter((key) => !next.has(key));

        const shell: WorkspaceShell = {
            ...sanitizeWorkspace({ ...workspace, requests: [], websocketRequests: [] }),
            requestIds: workspace.requests.map((request) => request.id),
            websocketRequestIds: workspace.websocketRequests.map((socket) => socket.id),
        };
        delete (shell as Partial<Workspace>).requests;
        delete (shell as Partial<Workspace>).websocketRequests;
        // Requests and shell in one transaction: the shell never lists a request that is not there.
        await this.store.batch({ set: [...writes, [WORKSPACE_KEY(id), shell]], delete: deletes });
        this.written.set(id, next);
        await this.updateIndex(workspaceMeta(workspace));
    }

    async deleteWorkspace(id: string): Promise<void> {
        const records = [
            ...(await this.store.keys(`request.${id}.`)),
            ...(await this.store.keys(`websocket.${id}.`)),
        ];
        await this.store.batch({
            delete: [WORKSPACE_KEY(id), DRAFTS_KEY(id), HISTORY_KEY(id), ...records],
        });
        this.written.delete(id);
        const stored = await this.store.get(INDEX_KEY);
        const index = Array.isArray(stored) ? stored.filter(isMeta) : [];
        await this.writeIndex(index.filter((item) => item.id !== id));
        if ((await this.getActiveWorkspaceId()) === id) await this.store.delete(ACTIVE_KEY);
    }

    async getActiveWorkspaceId(): Promise<string | null> {
        const value = await this.store.get(ACTIVE_KEY);
        return typeof value === 'string' && value ? value : null;
    }

    async setActiveWorkspaceId(id: string): Promise<void> {
        await this.store.set(ACTIVE_KEY, id);
    }

    async getDrafts(workspaceId: string): Promise<Record<string, HttpRequest>> {
        const value = await this.store.get(DRAFTS_KEY(workspaceId));
        if (!value || typeof value !== 'object') return {};
        const drafts: Record<string, HttpRequest> = {};
        for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
            if (!raw || typeof raw !== 'object') continue;
            const parentId = (raw as { parentId?: unknown }).parentId;
            drafts[id] = normalizeRequest(
                { ...(raw as Record<string, unknown>), id },
                typeof parentId === 'string' ? parentId : null,
                deserializeAuth,
            );
        }
        return drafts;
    }

    async saveDrafts(workspaceId: string, drafts: Record<string, HttpRequest>): Promise<void> {
        const key = DRAFTS_KEY(workspaceId);
        if (Object.keys(drafts).length === 0) {
            await this.store.delete(key);
            return;
        }
        await this.store.set(
            key,
            Object.fromEntries(
                Object.entries(drafts).map(([id, draft]) => [id, sanitizeRequest(draft)]),
            ),
        );
    }
}

const isHistoryEntry = (value: unknown): value is HistoryEntry =>
    !!value &&
    typeof value === 'object' &&
    typeof (value as HistoryEntry).id === 'string' &&
    typeof (value as HistoryEntry).requestId === 'string' &&
    typeof (value as HistoryEntry).timestamp === 'string';

/** Request history, newest first, per workspace. Only unresolved URLs are recorded. */
export class KeyValueHistoryRepository implements HistoryRepository {
    constructor(
        private readonly store: KeyValueStore,
        private readonly limit = HISTORY_LIMIT,
    ) {}

    async list(workspaceId: string): Promise<HistoryEntry[]> {
        const value = await this.store.get(HISTORY_KEY(workspaceId));
        return Array.isArray(value) ? value.filter(isHistoryEntry) : [];
    }

    async add(workspaceId: string, entry: HistoryEntry): Promise<HistoryEntry[]> {
        const entries = [entry, ...(await this.list(workspaceId))].slice(0, this.limit);
        await this.store.set(HISTORY_KEY(workspaceId), entries);
        return entries;
    }

    async remove(workspaceId: string, entryIds: string[]): Promise<HistoryEntry[]> {
        const doomed = new Set(entryIds);
        const entries = (await this.list(workspaceId)).filter((entry) => !doomed.has(entry.id));
        await this.store.set(HISTORY_KEY(workspaceId), entries);
        return entries;
    }

    async clear(workspaceId: string): Promise<void> {
        await this.store.delete(HISTORY_KEY(workspaceId));
    }
}
