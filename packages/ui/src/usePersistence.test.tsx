/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import {
    KeyValueHistoryRepository,
    KeyValueWorkspaceRepository,
    MemoryStore,
} from '@httpreq/storage';
import { createDefaultWorkspace, createWorkspace } from '@httpreq/workspace';
import { usePersistence } from './usePersistence';
import { useWorkbenchStore } from './store';

/**
 * The workspace half of persistence: renaming, and the index the switcher is drawn from.
 *
 * The index is a derived cache, so the invariant worth holding is that the workspace actually
 * open is always in it — however the read of the stored index turned out.
 */

const harness = () => {
    const store = new MemoryStore();
    const repository = new KeyValueWorkspaceRepository(store);
    const history = new KeyValueHistoryRepository(store);
    return { store, repository, history };
};

const loaded = async (
    repository: KeyValueWorkspaceRepository,
    history: KeyValueHistoryRepository,
) => {
    const { result } = renderHook(() => usePersistence(repository, history));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    return result;
};

const names = () => useWorkbenchStore.getState().workspaces.map((item) => item.name);

describe('renaming a workspace', () => {
    it('updates the store, the index and the stored workspace', async () => {
        const { repository, history } = harness();
        const result = await loaded(repository, history);
        const id = useWorkbenchStore.getState().workspace.id;

        await act(() => result.current.workspaceActions.rename(id, 'Staging'));

        expect(useWorkbenchStore.getState().workspace.name).toBe('Staging');
        expect(names()).toEqual(['Staging']);
        // Written immediately rather than on the debounce, so a reload cannot show the old name.
        expect((await repository.getWorkspace(id))?.name).toBe('Staging');
    });

    it('trims the name, and ignores one that is only whitespace', async () => {
        const { repository, history } = harness();
        const result = await loaded(repository, history);
        const id = useWorkbenchStore.getState().workspace.id;
        const before = useWorkbenchStore.getState().workspace.name;

        await act(() => result.current.workspaceActions.rename(id, '   '));
        expect(useWorkbenchStore.getState().workspace.name).toBe(before);

        await act(() => result.current.workspaceActions.rename(id, '  Padded  '));
        expect(useWorkbenchStore.getState().workspace.name).toBe('Padded');
        expect(names()).toEqual(['Padded']);
    });

    it('renames a workspace that is not the open one', async () => {
        const { repository, history } = harness();
        const result = await loaded(repository, history);
        const first = useWorkbenchStore.getState().workspace.id;
        await act(() => result.current.workspaceActions.create('Beta'));

        await act(() => result.current.workspaceActions.rename(first, 'Alpha'));

        expect((await repository.getWorkspace(first))?.name).toBe('Alpha');
        expect(names().sort()).toEqual(['Alpha', 'Beta']);
        // The open workspace is untouched by renaming another one.
        expect(useWorkbenchStore.getState().workspace.name).toBe('Beta');
    });

    it('keeps the rename across switching away and back', async () => {
        const { repository, history } = harness();
        const result = await loaded(repository, history);
        const first = useWorkbenchStore.getState().workspace.id;

        await act(() => result.current.workspaceActions.rename(first, 'Alpha'));
        await act(() => result.current.workspaceActions.create('Beta'));
        await act(() => result.current.workspaceActions.switchTo(first));

        expect(useWorkbenchStore.getState().workspace.name).toBe('Alpha');
        expect(useWorkbenchStore.getState().workspace.id).toBe(first);
    });

    it('keeps the open workspace in the switcher even when the index cannot be read', async () => {
        const { repository, history } = harness();
        const result = await loaded(repository, history);
        const id = useWorkbenchStore.getState().workspace.id;
        vi.spyOn(repository, 'listWorkspaces').mockRejectedValue(new Error('storage unavailable'));

        await act(() => result.current.workspaceActions.rename(id, 'Still here'));

        // An unreadable index must not make the switcher look as though the workspace were deleted.
        expect(names()).toEqual(['Still here']);
    });
});

describe('starting up when a workspace cannot be read', () => {
    it('opens the next readable workspace instead of replacing anything', async () => {
        const { repository, history } = harness();
        const good = { ...createDefaultWorkspace(), name: 'Mine' };
        const broken = { ...createWorkspace('Broken'), updatedAt: '2099-01-01T00:00:00.000Z' };
        await repository.saveWorkspace(good);
        await repository.saveWorkspace(broken);
        await repository.setActiveWorkspaceId(broken.id);
        const read = repository.getWorkspace.bind(repository);
        vi.spyOn(repository, 'getWorkspace').mockImplementation((id) =>
            id === broken.id ? Promise.reject(new Error('unreadable')) : read(id),
        );

        await loaded(repository, history);

        expect(useWorkbenchStore.getState().workspace.id).toBe(good.id);
        expect((await read(good.id))?.name).toBe('Mine');
    });

    it('never overwrites the starter workspace id when nothing can be read', async () => {
        const { repository, history } = harness();
        const mine = { ...createDefaultWorkspace(), name: 'Mine' };
        await repository.saveWorkspace(mine);
        const read = repository.getWorkspace.bind(repository);
        vi.spyOn(repository, 'getWorkspace').mockImplementation((id) =>
            id === mine.id ? Promise.reject(new Error('unreadable')) : read(id),
        );

        await loaded(repository, history);

        // A new workspace was opened, under a new id; the unreadable one was left alone.
        expect(useWorkbenchStore.getState().workspace.id).not.toBe(mine.id);
        vi.mocked(repository.getWorkspace).mockRestore();
        expect((await repository.getWorkspace(mine.id))?.name).toBe('Mine');
    });
});
