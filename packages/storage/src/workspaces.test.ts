/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { describe, expect, it } from 'vitest';
import { createEmptyRequest, createSshProfile, createWebSocketRequest } from '@httpreq/shared';
import { createDefaultWorkspace, createWorkspace } from '@httpreq/workspace';
import {
    KeyValueHistoryRepository,
    KeyValueWorkspaceRepository,
    REQUEST_KEY,
    SOCKET_KEY,
} from './repository';
import { migrateLegacyStorage } from './index';
import { MemoryStore, WebStorageStore } from './store';

const repository = () => {
    const store = new MemoryStore();
    return { store, repository: new KeyValueWorkspaceRepository(store) };
};

const memoryStorage = (): Storage => {
    const values = new Map<string, string>();
    return {
        get length() {
            return values.size;
        },
        clear: () => values.clear(),
        getItem: (key) => values.get(key) ?? null,
        key: (index) => [...values.keys()][index] ?? null,
        removeItem: (key) => void values.delete(key),
        setItem: (key, value) => void values.set(key, value),
    };
};

describe('KeyValueWorkspaceRepository', () => {
    it('keeps several workspaces and lists them, newest first', async () => {
        const { repository: store } = repository();
        const older = { ...createWorkspace('Older'), updatedAt: '2026-01-01T00:00:00.000Z' };
        const newer = { ...createWorkspace('Newer'), updatedAt: '2026-06-01T00:00:00.000Z' };
        await store.saveWorkspace(older);
        await store.saveWorkspace(newer);

        expect((await store.listWorkspaces()).map((item) => item.name)).toEqual(['Newer', 'Older']);
        expect(await store.getWorkspace(older.id)).toMatchObject({ name: 'Older' });
    });

    it('isolates each workspace: requests, drafts and history never cross over', async () => {
        const { repository: store } = repository();
        const history = new KeyValueHistoryRepository(new MemoryStore());
        const first = createWorkspace('First');
        const second = createWorkspace('Second');
        const request = { ...createEmptyRequest(null), name: 'Only in first' };
        await store.saveWorkspace({ ...first, requests: [request] });
        await store.saveWorkspace(second);
        await store.saveDrafts(first.id, { [request.id]: { ...request, url: 'https://draft' } });

        const loadedSecond = await store.getWorkspace(second.id);
        expect(loadedSecond?.requests).toEqual([]);
        expect(await store.getDrafts(second.id)).toEqual({});
        expect(Object.keys(await store.getDrafts(first.id))).toEqual([request.id]);
        expect(await history.list(second.id)).toEqual([]);
    });

    it('deleting a workspace removes its drafts, history and index entry', async () => {
        const store = new MemoryStore();
        const workspaces = new KeyValueWorkspaceRepository(store);
        const history = new KeyValueHistoryRepository(store);
        const workspace = createDefaultWorkspace();
        await workspaces.saveWorkspace(workspace);
        await workspaces.saveDrafts(workspace.id, {
            [workspace.requests[0]!.id]: workspace.requests[0]!,
        });
        await history.add(workspace.id, {
            id: 'h1',
            requestId: 'r',
            name: 'A',
            method: 'GET',
            url: '{{base}}',
            status: 200,
            statusText: 'OK',
            durationMs: 1,
            sizeBytes: 1,
            timestamp: new Date().toISOString(),
        });

        await workspaces.deleteWorkspace(workspace.id);

        expect(await workspaces.getWorkspace(workspace.id)).toBeNull();
        expect(await workspaces.getDrafts(workspace.id)).toEqual({});
        expect(await history.list(workspace.id)).toEqual([]);
        expect(await workspaces.listWorkspaces()).toEqual([]);
    });

    it('restores the last active workspace, and forgets it when it is deleted', async () => {
        const { repository: store } = repository();
        const workspace = createWorkspace('Staging');
        await store.saveWorkspace(workspace);
        await store.setActiveWorkspaceId(workspace.id);

        expect(await store.getActiveWorkspaceId()).toBe(workspace.id);
        await store.deleteWorkspace(workspace.id);
        expect(await store.getActiveWorkspaceId()).toBeNull();
    });

    it('rebuilds the index from the stored workspaces when it is missing', async () => {
        const store = new MemoryStore();
        const workspaces = new KeyValueWorkspaceRepository(store);
        const workspace = createWorkspace('Recovered');
        await workspaces.saveWorkspace(workspace);
        await store.delete('workspaces');

        expect((await workspaces.listWorkspaces()).map((item) => item.name)).toEqual(['Recovered']);
    });

    it('never writes an SSH password, because a profile only references the vault', async () => {
        const store = new MemoryStore();
        const workspaces = new KeyValueWorkspaceRepository(store);
        const profile = {
            ...createSshProfile('Bastion'),
            host: 'ssh.example.com',
            username: 'ada',
        };
        const workspace = { ...createWorkspace('Ops'), sshProfiles: [profile] };
        await workspaces.saveWorkspace(workspace);

        const written = (await store.get(`workspace.${workspace.id}`)) as { sshProfiles: object[] };
        const stored = written.sshProfiles[0] as Record<string, unknown>;
        expect(stored).toMatchObject({
            host: 'ssh.example.com',
            credentialId: profile.credentialId,
        });
        // `authType` records *which* secret is needed; the secret itself has no field to live in.
        expect(Object.keys(stored)).not.toContain('password');
        expect(Object.keys(stored)).not.toContain('passphrase');
        expect(Object.keys(stored)).not.toContain('privateKey');
    });

    it('round trips WebSocket requests', async () => {
        const { repository: store } = repository();
        const socket = {
            ...createWebSocketRequest(null),
            name: 'Notifications',
            url: 'wss://example.com/ws',
            subprotocols: ['json'],
        };
        const workspace = { ...createWorkspace('Sockets'), websocketRequests: [socket] };
        await store.saveWorkspace(workspace);

        const loaded = await store.getWorkspace(workspace.id);
        expect(loaded?.websocketRequests).toHaveLength(1);
        expect(loaded?.websocketRequests[0]).toMatchObject({
            name: 'Notifications',
            url: 'wss://example.com/ws',
            subprotocols: ['json'],
        });
    });
});

/** A memory store that records which keys each save wrote and deleted. */
class RecordingStore extends MemoryStore {
    sets: string[] = [];
    deletes: string[] = [];

    override async batch(operations: Parameters<MemoryStore['batch']>[0]) {
        this.sets.push(...(operations.set ?? []).map(([key]) => key));
        this.deletes.push(...(operations.delete ?? []));
        await super.batch(operations);
    }

    reset() {
        this.sets = [];
        this.deletes = [];
    }
}

const requestNamed = (name: string, parentId: string | null = null) => ({
    ...createEmptyRequest(parentId),
    name,
});

describe('incremental workspace writes', () => {
    it('rewrites only the requests that changed, together with the shell', async () => {
        const store = new RecordingStore();
        const workspaces = new KeyValueWorkspaceRepository(store);
        const [a, b, c] = [requestNamed('A'), requestNamed('B'), requestNamed('C')];
        const workspace = { ...createWorkspace('Big'), requests: [a, b, c] };
        await workspaces.saveWorkspace(workspace);
        expect(store.sets).toEqual(
            expect.arrayContaining([
                REQUEST_KEY(workspace.id, a.id),
                REQUEST_KEY(workspace.id, b.id),
                REQUEST_KEY(workspace.id, c.id),
                `workspace.${workspace.id}`,
            ]),
        );

        store.reset();
        const edited = { ...b, url: 'https://example.com/b' };
        await workspaces.saveWorkspace({ ...workspace, requests: [a, edited, c] });
        expect(store.sets).toEqual([REQUEST_KEY(workspace.id, b.id), `workspace.${workspace.id}`]);

        // A structural change that touches no request (tab order, say) writes the shell alone.
        store.reset();
        await workspaces.saveWorkspace({
            ...workspace,
            requests: [a, edited, c],
            openRequestIds: [c.id],
        });
        expect(store.sets).toEqual([`workspace.${workspace.id}`]);

        const loaded = await workspaces.getWorkspace(workspace.id);
        expect(loaded?.requests.map((request) => request.name)).toEqual(['A', 'B', 'C']);
        expect(loaded?.requests[1]?.url).toBe('https://example.com/b');
        expect(loaded?.openRequestIds).toEqual([c.id]);
    });

    it('keeps tree order and removes the records of deleted requests', async () => {
        const store = new RecordingStore();
        const workspaces = new KeyValueWorkspaceRepository(store);
        const [a, b, c] = [requestNamed('A'), requestNamed('B'), requestNamed('C')];
        const workspace = { ...createWorkspace('Tree'), requests: [a, b, c] };
        await workspaces.saveWorkspace(workspace);

        store.reset();
        await workspaces.saveWorkspace({ ...workspace, requests: [c, a] });
        expect(store.deletes).toEqual([REQUEST_KEY(workspace.id, b.id)]);
        expect(await store.get(REQUEST_KEY(workspace.id, b.id))).toBeNull();
        const loaded = await workspaces.getWorkspace(workspace.id);
        expect(loaded?.requests.map((request) => request.name)).toEqual(['C', 'A']);
    });

    it('after a restart, a save writes only what differs from what was loaded', async () => {
        const store = new RecordingStore();
        const [a, b] = [requestNamed('A'), requestNamed('B')];
        const workspace = { ...createWorkspace('Reloaded'), requests: [a, b] };
        await new KeyValueWorkspaceRepository(store).saveWorkspace(workspace);

        const restarted = new KeyValueWorkspaceRepository(store);
        const loaded = (await restarted.getWorkspace(workspace.id))!;
        store.reset();
        await restarted.saveWorkspace({ ...loaded, name: 'Renamed' });
        expect(store.sets).toEqual([`workspace.${workspace.id}`]);
    });

    it('a repository that never loaded the workspace still removes stale records', async () => {
        const store = new RecordingStore();
        const [a, b] = [requestNamed('A'), requestNamed('B')];
        const workspace = { ...createWorkspace('Stale'), requests: [a, b] };
        await new KeyValueWorkspaceRepository(store).saveWorkspace(workspace);

        await new KeyValueWorkspaceRepository(store).saveWorkspace({ ...workspace, requests: [a] });
        expect(await store.get(REQUEST_KEY(workspace.id, b.id))).toBeNull();
    });

    it('reads the single-record layout and converts it on the next save', async () => {
        const store = new MemoryStore();
        const request = requestNamed('Legacy');
        const socket = { ...createWebSocketRequest(null), name: 'Legacy socket' };
        const legacy = {
            ...createWorkspace('Old layout'),
            requests: [request],
            websocketRequests: [socket],
        };
        // How the first releases stored a workspace: one value holding every request.
        await store.set(`workspace.${legacy.id}`, legacy);

        const workspaces = new KeyValueWorkspaceRepository(store);
        const loaded = (await workspaces.getWorkspace(legacy.id))!;
        expect(loaded.requests.map((item) => item.name)).toEqual(['Legacy']);

        await workspaces.saveWorkspace(loaded);
        const shell = (await store.get(`workspace.${legacy.id}`)) as Record<string, unknown>;
        expect(shell.requests).toBeUndefined();
        expect(shell.requestIds).toEqual([request.id]);
        expect(await store.get(REQUEST_KEY(legacy.id, request.id))).toMatchObject({
            name: 'Legacy',
        });
        expect(await store.get(SOCKET_KEY(legacy.id, socket.id))).toMatchObject({
            name: 'Legacy socket',
        });
        expect(
            (await new KeyValueWorkspaceRepository(store).getWorkspace(legacy.id))?.requests,
        ).toEqual(loaded.requests);
    });

    it('deleting a workspace removes its request records', async () => {
        const store = new MemoryStore();
        const workspaces = new KeyValueWorkspaceRepository(store);
        const request = requestNamed('Gone');
        const workspace = { ...createWorkspace('Doomed'), requests: [request] };
        await workspaces.saveWorkspace(workspace);
        await workspaces.deleteWorkspace(workspace.id);
        expect(await store.keys(`request.${workspace.id}.`)).toEqual([]);
    });
});

describe('migrateLegacyStorage', () => {
    it('copies pre-workspace localStorage data and leaves newer data alone', async () => {
        const storage = memoryStorage();
        const legacy = new WebStorageStore(storage, 'httpreq.');
        await legacy.set('workspace.default', { id: 'default', name: 'Old', requests: [] });
        await legacy.set('history.default', []);
        // Unrelated keys under the same prefix must not be dragged along.
        await legacy.set('preferences', { sidebarVisible: false });

        const target = new MemoryStore();
        const copied = await migrateLegacyStorage(target, storage);

        expect(copied).toBe(2);
        expect(await target.keys()).toEqual(
            expect.arrayContaining(['workspace.default', 'history.default']),
        );
        expect(await target.get('preferences')).toBeNull();
    });

    it('never overwrites what the target already has', async () => {
        const storage = memoryStorage();
        await new WebStorageStore(storage, 'httpreq.').set('workspace.default', { name: 'Old' });
        const target = new MemoryStore();
        await target.set('workspace.default', { name: 'Current' });

        expect(await migrateLegacyStorage(target, storage)).toBe(0);
        expect(await target.get('workspace.default')).toEqual({ name: 'Current' });
    });
});
