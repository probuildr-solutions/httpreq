/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultWorkspace } from '@httpreq/workspace';
import { closeTabs } from './closeTabs';
import { settleConfirm, useConfirmStore, type ConfirmResult } from './confirm';
import { useWorkbenchStore } from './store';

vi.mock('./kit/notificationStore', () => ({ notifications: { show: vi.fn() } }));
const { notifications } = await import('./kit/notificationStore');

const state = () => useWorkbenchStore.getState();
const openIds = () => state().workspace.openRequestIds;

/** Opens four tabs, the middle two modified, and returns their ids in strip order. */
const fourTabs = () => {
    const first = openIds()[0]!;
    const second = state().createRequest(null);
    const third = state().createRequest(null);
    const fourth = state().createRequest(null);
    state().editRequest(second, { url: 'https://second.example' });
    state().editRequest(third, { url: 'https://third.example' });
    return [first, second, third, fourth] as const;
};

/** Settles the prompt once it is raised, so the close operation can run to completion. */
const answer = (result: ConfirmResult) =>
    new Promise<void>((resolve) => {
        const stop = useConfirmStore.subscribe((current) => {
            if (!current.request) return;
            stop();
            settleConfirm(result);
            resolve();
        });
    });

const prompted = () => !!useConfirmStore.getState().request;

describe('closeTabs', () => {
    const saveRequest = vi.fn<(id: string) => Promise<boolean>>(async () => true);
    const cancelRequest = vi.fn();
    const deps = { saveRequest, cancelRequest };

    beforeEach(() => {
        state().load(createDefaultWorkspace(), {}, []);
        useConfirmStore.setState({ request: null });
        saveRequest.mockClear();
        saveRequest.mockImplementation(async () => true);
        cancelRequest.mockClear();
        vi.mocked(notifications.show).mockClear();
    });

    it('closes saved tabs immediately, without a prompt', async () => {
        const [first] = fourTabs();
        await closeTabs([first], deps);
        expect(prompted()).toBe(false);
        expect(openIds()).toHaveLength(3);
        expect(cancelRequest).toHaveBeenCalledWith(first);
        expect(saveRequest).not.toHaveBeenCalled();
    });

    it('prompts once for a whole set of modified tabs and saves each of them', async () => {
        const [, second, third, fourth] = fourTabs();
        const settled = answer('confirm');
        const closing = closeTabs([second, third, fourth], deps);
        await settled;
        await closing;
        expect(saveRequest.mock.calls).toEqual([[second], [third]]);
        expect(openIds()).toHaveLength(1);
    });

    it('discards the drafts when closing without saving', async () => {
        const [, second, third] = fourTabs();
        const settled = answer('alternate');
        const closing = closeTabs([second, third], deps);
        await settled;
        await closing;
        expect(saveRequest).not.toHaveBeenCalled();
        expect(state().drafts).toEqual({});
        expect(openIds()).toHaveLength(2);
    });

    it('keeps every tab open when the prompt is cancelled', async () => {
        const [first, second, third, fourth] = fourTabs();
        const settled = answer('cancel');
        const closing = closeTabs([first, second, third, fourth], deps);
        await settled;
        await closing;
        expect(openIds()).toEqual([first, second, third, fourth]);
        expect(state().drafts[second]).toBeDefined();
        expect(cancelRequest).not.toHaveBeenCalled();
    });

    it('keeps a tab whose save failed open, closes the rest, and reports it', async () => {
        const [, second, third, fourth] = fourTabs();
        saveRequest.mockImplementation(async (id: string) => id !== third);
        const settled = answer('confirm');
        const closing = closeTabs([second, third, fourth], deps);
        await settled;
        await closing;
        expect(openIds()).toContain(third);
        expect(openIds()).not.toContain(second);
        expect(openIds()).not.toContain(fourth);
        expect(vi.mocked(notifications.show).mock.calls[0]![0]).toMatchObject({
            color: 'red',
            title: 'Save failed',
        });
    });

    it('does not prompt when only saved tabs are affected by a bulk close', async () => {
        const [first, , , fourth] = fourTabs();
        await closeTabs([first, fourth], deps);
        expect(prompted()).toBe(false);
        expect(openIds()).toHaveLength(2);
    });

    it('closes every tab and empties the workspace', async () => {
        fourTabs();
        const settled = answer('alternate');
        const closing = closeTabs(openIds(), deps);
        await settled;
        await closing;
        expect(openIds()).toEqual([]);
        expect(state().activeRequestId).toBeNull();
    });
});
