/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { createTunnelProfile, createWorkspace } from '@httpreq/workspace';
import {
    findWebSocketRequest,
    requestKind,
    tunnelsUsingSshProfile,
    useWorkbenchStore,
} from './store';

const store = () => useWorkbenchStore.getState();

/** Starts every test from an empty workspace, as a fresh switch would. */
beforeEach(() => store().load(createWorkspace('Test'), {}, []));

describe('WebSocket requests in the workbench store', () => {
    it('creates one, files it and opens its tab', () => {
        const collectionId = store().createCollection();
        const id = store().createWebSocketRequest(collectionId);

        const workspace = store().workspace;
        expect(requestKind(workspace, id)).toBe('websocket');
        expect(findWebSocketRequest(workspace, id)?.parentId).toBe(collectionId);
        expect(workspace.openRequestIds).toContain(id);
        expect(store().activeRequestId).toBe(id);
    });

    it('commits an edit straight to the workspace, with no draft to save', () => {
        const id = store().createWebSocketRequest(null);
        store().editWebSocketRequest(id, { url: 'wss://a.dev/s', draftMessage: 'ping' });

        expect(findWebSocketRequest(store().workspace, id)).toMatchObject({
            url: 'wss://a.dev/s',
            draftMessage: 'ping',
        });
        expect(store().drafts[id]).toBeUndefined();
    });

    it('renames through the tree, not through the editor', () => {
        const id = store().createWebSocketRequest(null);
        store().editWebSocketRequest(id, { name: 'Ignored' });
        expect(findWebSocketRequest(store().workspace, id)?.name).toBe('Untitled Socket');

        store().renameNode(id, 'Chat');
        expect(findWebSocketRequest(store().workspace, id)?.name).toBe('Chat');
    });

    it('drops a never-used blank socket when its tab closes', () => {
        const id = store().createWebSocketRequest(null);
        store().closeRequests([id]);
        expect(store().workspace.websocketRequests).toEqual([]);
    });

    it('keeps a socket that was actually used', () => {
        const id = store().createWebSocketRequest(null);
        store().editWebSocketRequest(id, { url: 'wss://a.dev/s' });
        store().closeRequests([id]);

        expect(store().workspace.websocketRequests).toHaveLength(1);
        expect(store().workspace.openRequestIds).not.toContain(id);
    });

    it('shares the tab strip with HTTP requests, in the order they were opened', () => {
        const http = store().createRequest(null);
        const socket = store().createWebSocketRequest(null);
        expect(store().workspace.openRequestIds).toEqual([http, socket]);
    });
});

describe('SSH terminal tabs', () => {
    it('opens a terminal, which takes focus away from the request tabs', () => {
        const http = store().createRequest(null);
        store().openSshSession('x1');

        expect(store().openSshSessionIds).toEqual(['x1']);
        expect(store().activeSshSessionId).toBe('x1');
        expect(store().activeRequestId).toBeNull();
        expect(store().workspace.openRequestIds).toContain(http);
    });

    it('closing the last terminal hands focus back to a request tab', () => {
        const http = store().createRequest(null);
        store().openSshSession('x1');
        store().closeSshSession('x1');

        expect(store().openSshSessionIds).toEqual([]);
        expect(store().activeSshSessionId).toBeNull();
        expect(store().activeRequestId).toBe(http);
    });

    it('closing one of several terminals activates its neighbour', () => {
        for (const id of ['x1', 'x2', 'x3']) store().openSshSession(id);
        store().setActiveSshSession('x2');
        store().closeSshSession('x2');

        expect(store().openSshSessionIds).toEqual(['x1', 'x3']);
        expect(store().activeSshSessionId).toBe('x3');
    });

    it('reorders terminal tabs', () => {
        for (const id of ['x1', 'x2', 'x3']) store().openSshSession(id);
        store().moveSshTab('x3', 0);
        expect(store().openSshSessionIds).toEqual(['x3', 'x1', 'x2']);
    });

    it('forgets every terminal when another workspace is loaded', () => {
        store().openSshSession('x1');
        store().load(createWorkspace('Other'), {}, []);

        expect(store().openSshSessionIds).toEqual([]);
        expect(store().activeSshSessionId).toBeNull();
    });
});

describe('desktop connection profiles', () => {
    it('creates an SSH profile and switches the sidebar to it', () => {
        const id = store().createSshProfile();
        expect(store().workspace.sshProfiles.map((profile) => profile.id)).toEqual([id]);
        expect(store().sidebarView).toBe('ssh');
    });

    it('never lets an edit change the vault key', () => {
        const id = store().createSshProfile();
        const credentialId = store().workspace.sshProfiles[0]!.credentialId;
        store().updateSshProfile(id, {
            name: 'Prod',
            // A stray credentialId in the patch must not be able to repoint the profile at another
            // secret; the type forbids it and the reducer enforces it.
            ...({ credentialId: 'stolen' } as object),
        });

        expect(store().workspace.sshProfiles[0]).toMatchObject({ name: 'Prod', credentialId });
    });

    it('gives a duplicated profile a new identity and no inherited secret', () => {
        const id = store().createSshProfile();
        store().updateSshProfile(id, { name: 'Prod', host: 'a.dev', username: 'ada' });
        const copyId = store().duplicateSshProfile(id)!;

        const [original, copy] = store().workspace.sshProfiles;
        expect(copyId).not.toBe(id);
        expect(copy).toMatchObject({ name: 'Prod (copy)', host: 'a.dev' });
        expect(copy!.credentialId).not.toBe(original!.credentialId);
    });

    it('names the tunnels that depend on an SSH profile', () => {
        const sshId = store().createSshProfile();
        const tunnelId = store().createTunnelProfile(createTunnelProfile(sshId));
        store().updateTunnelProfile(tunnelId, { name: 'MySQL' });

        expect(tunnelsUsingSshProfile(store().workspace, sshId).map((item) => item.name)).toEqual([
            'MySQL',
        ]);
    });

    it('unlinks dependent tunnels instead of deleting them with the profile', () => {
        const sshId = store().createSshProfile();
        const tunnelId = store().createTunnelProfile(createTunnelProfile(sshId));
        store().updateTunnelProfile(tunnelId, { autoStart: true });
        store().deleteSshProfile(sshId);

        expect(store().workspace.sshProfiles).toEqual([]);
        expect(store().workspace.tunnelProfiles[0]).toMatchObject({
            sshProfileId: '',
            autoStart: false,
        });
    });

    it('does not let a duplicated tunnel start on its own, since the local port would clash', () => {
        const sshId = store().createSshProfile();
        const tunnelId = store().createTunnelProfile(createTunnelProfile(sshId));
        store().updateTunnelProfile(tunnelId, { name: 'MySQL', localPort: 3307, autoStart: true });
        store().duplicateTunnelProfile(tunnelId);

        expect(store().workspace.tunnelProfiles.map((item) => item.name)).toEqual([
            'MySQL',
            'MySQL (copy)',
        ]);
        expect(store().workspace.tunnelProfiles[1]!.autoStart).toBe(false);
    });
});

describe('loading another workspace', () => {
    it('replaces every piece of workspace data at once', () => {
        store().createRequest(null);
        store().createWebSocketRequest(null);
        store().createSshProfile();

        const next = createWorkspace('Second');
        store().load(next, {}, []);

        expect(store().workspace.id).toBe(next.id);
        expect(store().workspace.requests).toEqual([]);
        expect(store().workspace.websocketRequests).toEqual([]);
        expect(store().workspace.sshProfiles).toEqual([]);
        expect(store().drafts).toEqual({});
        expect(store().activeRequestId).toBeNull();
    });
});
