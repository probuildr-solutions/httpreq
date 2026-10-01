/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { createDefaultWorkspace } from '@httpreq/workspace';
import { editableRequest, useWorkbenchStore } from './store';

const state = () => useWorkbenchStore.getState();
const openIds = () => state().workspace.openRequestIds;

describe('workbench store', () => {
    beforeEach(() => {
        state().load(createDefaultWorkspace(), {}, []);
    });

    it('opens new requests next to the active tab and cycles with wrap-around', () => {
        const [first] = openIds();
        const second = state().createRequest(null);
        const third = state().createRequest(null);
        expect(openIds()).toEqual([first, second, third]);
        expect(state().activeRequestId).toBe(third);
        state().cycleRequest(1);
        expect(state().activeRequestId).toBe(first);
        state().cycleRequest(-1);
        expect(state().activeRequestId).toBe(third);
    });

    it('reorders tabs without changing the active one', () => {
        const [first] = openIds();
        const second = state().createRequest(null);
        state().moveTab(second, 0);
        expect(openIds()).toEqual([second, first]);
        expect(state().activeRequestId).toBe(second);
    });

    it('keeps edits in a draft until they match the saved request again', () => {
        const [id] = openIds();
        const saved = state().workspace.requests[0]!;
        state().editRequest(id!, { url: 'https://changed.example' });
        expect(state().drafts[id!]).toBeDefined();
        expect(state().workspace.requests[0]).toBe(saved);
        expect(editableRequest(state(), id!)!.url).toBe('https://changed.example');
        state().editRequest(id!, { url: saved.url });
        expect(state().drafts[id!]).toBeUndefined();
    });

    it('renames the saved request and its draft together', () => {
        const [id] = openIds();
        state().editRequest(id!, { url: 'https://draft.example' });
        state().renameNode(id!, 'adminLogin');
        expect(state().workspace.requests[0]!.name).toBe('adminLogin');
        expect(state().drafts[id!]!.name).toBe('adminLogin');
    });

    it('commits a saved draft and clears the modified state', () => {
        const [id] = openIds();
        state().editRequest(id!, { method: 'POST' });
        const draft = state().drafts[id!]!;
        const base = state().workspace;
        const written = {
            ...base,
            requests: base.requests.map((request) => (request.id === id ? draft : request)),
        };
        state().setSaveStatus(id!, 'saving');
        state().commitSaved(draft, draft, written, base);
        expect(state().workspace).toBe(written);
        expect(state().drafts[id!]).toBeUndefined();
        expect(state().saveStatus[id!]).toBeUndefined();
    });

    it('closes tabs without deleting saved requests, but drops pristine scratch requests', () => {
        const [saved] = openIds();
        const scratch = state().createRequest(null);
        state().closeRequest(scratch);
        expect(state().workspace.requests.some((request) => request.id === scratch)).toBe(false);
        state().closeRequest(saved!);
        expect(openIds()).toEqual([]);
        expect(state().activeRequestId).toBeNull();
        expect(state().workspace.requests.some((request) => request.id === saved)).toBe(true);
    });

    it('closes several tabs at once and hands the active tab to the nearest survivor', () => {
        const [first] = openIds();
        const second = state().createRequest(null);
        const third = state().createRequest(null);
        const fourth = state().createRequest(null);
        state().editRequest(second, { url: 'https://second.example' });
        state().setActiveRequest(third);

        // An inactive tab closing leaves the active one alone.
        state().closeRequests([fourth]);
        expect(openIds()).toEqual([first, second, third]);
        expect(state().activeRequestId).toBe(third);

        // Closing the active tab and its left neighbour falls back past both, and drops the draft.
        state().closeRequests([second, third]);
        expect(openIds()).toEqual([first]);
        expect(state().activeRequestId).toBe(first);
        expect(state().drafts[second]).toBeUndefined();
    });

    it('falls back to the right when the active tab and everything left of it close', () => {
        const [first] = openIds();
        const second = state().createRequest(null);
        const third = state().createRequest(null);
        state().setActiveRequest(second);
        state().closeRequests([first!, second]);
        expect(openIds()).toEqual([third]);
        expect(state().activeRequestId).toBe(third);
    });

    it('closing every tab empties the workspace', () => {
        state().createRequest(null);
        state().closeRequests(openIds());
        expect(openIds()).toEqual([]);
        expect(state().activeRequestId).toBeNull();
    });

    it('ignores ids that are not open and de-duplicates the rest', () => {
        const [first] = openIds();
        const second = state().createRequest(null);
        state().closeRequests([second, second, 'missing']);
        expect(openIds()).toEqual([first]);
    });

    it('deleting a collection closes its tabs and drafts', () => {
        const collectionId = state().workspace.collections[0]!.id;
        const [id] = openIds();
        state().editRequest(id!, { url: 'x' });
        state().deleteNode(collectionId);
        expect(openIds()).toEqual([]);
        expect(state().drafts).toEqual({});
        expect(state().activeRequestId).toBeNull();
    });

    it('files a draft request with Save as, keeping its tab and edits', () => {
        const collection = state().createCollection();
        const folder = state().createFolder(collection);
        const id = state().createRequest(null);
        state().editRequest(id, { url: 'https://draft.example' });
        expect(state().saveRequestAs(id, folder, 'Get users')).toBe(id);
        const saved = state().workspace.requests.find((request) => request.id === id)!;
        expect(saved).toMatchObject({ name: 'Get users', parentId: folder });
        // The edits are still a draft, for the caller to commit.
        expect(state().drafts[id]).toMatchObject({
            url: 'https://draft.example',
            parentId: folder,
        });
        expect(state().expandedIds.has(collection)).toBe(true);
        expect(state().expandedIds.has(folder)).toBe(true);
    });

    it('saves a copy with Save as and hands it the original tab', () => {
        const collection = state().createCollection();
        const other = state().createCollection();
        const id = state().createRequest(collection);
        state().editRequest(id, { method: 'POST' });
        const copy = state().saveRequestAs(id, other, 'Create user')!;
        expect(copy).not.toBe(id);
        expect(openIds()).toContain(copy);
        expect(openIds()).not.toContain(id);
        expect(state().activeRequestId).toBe(copy);
        expect(state().drafts[id]).toBeUndefined();
        expect(state().workspace.requests.find((request) => request.id === id)!.method).toBe('GET');
        expect(state().workspace.requests.find((request) => request.id === copy)).toMatchObject({
            name: 'Create user',
            parentId: other,
            method: 'POST',
        });
    });

    it('saves a draft WebSocket request into a collection', () => {
        const collection = state().createCollection();
        const id = state().createWebSocketRequest(null);
        state().editWebSocketRequest(id, { url: 'wss://echo.example' });
        expect(state().saveRequestAs(id, collection, 'Echo')).toBe(id);
        expect(state().workspace.websocketRequests.find((item) => item.id === id)).toMatchObject({
            name: 'Echo',
            parentId: collection,
            url: 'wss://echo.example',
        });
    });

    it('refuses to Save as into something that is not a collection or folder', () => {
        const id = state().createRequest(null);
        const other = state().createRequest(null);
        expect(state().saveRequestAs(id, other, 'x')).toBeNull();
        expect(state().saveRequestAs(id, 'missing', 'x')).toBeNull();
    });

    it('reveals a node by expanding its ancestors', () => {
        const collectionId = state().workspace.collections[0]!.id;
        const folderId = state().createFolder(collectionId);
        const requestId = state().createRequest(folderId);
        useWorkbenchStore.setState({ expandedIds: new Set() });
        state().revealNode(requestId);
        expect([...state().expandedIds].sort()).toEqual([collectionId, folderId].sort());
        expect(state().selectedNodeId).toBe(requestId);
    });

    it('stores retrieved tokens in the active environment as secrets', () => {
        const environmentId = state().workspace.environments[0]!.id;
        const collectionId = state().workspace.collections[0]!.id;
        state().linkEnvironment(collectionId, environmentId);
        state().selectNode(collectionId);
        expect(state().setEnvironmentVariable('accessToken', 'tok', true)).toBe(true);
        const variable = state().workspace.environments[0]!.variables.find(
            (item) => item.key === 'accessToken',
        );
        expect(variable).toMatchObject({ value: 'tok', secret: true, enabled: true });
        state().linkEnvironment(collectionId, null);
        expect(state().setEnvironmentVariable('accessToken', 'x', true)).toBe(false);
    });

    describe('environment links', () => {
        const setup = () => {
            const [staging, production] = [
                state().createEnvironment(),
                state().createEnvironment(),
            ];
            const collectionId = state().workspace.collections[0]!.id;
            const linked = state().createRequest(collectionId);
            const inherited = state().createRequest(collectionId);
            const loose = state().createRequest(null);
            return { staging, production, collectionId, linked, inherited, loose };
        };

        it('does not link or select a new environment by itself', () => {
            const created = state().createEnvironment();
            expect(state().workspace.activeEnvironmentId).not.toBe(created);
            expect(
                state().workspace.collections.some((item) => item.environmentId === created),
            ).toBe(false);
        });

        it('uses the environment linked to the collection for everything inside it', () => {
            const { staging, collectionId, linked, inherited, loose } = setup();
            const folderId = state().createFolder(collectionId);
            const nested = state().createFolder(folderId);
            const deep = state().createRequest(nested);
            state().linkEnvironment(collectionId, staging);

            state().selectNode(collectionId);
            expect(state().workspace.activeEnvironmentId).toBe(staging);
            for (const id of [linked, inherited, deep]) {
                state().setActiveRequest(id);
                expect(state().workspace.activeEnvironmentId).toBe(staging);
            }
            state().selectNode(nested);
            expect(state().workspace.activeEnvironmentId).toBe(staging);
            // Outside any collection: back to "No environment", not the previously selected one.
            state().setActiveRequest(loose);
            expect(state().workspace.activeEnvironmentId).toBeNull();
        });

        it('links through a request or folder to its collection, and ignores loose requests', () => {
            const { staging, production, collectionId, linked, loose } = setup();
            state().linkEnvironment(linked, staging);
            expect(
                state().workspace.collections.find((item) => item.id === collectionId),
            ).toMatchObject({
                environmentId: staging,
            });
            expect(
                state().workspace.requests.find((item) => item.id === linked)?.environmentId,
            ).toBeUndefined();
            state().linkEnvironment(loose, production);
            expect(state().workspace.collections[0]!.environmentId).toBe(staging);
        });

        it('keeps an edit from changing the link, and unlinks deleted environments', () => {
            const { staging, collectionId, linked } = setup();
            state().linkEnvironment(collectionId, staging);
            state().setActiveRequest(linked);
            state().editRequest(linked, { url: 'https://example.test' });
            expect(state().workspace.activeEnvironmentId).toBe(staging);
            state().deleteEnvironment(staging);
            expect(state().workspace.collections[0]!.environmentId).toBe(undefined);
            expect(state().workspace.activeEnvironmentId).toBeNull();
        });
    });

    describe('environment tabs', () => {
        it('opens beside the request tabs and hands the active tab back and forth', () => {
            const [request] = openIds();
            const staging = state().createEnvironment();
            state().openEnvironmentTab(staging);
            expect(state().openEnvironmentTabIds).toEqual([staging]);
            expect(state().activeEnvironmentTabId).toBe(staging);
            expect(state().activeRequestId).toBeNull();

            state().setActiveRequest(request!);
            expect(state().activeEnvironmentTabId).toBeNull();
            expect(state().openEnvironmentTabIds).toEqual([staging]);

            state().setActiveEnvironmentTab(staging);
            expect(state().activeRequestId).toBeNull();
        });

        it('closes to a neighbouring environment tab, then back to a request', () => {
            const [request] = openIds();
            const one = state().createEnvironment();
            const two = state().createEnvironment();
            state().openEnvironmentTab(one);
            state().openEnvironmentTab(two);

            state().closeEnvironmentTabs([two]);
            expect(state().activeEnvironmentTabId).toBe(one);
            state().closeEnvironmentTabs([one]);
            expect(state().activeEnvironmentTabId).toBeNull();
            expect(state().activeRequestId).toBe(request);
        });

        it('closes the tab of a deleted environment', () => {
            const staging = state().createEnvironment();
            state().openEnvironmentTab(staging);
            state().deleteEnvironment(staging);
            expect(state().openEnvironmentTabIds).toEqual([]);
            expect(state().activeEnvironmentTabId).toBeNull();
        });

        it('moves to an environment tab when the last request tab closes', () => {
            const [request] = openIds();
            const staging = state().createEnvironment();
            state().openEnvironmentTab(staging);
            state().setActiveRequest(request!);
            state().closeRequests([request!]);
            expect(state().activeEnvironmentTabId).toBe(staging);
        });
    });
});
