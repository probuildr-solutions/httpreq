/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { describe, expect, it } from 'vitest';
import {
    createCollection,
    createEmptyRequest,
    createEnvironment,
    createSshProfile,
    createTunnelProfile,
    createWebSocketRequest,
    type Workspace,
} from '@httpreq/shared';
import {
    childWebSockets,
    createWorkspace,
    deleteNode,
    describeActiveResources,
    duplicateNode,
    duplicateWorkspace,
    findNode,
    migrateWorkspace,
    moveNode,
    uniqueWorkspaceName,
} from './index';

/** A workspace with one of everything, linked together. */
const populated = (): Workspace => {
    const collection = createCollection('API');
    const request = { ...createEmptyRequest(collection.id), name: 'Get users' };
    const socket = {
        ...createWebSocketRequest(collection.id),
        name: 'Notifications',
        url: 'wss://example.com/ws',
    };
    const environment = createEnvironment('Dev');
    const ssh = { ...createSshProfile('Bastion'), host: 'ssh.example.com', username: 'ada' };
    const tunnel = { ...createTunnelProfile(ssh.id, 'MySQL'), localPort: 3307, autoStart: true };
    return {
        ...createWorkspace('Source'),
        collections: [collection],
        requests: [request],
        websocketRequests: [socket],
        environments: [environment],
        activeEnvironmentId: environment.id,
        sshProfiles: [ssh],
        tunnelProfiles: [tunnel],
        openRequestIds: [request.id, socket.id],
    };
};

describe('duplicateWorkspace', () => {
    it('rewrites every id, so the copy shares nothing with the original', () => {
        const source = populated();
        const copy = duplicateWorkspace(source);

        const sourceIds = new Set([
            source.id,
            ...source.collections.map((item) => item.id),
            ...source.requests.map((item) => item.id),
            ...source.websocketRequests.map((item) => item.id),
            ...source.environments.map((item) => item.id),
            ...source.sshProfiles.map((item) => item.id),
            ...source.tunnelProfiles.map((item) => item.id),
        ]);
        const copyIds = [
            copy.id,
            ...copy.collections.map((item) => item.id),
            ...copy.requests.map((item) => item.id),
            ...copy.websocketRequests.map((item) => item.id),
            ...copy.environments.map((item) => item.id),
            ...copy.sshProfiles.map((item) => item.id),
            ...copy.tunnelProfiles.map((item) => item.id),
        ];
        expect(copyIds.filter((id) => sourceIds.has(id))).toEqual([]);
    });

    it('keeps every internal reference pointing inside the copy', () => {
        const copy = duplicateWorkspace(populated());
        const collectionId = copy.collections[0]!.id;

        expect(copy.requests[0]!.parentId).toBe(collectionId);
        expect(copy.websocketRequests[0]!.parentId).toBe(collectionId);
        expect(copy.activeEnvironmentId).toBe(copy.environments[0]!.id);
        expect(copy.tunnelProfiles[0]!.sshProfileId).toBe(copy.sshProfiles[0]!.id);
        expect(copy.openRequestIds).toEqual([copy.requests[0]!.id, copy.websocketRequests[0]!.id]);
    });

    it('gives copied SSH profiles a fresh credential id, so no secret is inherited', () => {
        const source = populated();
        const copy = duplicateWorkspace(source);
        expect(copy.sshProfiles[0]!.credentialId).not.toBe(source.sshProfiles[0]!.credentialId);
    });

    it('does not let a copied tunnel start by itself', () => {
        expect(duplicateWorkspace(populated()).tunnelProfiles[0]!.autoStart).toBe(false);
    });

    it('leaves the source untouched', () => {
        const source = populated();
        const snapshot = structuredClone(source);
        duplicateWorkspace(source);
        expect(source).toEqual(snapshot);
    });
});

describe('uniqueWorkspaceName', () => {
    it('appends a counter only when the name is taken', () => {
        const existing = [
            { id: '1', name: 'Staging', updatedAt: '' },
            { id: '2', name: 'Staging (2)', updatedAt: '' },
        ];
        expect(uniqueWorkspaceName(existing, 'Production')).toBe('Production');
        expect(uniqueWorkspaceName(existing, 'Staging')).toBe('Staging (3)');
        expect(uniqueWorkspaceName(existing, 'staging')).toBe('staging (3)');
    });
});

describe('describeActiveResources', () => {
    it('reads as a sentence, whatever the mix', () => {
        expect(describeActiveResources({ webSockets: 1, sshSessions: 0, tunnels: 0 })).toBe(
            '1 WebSocket connection',
        );
        expect(describeActiveResources({ webSockets: 2, sshSessions: 1, tunnels: 3 })).toBe(
            '2 WebSocket connections, 1 SSH session and 3 active tunnels',
        );
        expect(describeActiveResources({ webSockets: 0, sshSessions: 0, tunnels: 0 })).toBe('');
    });
});

describe('the tree with WebSocket requests', () => {
    it('finds a socket as a leaf node of its collection', () => {
        const workspace = populated();
        const socket = workspace.websocketRequests[0]!;
        expect(findNode(workspace, socket.id)).toEqual({ kind: 'websocket', node: socket });
        expect(childWebSockets(workspace, workspace.collections[0]!.id)).toHaveLength(1);
    });

    it('moves a socket between containers like any other request', () => {
        const workspace = populated();
        const socket = workspace.websocketRequests[0]!;
        const moved = moveNode(workspace, socket.id, null);
        expect(moved.websocketRequests[0]!.parentId).toBeNull();
    });

    it('duplicates a socket next to the original, with new ids', () => {
        const workspace = populated();
        const socket = workspace.websocketRequests[0]!;
        const { workspace: next, id } = duplicateNode(workspace, socket.id);
        expect(id).not.toBe(socket.id);
        expect(next.websocketRequests.map((item) => item.name)).toEqual([
            'Notifications',
            'Notifications (copy)',
        ]);
    });

    it('deleting a collection removes its sockets and closes their tabs', () => {
        const workspace = populated();
        const socket = workspace.websocketRequests[0]!;
        const { workspace: next, removedRequestIds } = deleteNode(
            workspace,
            workspace.collections[0]!.id,
        );

        expect(next.websocketRequests).toEqual([]);
        expect(next.openRequestIds).toEqual([]);
        expect(removedRequestIds.has(socket.id)).toBe(true);
    });
});

describe('migrateWorkspace to version 3', () => {
    it('adds the new collections to a version 2 workspace without losing anything', () => {
        const migrated = migrateWorkspace({
            version: 2,
            id: 'w1',
            name: 'Old',
            collections: [{ id: 'c1', name: 'API' }],
            folders: [],
            requests: [
                { id: 'r1', name: 'Get', method: 'GET', url: 'https://a.dev', parentId: 'c1' },
            ],
            environments: [],
            openRequestIds: ['r1'],
        })!;

        expect(migrated.version).toBe(3);
        expect(migrated.requests).toHaveLength(1);
        expect(migrated.websocketRequests).toEqual([]);
        expect(migrated.sshProfiles).toEqual([]);
        expect(migrated.tunnelProfiles).toEqual([]);
    });

    it('unlinks a tunnel whose SSH profile is missing, rather than dropping the tunnel', () => {
        const migrated = migrateWorkspace({
            version: 3,
            id: 'w1',
            name: 'Ops',
            collections: [],
            folders: [],
            requests: [],
            websocketRequests: [],
            environments: [],
            sshProfiles: [],
            tunnelProfiles: [
                {
                    id: 't1',
                    name: 'MySQL',
                    sshProfileId: 'gone',
                    localPort: 3307,
                    remoteHost: 'db',
                    remotePort: 3306,
                },
            ],
            openRequestIds: [],
        })!;

        expect(migrated.tunnelProfiles).toHaveLength(1);
        expect(migrated.tunnelProfiles[0]!.sshProfileId).toBe('');
    });

    it('defaults a missing or unparseable bind address to loopback, never to a public one', () => {
        const migrated = migrateWorkspace({
            version: 3,
            id: 'w1',
            name: 'Ops',
            collections: [],
            folders: [],
            requests: [],
            websocketRequests: [],
            environments: [],
            sshProfiles: [],
            tunnelProfiles: [{ id: 't1', name: 'T', localBindAddress: '   ' }],
            openRequestIds: [],
        })!;

        expect(migrated.tunnelProfiles[0]!.localBindAddress).toBe('127.0.0.1');
    });

    it('keeps a socket whose parent container is gone as an unfiled draft', () => {
        const migrated = migrateWorkspace({
            version: 3,
            id: 'w1',
            name: 'W',
            collections: [],
            folders: [],
            requests: [],
            websocketRequests: [
                { id: 's1', name: 'Chat', url: 'wss://a.dev', parentId: 'missing' },
            ],
            environments: [],
            sshProfiles: [],
            tunnelProfiles: [],
            openRequestIds: ['s1'],
        })!;

        expect(migrated.websocketRequests[0]!.parentId).toBeNull();
        expect(migrated.openRequestIds).toEqual(['s1']);
    });
});
